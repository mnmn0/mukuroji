# Event / Activity / Audit 基盤

## 目的

この文書は、Work Item、コメント、Workspace メンバー、project、workflow、file、approval の mutation を、現在状態とは別の immutable event として保存するための契約を定義する。event は次の用途で共有する。

- Work Item 詳細の activity
- Workspace 管理者向け audit 検索と export
- 通知・Inbox・自動化・分析 consumer の outbox
- 障害調査と migration の追跡

新しい汎用 event は `AuditEventsTable` に保存する。Audit reader は current schema v1 の row だけを受理し、旧 Team Issue event row の read-time 変換や再利用は行わない。

## 境界と用語

- **target**: 直接変更された対象。コメント追加なら comment、role 変更なら member。
- **entity**: activity をまとめる単位。コメントは親 Work Item を entity とする。
- **event**: 成功した mutation の immutable な業務記録。
- **outbox**: consumer へ event を配送するため、state と同じ transaction で作る immutable record。
- **activity**: entity 単位に整形・redact した event view。
- **audit**: Workspace 単位で actor、target、期間を検索できる管理者 view。

時刻はすべて UTC の ISO 8601 形式を使う。`eventId` は公開識別子であり、時刻順序には利用しない。順序は各 GSI の `*EventKey`（`<occurredAt>#<eventId>`）で決定する。

## Event schema

`schemaVersion = 1` の論理契約は次のとおりとする。DynamoDB の query 用属性は API response へ露出しない。

| 属性 | 必須 | 説明 |
| --- | --- | --- |
| `schemaVersion` | yes | event payload の version。初期値は `1`。 |
| `eventId` | yes | Workspace/actor scoped idempotency hash と event sequence から決定的に導出する event ID。 |
| `eventType` | yes | `work-item.updated` のような過去形の domain event 名。 |
| `directoryId` / `workspaceId` | yes | 内部 Workspace partition。production の canonical ID は email 等の PII を含めない。公開 DTO には含めない。 |
| `occurredAt` | yes | state mutation が確定した時刻。 |
| `occurredAtEventId` | yes | `<occurredAt>#<eventId>` の timeline sort key。各 GSI の sort key と同じ値。 |
| `actor` / `actorUserId` | yes | kind、安定 user key、任意の表示名を持つ actor snapshot。backfill は `system:backfill` を使う。Bearer token は保存しない。 |
| `entity` / `entityType` / `entityId` | yes | activity query の親 resource。nested object と query 互換の flat field を同じ値で保存する。 |
| `target` / `targetType` / `targetId` | yes | 直接変更した resource。nested object と query 互換の flat field を同じ値で保存する。 |
| `action` | yes | `created`、`updated`、`deleted`、`commented`、`backfilled` などの操作。 |
| `changes` | yes | field 名と `before` / `after` の配列。変更を含まない event では空配列を許す。 |
| `correlationId` | yes | 1 request と、その request から派生した event を関連付ける ID。 |
| `idempotencyKeyHash` | yes | client key の SHA-256 hash。元の header 値は保存しない。 |
| `requestFingerprint` | yes | method、path、query、body から作る request fingerprint。 |
| `source` / `sourceDetails` | yes | `api`、`system`、`migration`、`backfill` と request route 等の発生元 snapshot。 |
| `summary` | no | activity 表示用の短い説明または変更理由。 |
| `beforeRevision` / `afterRevision` | no | versioned aggregate の optimistic concurrency 情報。 |
| `expiresAt` | no | `AUDIT_RETENTION_DAYS` から計算する DynamoDB TTL epoch 秒。legal hold で retention を停止した event だけ省略する。 |
| `outboxStatus` | yes | 通常 mutation は `pending`、backfill は `suppressed`。Stream consumer の配送判定に使う。 |
| `metadata` | no | adapter、scope、source の診断情報など schema の必須項目に含めない付加情報。 |

`changes` の例:

