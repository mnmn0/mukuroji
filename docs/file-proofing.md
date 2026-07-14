# File / Version / Proofing / Approval

## 目的

成果物を Work Item、保存済み comment、Team scoped project に添付し、同じ画面で版管理、位置付きレビュー、承認まで完結させる。file body は API/Lambda を経由せず private S3 bucket へ直接転送し、metadata と業務履歴だけを DynamoDB と audit event に保存する。

## Security boundary

- upload/download URL は認証済み API だけが発行し、既定で upload 600 秒、download 300 秒で失効する。
- bucket は public access を全面拒否し、TLS、SSE-S3、versioning を必須にする。
- object key は `workspaces/<workspaceId>/files/<fileId>/<versionId>/<fileName>` とし、request から S3 key を受け取らない。
- upload session は MIME type、byte 数、file 名を検証し、最大 2 GiB に制限する。`Content-Type`、`Content-Length`、`If-None-Match: *`、upload tag を署名対象にし、同じ論理 version の上書きを拒否する。object size は完了 API でも再検証する。
- GuardDuty Malware Protection が `GuardDutyMalwareScanStatus=NO_THREATS_FOUND` を付与するまで、API は access URL を発行せず、bucket policy も browser など API/GuardDuty 以外の principal による object read を拒否する。API execution role の例外は upload metadata と scan tag の検証に使い、access URL は clean と判定した immutable S3 VersionId にだけ固定する。`THREATS_FOUND` は `blocked`、scan failure/unsupported は `failed` として扱う。
- Upload object は最初に `mukuroji-upload=pending` を持ち、clean scan を確認した API だけが `completed` へ更新する。未使用 URL や delete 後に再利用された旧 PUT URL が作った孤立 current object は 1 日後に lifecycle で失効する。
- Upload 完了は immutable S3 VersionId と `scanning` repair state を DynamoDB に先に確定し、その後に clean tag を保持した `completed` 更新と `available` 反映を行う。後半が一時失敗しても次回 read で同じ VersionId を再検証できる。
- Delete 確定後は各 immutable S3 VersionId に `mukuroji-deleted=true` を設定し、bucket policy が API や署名済み URL を含む全 principal の read を拒否する。GuardDuty と upload 完了 tag は上書きせず保持する。
- Guest は read-only とし、manager が upload 時に `guestAccess=true` を明示した file だけ参照できる。署名 URL、S3 key、authorization header は audit metadata に保存しない。

## Data model

`FileProofingTable` は `scopeKey` / `recordKey` を primary key とする。

```text
scopeKey  = WORKSPACE#<workspaceId>#TEAM#<teamId>#WORKITEM#<workItemId>
          | WORKSPACE#<workspaceId>#TEAM#<teamId>#PROJECT#<projectId>
recordKey = FILE#<fileId>
          | ANNOTATION#<fileId>#<versionId>#<annotationId>
          | APPROVAL#<approvalId>
          | FILE_APPROVAL#<fileId>#<approvalId>
          | APPROVAL_SUMMARY
          | DOWNLOAD#<downloadId>
```

Comment attachment は親 Work Item partition に保存し、`targetType=comment` / `targetId=<commentId>` で区別する。File row は全 version の immutable object key、scan state、現在 version、guest access、soft-delete retention を保持する。`FILE_APPROVAL` row は file delete 時に関連 approval/reviewer metadata を file prefix の強整合 Query だけで列挙する逆引き projection で、approval state と同じ transaction で保存する。download URL の発行は URL 自体ではなく actor/file/version/time だけを履歴に残す。

Reviewer Inbox 用 projection は `WORKSPACE#<workspaceId>#REVIEWER#<memberKey>` partition に main approval への pointer、期限、reviewer/aggregate status だけを同じ transaction で保存する。comment を含む approval 全体は複製せず、bounded Query 後に BatchGet する。`APPROVAL_SUMMARY` は status count と `dueAt#approvalId` の pending set を原子的に増減し、read 時点の `overdueCount` / `nextDueAt` を算出する。`/api/work-items` は summary rows を最大 100 件ずつ BatchGet し、Inbox と report が同じ正本を利用する。

