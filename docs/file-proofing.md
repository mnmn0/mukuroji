# File / Version / Proofing / Approval

## 目的

成果物を Work Item、保存済み comment、Team scoped project に添付し、同じ画面で版管理、位置付きレビュー、承認まで完結させる。file body は API/Lambda を経由せず private S3 bucket へ直接転送し、metadata と業務履歴だけを DynamoDB と audit event に保存する。

## Security boundary

- upload/download URL は認証済み API だけが発行し、既定で upload 600 秒、download 300 秒で失効する。
- bucket は public access を全面拒否し、TLS、SSE-S3、versioning を必須にする。
- object key は `workspaces/<workspaceId>/files/<fileId>/<versionId>` とし、request から S3 key を受け取らない。file 名は key に含めず DynamoDB と download 時の `Content-Disposition` だけに持たせ、長い日本語名でも S3 の key 上限 (1,024 byte) を超えないようにする。以前の version は末尾に encode 済み file 名を持つ key のまま読み書きする。
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

Comment attachment は親 Work Item partition に保存し、`targetType=comment` / `targetId=<commentId>` で区別する。File row は全 version の immutable object key、scan state、現在 version、guest access、soft-delete retention を保持する。Approval main row は `subjectType=file-version|work-item` と `requestedByKind=member|service` を持つ。`FILE_APPROVAL` row は file-version subject だけに作成し、file delete 時に関連 approval/reviewer metadata を file prefix の強整合 Query だけで列挙する逆引き projection で、approval state と同じ transaction で保存する。Work Item subject は file row や逆引き row を要求しない。download URL の発行は URL 自体ではなく actor/file/version/time だけを履歴に残す。

Reviewer Inbox 用 projection は `WORKSPACE#<workspaceId>#REVIEWER#<memberKey>` partition に main approval への pointer、期限、reviewer/aggregate status だけを同じ transaction で保存する。comment を含む approval 全体は複製せず、bounded Query 後に BatchGet する。`APPROVAL_SUMMARY` は status count と `dueAt#approvalId` の pending set を原子的に増減し、read 時点の `overdueCount` / `pendingDueAt` / `nextDueAt` を算出する。request、reviewer decision、cancel の各 mutation は count が変わらない途中 decision も含めて summary の `updatedAt` を同じ transaction で進め、Focus の approval signal が原因発生時刻として利用する。`/api/work-items` は summary rows を最大 100 件ずつ BatchGet し、Inbox と report が同じ正本を利用する。

## API flow

Work Item の例を示す。Project は `/teams/{teamId}/projects/{projectId}/files`、comment upload は `/teams/{teamId}/issues/{issueId}/comments/{commentId}/files/uploads` を使う。

```text
POST /api/teams/{teamId}/issues/{issueId}/files/uploads
PUT  <presigned S3 URL>
POST /api/teams/{teamId}/issues/{issueId}/files/{fileId}/versions/{versionId}/complete
GET  /api/teams/{teamId}/issues/{issueId}/files
GET  /api/teams/{teamId}/issues/{issueId}/files/{fileId}/versions/{versionId}/access
```

Version 差し替えは `POST .../files/{fileId}/versions` で開始時に version 番号を採番する。upload 完了時は、完了した version の番号が現在 version より大きいときだけ現在 version を切り替える。先に採番した version が後から完了しても検証済みとして記録するだけで、現在 version は戻さない。annotation は `GET|POST .../versions/{versionId}/annotations` を使う。Image は正規化 x/y、PDF は x/y + 1 始まり page、video は x/y + millisecond timecode を保存する。

Annotation の解決・再開・削除は次の endpoint を使う。

```text
POST   .../versions/{versionId}/annotations/{annotationId}/resolve
POST   .../versions/{versionId}/annotations/{annotationId}/reopen
DELETE .../versions/{versionId}/annotations/{annotationId}
```

解決と再開は scope に書き込める member（guest 以外）なら誰でも行え、`resolvedAt` と `resolvedByMemberKey` を annotation row に保存・削除する。削除は作成者だけが行える。どちらも file が削除されていないことを `ConditionCheck` で確かめ、解決状態または作成者を条件にした Put / Delete と `annotation.resolved` / `annotation.reopened` / `annotation.deleted` の audit event を同じ transaction で保存する。すでに目的の状態にある解決・再開は変更せずに現在の annotation を返す。Annotation は version に紐づき、次の version へは引き継がない。

scope の一覧（`GET .../files`）は `ANNOTATION#` prefix も Query し、各 file の現在 version と各 file-version approval の対象 version に残る未解決 annotation の件数を `unresolvedAnnotationCount` として返す。