```json
[
  {
    "field": "status",
    "before": "in-progress",
    "after": "done"
  },
  {
    "field": "assigneeUserId",
    "before": "sato@example.com",
    "after": "suzuki@example.com"
  }
]
```

mutation ごとに許可する field を allowlist 化し、request body 全体を event にコピーしてはならない。password、access/refresh token、Cookie、署名 URL、秘密鍵は event・outbox・ログのいずれにも保存しない。

### Resource type と event type

初期 entity/target type は次を受け付ける。

- `work-item`
- `comment`
- `member`
- `invitation`
- `project`
- `workflow`
- `file`
- `approval`

event type は resource と operation を組み合わせる。例: `work-item.created`、`work-item.updated`、`comment.created`、`member.role-changed`、`member.removed`、`invitation.created`、`invitation.revoked`、`project.archived`、`workflow.updated`、`file.attached`、`approval.decided`。team は現行 directory model との互換のため `entityType=project`、`entityId=team/<teamId>`、`metadata.kind=team` として扱う。Canonical Work Item ID は既存 activity / collaboration key と互換の `team/<teamId>/issue/<issueId>` とし、comment target は `<workItemId>/comment/<commentId>` とする。Workspace member / invitation の公開 ID は固定 HMAC key と domain separation から `workspace/wsp_v2_<digest>/member/mbr_v2_<digest>`、`workspace/wsp_v2_<digest>/invitation/inv_v2_<digest>` を導出し、raw Workspace ID、member key、email を含めない。同じ private resource は live mutation と backfill で同じ ID になり、別 Workspace と混同しない。migration が current snapshot だけを復元した event は `*.backfilled` とし、実際の作成時刻や actor を捏造しない。

## DynamoDB key

`AuditEventsTable` の primary key と GSI は次のとおりとする。

| Index | Partition key | Sort key | 用途 |
| --- | --- | --- | --- |
| table | `directoryId` | `eventId` | immutable event の正本と deterministic duplicate guard |
| `WorkspaceOccurredAtIndex` | `workspaceKey` | `workspaceEventKey` | Workspace audit と export |
| `EntityOccurredAtIndex` | `entityKey` | `entityEventKey` | detail activity |
| `ActorOccurredAtIndex` | `actorKey` | `actorEventKey` | actor + 期間検索 |
| `TargetOccurredAtIndex` | `targetKey` | `targetEventKey` | target + 期間検索 |

値は server が次の形式で構築し、request から key 文字列を直接受け取らない。

```text
workspaceKey      = <directoryId>
workspaceEventKey = <occurredAt>#<eventId>
entityKey         = <directoryId>#<entityType>#<entityId>
entityEventKey    = <occurredAt>#<eventId>
actorKey          = <directoryId>#actor#<actorUserId>
actorEventKey     = <occurredAt>#<eventId>
targetKey         = <directoryId>#<targetType>#<targetId>
targetEventKey    = <occurredAt>#<eventId>
```

同一 timestamp の event は `eventId` で安定して並ぶ。API は index key を response に含めない。

## Mutation transaction と outbox

mutation は次の item を 1 回の `TransactWriteItems` で確定する。

1. aggregate state の `Put` / `Update` / `Delete`。更新では `revision = expectedRevision` 等の condition を含める。
2. `AuditEventsTable` の event `Put`。`directoryId` / `eventId` の `attribute_not_exists` を条件にする。

どちらかが失敗した場合は state と event の両方を確定しない。DynamoDB transaction の `ClientRequestToken` は短時間の補助にだけ使用し、durable duplicate guard の正本にはしない。

`AuditEventsTable` 自体で DynamoDB Streams の `NEW_IMAGE` を有効化し、immutable event row を outbox として兼用する。通常 mutation は `outboxStatus=pending`、backfill は `outboxStatus=suppressed` を保存する。consumer は stream record の `eventId` で処理し、`suppressed` record は通知・自動化へ配送しない。これにより state と outbox の二重書き問題を DynamoDB transaction 内で解消しつつ、過去データの backfill による誤通知を避ける。