## API flow

Work Item の例を示す。Project は `/teams/{teamId}/projects/{projectId}/files`、comment upload は `/teams/{teamId}/issues/{issueId}/comments/{commentId}/files/uploads` を使う。

```text
POST /api/teams/{teamId}/issues/{issueId}/files/uploads
PUT  <presigned S3 URL>
POST /api/teams/{teamId}/issues/{issueId}/files/{fileId}/versions/{versionId}/complete
GET  /api/teams/{teamId}/issues/{issueId}/files
GET  /api/teams/{teamId}/issues/{issueId}/files/{fileId}/versions/{versionId}/access
```

Version 差し替えは `POST .../files/{fileId}/versions`、annotation は `GET|POST .../versions/{versionId}/annotations` を使う。Image は正規化 x/y、PDF は x/y + 1 始まり page、video は x/y + millisecond timecode を保存する。

Approval は次の endpoint を使う。

```text
POST /api/teams/{teamId}/issues/{issueId}/approvals
POST /api/teams/{teamId}/issues/{issueId}/approvals/{approvalId}/decisions
POST /api/teams/{teamId}/issues/{issueId}/approvals/{approvalId}/cancel
GET  /api/approvals/reviewer?limit=50&cursor=<opaque>
```

Request は最大 20 人の active Workspace reviewer と期限を必須にし、decision comment は 2,000 文字までに制限する。Reviewer decision は approval revision で optimistic concurrency を行い、`approved` / `rejected` / `changes-requested` を保存する。Pending approval 中は対象 version の差し替えと file delete を拒否するが、requester または manager は revision 条件付き cancel で reviewer projection、pending count、summary を同じ transaction 内で解除できる。全 reviewer が承認した transaction では、decision 直前に強整合 read した Work Item revision を条件に canonical status を既定で `done` へ遷移するため、依頼後に Work Item が編集されても再読込後に安全に再試行できる。revision 属性がない legacy Work Item は revision 1 として同じ CAS で更新する。Approval row、reviewer projection、File pending count、summary、Work Item transition、audit/outbox event のいずれかが競合した場合は全体を rollback する。

`approval.requested` と `approval.completed` は reviewer/requester の notification candidate、deep link、workflow transition、automation hook を metadata に持つ。現在の event consumer は notification projection を行い、automation engine は同じ durable event を将来の idempotent trigger として利用する。

## Audit / retention

File 作成、version、upload 完了、preview/download access、annotation、delete、approval request/decision/completion/cancel は state と同じ DynamoDB transaction で immutable audit event を保存する。Preview/download event は親 Work Item/Project activity から actor・version・時刻を追跡できる。resource ID は scope と idempotency key hash から決定的に作り、request fingerprint が異なる key 再利用は 409 にする。

Delete は metadata を即時非表示にし、file、annotation、approval、reviewer projection に `FILE_RETENTION_DAYS` 後の TTL を設定して、各 S3 key に delete marker を作成する。さらに `file.deleted` audit outbox consumer が tombstone を強整合 read し、immutable object version の deleted tag と従属 metadata TTL を冪等に補完する。S3 tagging または DynamoDB 更新が失敗した record は処理済みにせず stream retry / DLQ へ送るため、API 応答後の同期 cleanup failure も回復できる。

S3 lifecycle は非現行 version を既定 30 日保持してから削除する。delete marker 作成に失敗して `mukuroji-deleted=true` の object が current のまま残った場合は、tagged lifecycle が 1 日後に非現行化し、その後は同じ retention を適用する。正規に完了した live object は通常運用中に期限切れにせず、`pending` の孤立 upload だけを 1 日後に削除する。

## Validation

```sh
bun run server:test
bun run server:build:lambda
bun run cdk:build
bun run cdk:test
bun run web:test
bun run web:lint
bun run web:build
bun run web:build-storybook
bun run web:e2e
```