Approval は次の endpoint を使う。Project に直接添付した file の approval は、同じ形の `/api/teams/{teamId}/projects/{projectId}/approvals` 配下を使う。

```text
POST /api/teams/{teamId}/issues/{issueId}/approvals
POST /api/teams/{teamId}/issues/{issueId}/approvals/{approvalId}/decisions
POST /api/teams/{teamId}/issues/{issueId}/approvals/{approvalId}/cancel
POST /api/teams/{teamId}/projects/{projectId}/approvals
POST /api/teams/{teamId}/projects/{projectId}/approvals/{approvalId}/decisions
POST /api/teams/{teamId}/projects/{projectId}/approvals/{approvalId}/cancel
GET  /api/approvals/reviewer?limit=50&cursor=<opaque>
```

Project file の approval row は Project partition に保存し、`issueId` を持たない。subject は `file-version` だけで、完了時に遷移する Work Item がないため `completionTransition` は 400 `ApprovalCompletionTransitionUnsupported` で拒否する。Reviewer は Project を見られる active member に限り、Reviewer Inbox と外部通知は Project の現在の閲覧権限と file の削除・guest 共有を再確認してから表示・配信する。Audit event の entity は Project で、deep link は Project の画面（`/projects/{projectId}/issues`）を指す。Focus は Work Item に紐づく approval だけを扱う。

Request は最大 20 人の active Workspace reviewer と期限を必須にし、decision comment は 2,000 文字までに制限する。Reviewer decision は approval revision で optimistic concurrency を行い、`approved` / `rejected` / `changes-requested` を保存する。File-version subject の pending approval 中は対象 version の差し替えと file delete を拒否する。Member requester または manager は revision 条件付き cancel で reviewer projection、pending count、summary を同じ transaction 内で解除できる。Automation の service requester は member identity として cancel できず、manager capability が必要になる。全 reviewer が承認した transaction では、Request 時に現在の configuration から選択・保存した完了先 workflow status へ canonical Work Item を遷移する。Decision 直前に configuration と Work Item を強整合 read し、両方の revision を transaction 条件に含めるため、完了先 transition の削除や同時更新は 409 conflict として全体を rollback する。Legacy Work Item は read-only のため Approval mutation の対象にしない。Approval row、reviewer projection、任意の File pending count、summary、Work Item transition、audit/outbox event のいずれかが競合した場合も全体を rollback する。

`approval.requested` と `approval.completed` は reviewer、member requester の notification candidate、deep link、subject/requester kind、workflow transition、automation hook を metadata に持つ。現在の event consumer は notification projection を行い、automation engine は同じ durable event を idempotent trigger として利用する。

## Project の成果物一覧

```text
GET /api/teams/{teamId}/projects/{projectId}/deliverables?approval=all|unapproved|pending|approved&unresolvedOnly=true&limit=50&cursor=<opaque>
```

Project に直接添付した file と、Project の Work Item（comment 添付を含む）の file を 1 つの一覧で返す。各行は file（最新 version と scan 状態）、添付先（Project または Work Item の key・タイトル）、現在 version の承認状態（取り消されていない最新の file-version approval。なければ `none`）、現在 version の未解決 annotation 件数、更新日を持つ。

- 1 page は Project の Work Item 一覧（`assignedProjectId` index）の順に `limit`（既定 50、最大 100）件の Work Item を読み、その Work Item の file をすべて返す。1 page 目だけ Project 自体の file も含める。`nextCursor` は Work Item 一覧の opaque cursor をそのまま使う。page 内は file の更新日の新しい順に並べる。
- 読む Work Item は、URL の Team が所有し、現在の `assignedProjectId` が URL の Project で、archive されておらず、呼び出し元が Project を閲覧できるものに限る。index は結果整合のため、候補の canonical Work Item を strongly consistent read で読み直し、その現在の割り当て・archive・閲覧権限で判定してから添付を読む。file row に保存された作成時の Project ではなく Work Item の現在の割り当てで判定するため、別 Project へ移した Work Item の添付は出ない。Enterprise role で Project の `work-items.read` を持たない人には Work Item を読まず、Project 自体の file だけを返す。Guest には `guestAccess` の file だけを返す。
- Work Item ごとの partition は `FILE#` を先に Query し、表示できる file がある partition だけ `APPROVAL#` と `ANNOTATION#` を Query する。同時に読む partition は 8 件までにする。
- 承認状態と未解決の絞り込みは page 内で行うため、条件に合う行がない page もある。CSV 出力は Web が全 page を読んで作る。

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