## Idempotency と retry

mutation client は logical mutation の開始時に `MutationRequestContext` を1回だけ作り、同時実行された同じ operation/input の in-flight request で `Idempotency-Key` / `X-Correlation-Id` を共有する。現行 server は保存済み response を replay しないため、response を確認できなかった transport failure 後に同じ key を無条件再送してはならない。Workspace UI は context を一時保持し、snapshot の再取得が成功した時点で retry 待ち context を破棄する。Workspace invitation の多段 mutation は取得済み state の version/status も fingerprint に含め、再取得した最新 state から利用者が行う続行操作を新しい logical mutation として別 key へ切り替える。再取得に失敗して結果が不明な間だけ context を保持し、自動再送は行わない。認証入力の fingerprint は password/session の平文を保持せず、memory 内の SHA-256 digest だけを使う。Web API client は context を必須とし、呼び出し側が retry の境界を明示する。CORS でも両 header を許可する。互換 client が idempotency header を送らない場合の server 採番は後方互換用であり、response 消失後の再送保証には使わない。

server は method、path、query、body から request fingerprint を計算し、`SHA-256("audit-idempotency-v1\0" + workspaceId + "\0" + actorId + "\0" + idempotencyKey)` を `idempotencyKeyHash` とする。`X-Correlation-Id` がなければ `corr_` と `SHA-256(workspaceId + "\0" + idempotencyKeyHash)` の先頭32桁から決定的に補う。event ID は `workspaceId + idempotencyKeyHash + schemaVersion + sequence` から作り、生成後の resource ID、state、entity、event type を digest に含めない。Workspace invitation の複数段 mutation は開始、identity mutation、claim/reconcile、delivery/cleanup に固定 sequence `0..3` を割り当てる。同じ Workspace/actor で同じ `Idempotency-Key` を再利用した場合:

- event `Put` の condition が失敗するため、state write も transaction rollback され、event は増えない。
- 現行 API は duplicate retry を conflict として返す。将来、元 response の replay が必要になった場合は `MutationRequestsTable` を追加し、fingerprint 一致時だけ保存済み response を返す。
- 同じ key を異なる payload に使うことは禁止する。将来の receipt 導入時は `409 IdempotencyKeyConflict` として明示する。

`TransactionCanceledException` は duplicate event だけを意味しない。event と aggregate の最新 state を consistent read し、duplicate、not found、revision conflict、last owner/manager guard、未知の infrastructure error を分類する。単にすべてを generic conflict へ変換してはならない。

## Activity / audit query

### Detail activity

```http
GET /api/teams/{teamId}/issues/{issueId}/activity?limit=50&cursor=...&from=...&to=...
```

Work Item の viewer 権限を要求し、`EntityOccurredAtIndex` を `entityKey=<directoryId>#work-item#team/<teamId>/issue/<issueId>` で query する。response は `{ events, nextCursor }` とする。comment のように target と entity が異なる event も同じ activity に含む。#20 で URL を canonical `/work-items/` へ移す場合も、event の entity contract は維持する。

### Workspace audit

```http
GET /api/audit/events?actorId=...&targetType=...&targetId=...&eventType=...&from=...&to=...&limit=50&cursor=...
GET /api/audit/events/export?actorId=...&from=...&to=...
```

system admin を要求する。target filter がある場合は `TargetOccurredAtIndex`、actor filter がある場合は `ActorOccurredAtIndex`、どちらもない場合は `WorkspaceOccurredAtIndex` を使う。actor と target の両方がある場合は target index を query し、actor を filter する。同期 export は NDJSON を最大 1,000 件まで返す。上限到達時に後続 cursor が残る場合は `X-Audit-Truncated: true` と `X-Audit-Next-Cursor` を返し、呼び出し側が続きの export を取得できるようにする。1,000 件を超える export は次の非同期 S3 job を使う。

### 非同期 audit export job

```text
POST /api/audit/exports                       # body: { "filters": { actorId?, actorKind?, entityType?, entityId?, targetType?, targetId?, eventTypes?, from?, to? } }
GET  /api/audit/exports                       # 期限内の最新 20 件
GET  /api/audit/exports/:exportId
GET  /api/audit/exports/:exportId/download    # completed の part ごとの署名付き URL（?fromPart= で 100 件ずつ）
```

system admin または `audit.export` 権限を要求する。

- request body は `filters` だけを持つ JSON object とする。body がない場合、JSON が壊れている場合、`filters` がない場合、`filters` 以外の field がある場合は `400 InvalidAuditExportRequest` を返し、絞り込みのない export に広げない。全件を出す場合は `{"filters":{}}` を明示する。filter に空文字列や空配列を渡すと制限が外れて全件に広がるため、`400 InvalidAuditExportFilters` で拒否する（制限しない項目は省略する）。
- filter は同期 audit query と同じ規則で作成時に検証する（`eventTypes` は空でない最大 20 件など）。 `entityType` / `targetType` は単独で指定でき、`entityId` / `targetId` には対応する type が必要。worker で初めて失敗する job は作らない。
- `Idempotency-Key` は必須で、ない場合は `400 IdempotencyKeyRequired` を返す。export ID は Workspace・要求者・key の SHA-256 から決まり、同じ key で別の filter や要求者を送ると `409 AuditExportIdempotencyConflict` を返す。
- 要求は job を作る前に `audit.export-requested` として記録する。audit 書き込みに失敗した場合は job を作らずに失敗を返すため、記録のない export は実行されない。
- 同じ key の再要求は、job の作成、index marker の作成、enqueue のどこで前回失敗していても同じ job を再利用して不足分をやり直す。`queued` の job は再度 enqueue する。

job と worker の動作は次のとおり。

- 要求の audit event を記録した後に job の作成が失敗して同じ key で再送された場合は、記録済み event の時刻を `snapshotAt` に使い、再送時刻の後に追加された event を含めない。
- job は要求時刻を `snapshotAt` として固定し、`to` を snapshot 時刻で上限化するため、export 中に追加された event は含めない。
- audit index は結果整合のため、最初の step は `snapshotAt` から 30 秒後まで event を読まない。早く届いた message は残り時間だけ遅延して再 enqueue する。この待機は再走査を減らすための最適化であり、完全性は次の completeness barrier で保証する。
- completeness barrier: index の走査が snapshot 末尾に達しても、job はすぐには `completed` にしない。同じ Workspace partition の base table（`directoryId`）を strongly consistent read の `Query`（`Select: COUNT`）で読み、index query と同じ述語（index の partition key、`*EventKey` の期間、filter）に一致する event 数を数える。base table の sort key は時刻順でない `eventId` のため、件数の確認は filter や期間にかかわらず Workspace の audit partition 全体を読む（1 export につき 1 回、再走査時はその都度で最大 3 回）。partition の read capacity を API や audit writer に残すため、1 step で読む件数確認の page は走査（最大 50 page）より小さい最大 10 page（1 page 最大 1 MB）とし、cursor を `job.verification` に保存して step をまたいで進める。監視する metric と将来の LSI 案は [operational-readiness.md](operational-readiness.md) に記載する。base table の件数が走査で書いた件数と一致した場合だけ `completed` にする。GSI への伝搬が 30 秒を超えて遅れた event が走査から漏れると件数が食い違うため、part と件数を破棄して `queued` に戻し、`scanAttempt` を増やして待機後に走査をやり直す。3 回の走査で一致しない場合（backfill などで snapshot 以前の時刻の event が書き込まれ続ける場合を含む）は、欠けた export を完了させず `AuditExportIncomplete` で `failed` にする。
- snapshot の範囲: audit row は書き込み（ingestion）時刻を持たず、`occurredAt` だけを持つ。そのため export は「`occurredAt` が `snapshotAt` 以前で、件数の確認がその row の位置を読んだ時点で base table に確定していた event」を含む。件数の確認が保証するのは、確認の時点までに書き込まれた row が走査から漏れていないことであり、確認の後（`completed` の書き込みまでの間を含む）や完了後に書き込まれた row は、`occurredAt` が `snapshotAt` 以前でも含まれない。確認の途中に書き込まれた row は、`eventId` 順で cursor より前に入れば含まれず、後に入れば件数の食い違いとして再走査される。backfill / migration で過去の時刻の event を追加した場合は、その完了後に export を依頼し直す。書き込み側の fence（audit writer が export 中の Workspace を確認する、または ingestion watermark を書く）は、すべての mutation transaction と backfill に条件を加え、Workspace ごとの hot item で競合させる横断的な変更になるため採用しない。
- 非同期 export の snapshot は、処理期限（作成から 24 時間）より後に `expiresAt` を迎える event と `expiresAt` のない event（legal hold 中など）だけを含む。DynamoDB TTL は `expiresAt` より前に item を削除しないため、これらの event は job の間ずっと base table に残り、件数の確認で漏れを証明できる。処理中に期限を迎え得る retention 末端の event は、走査から漏れた後に TTL で消えると両方の件数から同時に外れて漏れを検出できないため、export にも件数の確認にも含めない。これらは遅くとも 1 日以内に retention で削除される event であり、必要な場合は同期 export で参照する。
- `AuditExportQueue` の message ごとに worker Lambda が 1 step を処理する。1 step は query page を最大 50 回まで評価し、5,000 件または約 32 MiB に達したところで part を閉じ、cursor を job に保存して次の step を enqueue する。絞り込みで一致が少ない場合も、page 上限で cursor を保存して進むため、Lambda の timeout まで走り続けない。
- 合計上限は 1,000,000 件で、超えた場合は `AuditExportTooLarge` で `failed` にする。
- job state は `audit-exports/<sha256(workspaceId)>/<exportId>/job.json` に置き、作成は `If-None-Match`、更新は ETag の `If-Match` で条件付き書き込みにする。
- part は内容の SHA-256 を含む `part-NNNNN-<digest>.ndjson` として保存する。同じ step が重複して実行されても、条件付き書き込みに勝った job が参照する object を上書きできない。job は件数・byte 長・checksum を記録する。
- download URL は job の Workspace と export ID から導出した prefix の内側にある key だけに発行し、有効期限は 300 秒（job の有効期限までの残り時間がそれより短い場合はその残り時間）。1 回の応答は最大 100 part で、続きがある場合は `nextPart` を返し、`?fromPart=<nextPart>` で次の page を取得する。Lambda の同期応答上限を超えないようにするため。
- worker は step ごとに tenant が active かを確認し、closing / closed の tenant では何も書かない。closing は取り消されて active に戻り得るため、job が残っていれば 15 分後に同じ step を再投入して再開できる状態を保つ。tenant closure が export namespace を削除した後は job が存在しないため chain は終わり、object を作り直さない。処理期限を過ぎた job も再投入しない。
- queue message は `version`（`1`）、`workspaceId`、`exportId`、`correlationId` を持つ。`correlationId` は `audit.export-requested` event の correlation ID（`X-Correlation-Id`、または記録済み event の値）で、job にも保存し、worker の失敗ログに含めて step を依頼元の request まで辿れるようにする。保存済み job の `correlationId` と異なる message は step を実行せずに失敗として返し、redrive policy で DLQ に送る。
- 読めない queue message（`correlationId` が欠けている、空、前後に余白がある、256 文字を超える場合を含む）は失敗として返し、redrive policy で DLQ に送る。
- step が job を条件付きで書き込んだ後に次の step の `SendMessage` が失敗した場合に備え、job は直前の step を確定した SQS message ID（`lastStepMessageId`）を保持する。同じ message が再配送されたときは step を再実行せず、続きの message の送信だけをやり直すため、cursor を進め直して part を重複させない。
- 送信の失敗が `maxReceiveCount` まで続いて message が DLQ に移ると、続きの message がないまま job が `queued` / `running` に残る。`GET /api/audit/exports/:exportId` と `GET /api/audit/exports` は、処理期限内の未完了 job が 20 分（SQS の最大遅延 900 秒と worker の timeout 5 分より長い）書き込まれていない場合、`updatedAt` と `continuationPending` を条件付きで書き込んでから続きを enqueue する。条件付き更新に勝った読み取りだけが enqueue するため、同時に読まれても 1 回しか再開しない。`continuationPending` は送信が成功した後、または次の step が job を確定したときにだけ外す。送信が失敗した場合は印が残り、20 分を待たずに次の読み取りが再び送信する。重複した message は ETag の条件付き書き込みで 1 つだけが step を確定する。誰も読まない job は処理期限後に `AuditExportProcessingTimedOut` として返る。
- job は作成から 24 時間以内に完了しなければ `AuditExportProcessingTimedOut` で失敗し、それ以降は part も job も書き込まない。期限後に遅れて届いた message でも worker は失敗状態を書き込まず（`job.json` を書き換えると lifecycle の期限が延びるため）、API が期限を過ぎた未完了の job を読み取り時に `failed` として返す。step の途中で期限を過ぎた場合も、part と job の書き込みの直前に期限を再確認して書き込まない。bucket lifecycle は各 object の最終書き込みから 8 日で current version を削除し、noncurrent version をさらに 1 日後に消すため、artifact は作成から最長約 10 日で消える。
- 1 job の part は 10,000 個まで。選択的な filter で小さな part が続いて上限に達した場合は `AuditExportTooManyParts` で失敗し、filter や期間を絞った再依頼を求める。
- `from` が依頼時刻より未来の filter は `400 InvalidAuditExportFilters` で拒否する（worker は上限を snapshot 時刻に揃えるため一致し得ない）。
- `audit.export-requested` event は key から導出した export ID による `audit-export-request:<exportId>` を audit の冪等 key とし、正規化した filter の digest（`filtersDigest`）を含める。同じ key を別の audit 操作に使っても衝突せず、job 作成前に失敗した後で filter を変えて再送すると audit 側で競合になる。
- `audit.export-requested` event は key の受付記録を兼ねるため、audit retention が短く設定されていても artifact より長く残るよう最低 17 日保持する。
- API の寿命（7 日）を過ぎた job の object が lifecycle で消える前に同じ key で再送された場合も `409 AuditExportIdempotencyKeyExpired` を返す。
- job が消えた後に同じ `Idempotency-Key` で再送された場合、記録済みの `audit.export-requested` が処理期限（24 時間）より古ければ `409 AuditExportIdempotencyKeyExpired` で拒否し、実行されない job や新しい snapshot の export を作らない。同じ key の最初の要求が同時に届き、他方の audit event が先に記録された場合も、job の `snapshotAt` には記録済み event の時刻を使う。同じ key で filter が異なる場合は、audit writer が冪等 key の競合として返す `AuditEventIdempotencyConflictError` も含めて `409 AuditExportIdempotencyConflict` を返す。それ以外の audit 書き込み失敗は 409 にせず 5xx として返す。
- S3 の条件付き書き込みは 412 だけを既存 / 変更済みとして扱い、409 `ConditionalRequestConflict` は再試行対象としてそのまま失敗させる。
- 保存済み job の `requestFingerprint` が保存済み filter から計算した値と一致しない場合は、壊れた job として読み込みを拒否する。
- 保存済み job の `createdAt` / `expiresAt` などの時刻が読めない場合や、`expiresAt` が `createdAt` のちょうど 7 日（`AUDIT_EXPORT_RETENTION_DAYS`）後でない場合、`updatedAt` が `createdAt` より前の場合は壊れた job として読み込みを拒否する。`queued` / `running` の job の `updatedAt` が処理期限（作成から 24 時間）より後の場合も拒否する。未来の更新時刻は、続きの message を失った job を古い job として再開させなくするため。worker は未完了状態の `updatedAt` を処理期限で頭打ちにし、`completed` / `failed` は実際の時刻を書く。
- 保存済み job の `correlationId` が空、前後に余白がある、または 256 文字を超える場合も壊れた job として読み込みを拒否する。
- index marker は存在しない場合だけ作成し、再送で書き直して lifecycle の期限を延ばさない。
- 保存済み job の filter に未知の key がある場合は壊れた job として読み込みを拒否し、未知の条件を黙って捨てた広い export を作らない。
- worker は保存済み filter を query 層が拒否する場合だけ `AuditExportQueryInvalid` で終了し、壊れた audit row などそれ以外の失敗は再試行させて DLQ に届ける。
- `audit.export-downloaded` event は、応答のたびに新しい署名付き URL を発行するため、client が `Idempotency-Key` を再利用しても発行ごとに別 event として記録する（audit の冪等 key は request ごとに新しく生成し、client の key から導出しない）。
- job は 7 日で API から見えなくなり、bucket lifecycle が 8 日で object を削除する。`AuditExportBucket` は versioning を有効にし、tenant closure はすべての version を削除する。lifecycle は noncurrent version を 1 日で、期限切れの delete marker も削除する。`AuditExportQueue` の message 保持期間は job の寿命より長い 8 日とし、worker が長時間止まっても job が `queued` / `running` のまま message だけが消えないようにする。
- 行 projection は同期 export と同じ public DTO を使う。
- export の要求は `audit.export-requested`、download URL の発行は `audit.export-downloaded` として別の audit event に記録する。replay は同じ event を同じ request identity で書き直すため、audit writer が重複として扱う。`exportId`、`filtered`、`fromPart`、`partCount`、`eventCount` は public metadata として audit query と export に含める。

### Public response projection

activity、audit、export は保存 row をそのまま返さず、`eventId`、`eventType`、`occurredAt`、nested actor/entity/target、action、redact 済み changes、`correlationId`、source kind、`summary`、allowlist 済み metadata だけを DTO へ projection する。`schemaVersion`、`workspaceId` / `directoryId`、`actorUserId`、flat な entity/target field、`workspaceKey` / `*EventKey` / `actorKey` / `entityKey` / `targetKey` 等の DynamoDB key、backfill の source key、`requestFingerprint`、`idempotencyKeyHash`、`sourceDetails` の IP/User-Agent、`outboxStatus` は public response と export に含めない。

### Cursor

cursor v1 は version、index、filter fingerprint、DynamoDB `LastEvaluatedKey` を JSON 化して base64url encoding した opaque token である。server は decode 後に filter fingerprint、選択した index、base/index partition key、Workspace/entity/actor/target key を検証し、一致しなければ `400` を返す。client は cursor の中身へ依存せず、異なる filter へ再利用しない。現在の fingerprint は誤用・単純改変の検出用であり、暗号学的な改ざん耐性が必要になった場合は HMAC を追加して v1 decoder と並行移行する。

## Retention と redaction

- audit event は `AUDIT_RETENTION_DAYS`（default 2,555日、約7年）から `expiresAt` を計算する。値は最低1日とし、policy 変更は新規 event から適用する。
- 同じ row が outbox を兼ねるため、TTL は consumer の最大再処理期間より十分長くする。consumer checkpoint は別の短い retention を設定できる。
- field 名が password/token/secret/authorization/cookie/credential/api key/private key/signed URL に該当する値は write-time に `[REDACTED]` へ置換し、文字列は最大4,096文字に制限する。response-time mask だけに依存しない。
- Workspace/member/invitation の公開識別子は PII を直接または unkeyed digest として含めず、`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` を使う HMAC pseudonym に限定する。この key は環境ごとに `openssl rand -hex 32` などで生成した64桁の小文字hex値を固定し、通常の rotation 対象にしない。未設定、長さ不正、非hex文字、uppercase、前後空白はfail-closedで拒否する。
- comment body や説明文は対象への閲覧権限がある activity と system-admin audit だけに返す。より細かい export policy が必要になった場合は field allowlist を追加する。
- 個人情報削除が必要な場合、immutable event を上書きしない。redaction event を append し、query projection で過去値を隠す。強い削除要件がある payload は暗号化した別 table に置き、鍵破棄または payload deletion で消去できるようにする。
- export は event ID、時刻、actor、target、event type、redact 済み changes、correlation ID を含め、internal DynamoDB key、request fingerprint、保存済み mutation response は含めない。

## Consumer dedupe

DynamoDB Streams は at-least-once であり、同じ record が複数回届く前提にする。各 consumer は `ProcessedAuditEventsTable` に次の checkpoint を置く。

```text
PK = <consumerName>
SK = <eventId>
```

consumer の DynamoDB projection と checkpoint は同じ transaction で更新し、checkpoint `Put` に `attribute_not_exists` を付ける。既存 checkpoint があれば成功済みとして終了する。メールや webhook など外部 side effect には `eventId` を downstream idempotency key として渡し、checkpoint は外部側の成功確認後に確定する。失敗は retry/DLQ へ送り、event 自体は変更しない。

## Schema migration と backfill

reader は `schemaVersion === 1` の current event だけを正規化し、旧 version や version 欠落 row は明示的に error/quarantine とする。schema を変更するときは古い event を in-place update せず、canonical な migration event または別 version の reader を用意する。

backfill の Put も DynamoDB Stream record を生成するため、`outboxStatus=suppressed` を必ず付ける。consumer はこれを通常通知・自動化へ流さない。過去 event を配送する場合は、対象 event type と期間を明示した別 replay job を用意する。

## Workspace identity / Canonical Work Item adapter 方針

### Workspace identity / RBAC（#19）

event core は Cognito や invitation provisioning の詳細を直接参照せず、mutation handler から次の `MutationAuditContextInput` だけを受け取る。

```ts
type MutationAuditContextInput = {
  workspaceId: string
  actor: {
    id: string
    kind: 'user' | 'system' | 'service'
    displayName?: string
  }
  idempotencyKey: string
  correlationId?: string
  occurredAt?: string
  request: {
    method: string
    path: string
    body?: unknown
    query?: unknown
  }
  source: {
    kind: 'api' | 'system' | 'migration' | 'backfill'
    requestId?: string
    route?: string
  }
}
```

`WorkspaceMembershipIdentityAdapter` は active Workspace member と owner/admin/member/guest の権限、deactivated member、revoked invitation を検証する。audit actor ID は認証済み principal の安定 ID、表示名は event 発生時点の `principal.userKey` snapshot とする。event writer と schema は Cognito provisioning や adapter の実装を知らない。

project member event の entity/target ID は `<projectId>/<memberId>` とする。Workspace member と invitation は上記の HMAC pseudonym ID を使い、raw Workspace ID、member key、email を公開せずに同じ user の異なる scope を混同しない。

### Canonical Work Item

event builder は canonical Work Item store を直接参照せず、canonical mutation adapter が entity ID、before/after revision、field changes を返す。Team-owned Work Item mutation は `metadata.adapter=canonical-work-item` を保存し、公開契約も `WorkItem` に統一する。

`expectedRevision` は state transaction condition と event の `beforeRevision` / `afterRevision` に反映する。scope は ID と metadata の両方に保持し、別 Team/project の同名 ID を混同しない。詳細は [`work-items.md`](./work-items.md) を参照する。

## 運用確認

- mutation の成功 response より先に state/event transaction が成功していること。
- event/outbox を兼ねる `AuditEventsTable` の Point-in-Time Recovery を有効にすること。
- Stream iterator age、retry、DLQ、duplicate checkpoint 数を監視すること。
- audit export と backfill の実行者、filter、件数、correlation ID を別の運用 audit に残すこと。
- backfill 前後で source 件数、written/duplicate/skipped 件数を保存し、sample event の actor/target/diff/redaction を確認すること。
