# Event / Activity / Audit 基盤

## 目的

この文書は、Work Item、コメント、Workspace メンバー、project、workflow、file、approval の mutation を、現在状態とは別の immutable event として保存するための契約を定義する。event は次の用途で共有する。

- Work Item 詳細の activity
- Workspace 管理者向け audit 検索と export
- 通知・Inbox・自動化・分析 consumer の outbox
- 障害調査と migration の追跡

現在の `TeamIssueEventsTable` は Team Issue のコメントと短い summary に限定され、field change、correlation、idempotency、schema version を保持しない。新しい汎用 event は `AuditEventsTable` に保存し、既存 table は migration source としてのみ扱う。

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
| `directoryId` / `workspaceId` | yes | Workspace partition。#19 完了前は現在の Cognito directory ID と同じ値。 |
| `occurredAt` | yes | state mutation が確定した時刻。 |
| `occurredAtEventId` | yes | `<occurredAt>#<eventId>` の timeline sort key。各 GSI の sort key と同じ値。 |
| `actor` / `actorUserId` | yes | kind、安定 user key、任意の表示名を持つ actor snapshot。backfill は `system:backfill` を使う。Bearer token は保存しない。 |
| `entity` / `entityType` / `entityId` | yes | activity query の親 resource。nested object と query 互換の flat field を同じ値で保存する。 |
| `target` / `targetType` / `targetId` | yes | 直接変更した resource。nested object と query 互換の flat field を同じ値で保存する。 |
| `action` | yes | `created`、`updated`、`deleted`、`commented`、`backfilled` などの操作。 |
| `changes` | yes | field 名と `before` / `after` の配列。変更が復元不能な legacy event では空配列を許す。 |
| `correlationId` | yes | 1 request と、その request から派生した event を関連付ける ID。 |
| `idempotencyKeyHash` | yes | client key の SHA-256 hash。元の header 値は保存しない。 |
| `requestFingerprint` | yes | method、path、query、body から作る request fingerprint。 |
| `source` / `sourceDetails` | yes | `api`、`system`、`migration`、`backfill` と request route 等の発生元 snapshot。 |
| `summary` | no | activity 表示用の短い説明または変更理由。 |
| `beforeRevision` / `afterRevision` | no | versioned aggregate の optimistic concurrency 情報。 |
| `expiresAt` | yes | DynamoDB TTL epoch 秒。`AUDIT_RETENTION_DAYS` から計算する。 |
| `outboxStatus` | yes | 通常 mutation は `pending`、backfill は `suppressed`。Stream consumer の配送判定に使う。 |
| `metadata` | no | adapter、scope、legacy source など schema の必須項目に含めない診断情報。 |

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
- `project`
- `workflow`
- `file`
- `approval`

event type は resource と operation を組み合わせる。例: `work-item.created`、`work-item.updated`、`comment.created`、`member.role-changed`、`member.removed`、`project.archived`、`workflow.updated`、`file.attached`、`approval.decided`。team は現行 directory model との互換のため `entityType=project`、`entityId=team/<teamId>`、`metadata.kind=team` として扱う。Canonical Work Item ID は既存 activity / collaboration key と互換の `team/<teamId>/issue/<issueId>` とし、comment target は `<workItemId>/comment/<commentId>` とする。過去に legacy task から backfill 済みの `project/<projectId>/task/<taskId>` は historical alias としてだけ読み取り、新しい mutation には使わない。migration が current snapshot だけを復元した event は `*.backfilled` とし、実際の作成時刻や actor を捏造しない。

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

mutation client は logical mutation の開始時に `MutationRequestContext` を1回だけ作り、初回 request とすべての retry で同じ `Idempotency-Key` / `X-Correlation-Id` を再利用する。Web UI は operation と入力 fingerprint ごとに context を保持し、失敗後に同じ入力を再送した場合だけ再利用する。HTTP mutation 成功時または入力変更時は context を破棄し、別 mutation へ同じ key を流用しない。Web API client は context を必須とし、呼び出し側が retry の境界を明示する。CORS でも両 header を許可する。互換 client が idempotency header を送らない場合の server 採番は後方互換用であり、response 消失後の再送保証には使わない。

server は method、path、query、body から request fingerprint を計算し、`SHA-256("audit-idempotency-v1\0" + workspaceId + "\0" + actorId + "\0" + idempotencyKey)` を `idempotencyKeyHash` とする。`X-Correlation-Id` がなければ `corr_` と `SHA-256(workspaceId + "\0" + idempotencyKeyHash)` の先頭32桁から決定的に補う。event ID は `workspaceId + idempotencyKeyHash + schemaVersion + sequence` から作り、生成後の resource ID、state、entity、event type を digest に含めない。同じ Workspace/actor で同じ `Idempotency-Key` を再利用した場合:

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

system admin を要求する。target filter がある場合は `TargetOccurredAtIndex`、actor filter がある場合は `ActorOccurredAtIndex`、どちらもない場合は `WorkspaceOccurredAtIndex` を使う。actor と target の両方がある場合は target index を query し、actor を filter する。同期 export は NDJSON を最大 1,000 件まで返す。上限到達時に後続 cursor が残る場合は `X-Audit-Truncated: true` と `X-Audit-Next-Cursor` を返し、呼び出し側が続きの export を取得できるようにする。将来は大規模な export を非同期 S3 job へ分離する。

### Public response projection

activity、audit、export は保存 row をそのまま返さず、`eventId`、`eventType`、`occurredAt`、actor、entity、target、action、redact 済み changes、`correlationId`、source kind、`summary`、allowlist 済み metadata だけを DTO へ projection する。`workspaceKey` / `*EventKey` / `actorKey` / `entityKey` / `targetKey` 等の DynamoDB key、backfill の `legacyKey`、`requestFingerprint`、`idempotencyKeyHash`、`sourceDetails` の IP/User-Agent、`outboxStatus` は public response と export に含めない。

### Cursor

cursor v1 は version、index、filter fingerprint、DynamoDB `LastEvaluatedKey` を JSON 化して base64url encoding した opaque token である。server は decode 後に filter fingerprint、選択した index、base/index partition key、Workspace/entity/actor/target key を検証し、一致しなければ `400` を返す。client は cursor の中身へ依存せず、異なる filter へ再利用しない。現在の fingerprint は誤用・単純改変の検出用であり、暗号学的な改ざん耐性が必要になった場合は HMAC を追加して v1 decoder と並行移行する。

## Retention と redaction

- audit event は `AUDIT_RETENTION_DAYS`（default 2,555日、約7年）から `expiresAt` を計算する。値は最低1日とし、policy 変更は新規 event から適用する。
- 同じ row が outbox を兼ねるため、TTL は consumer の最大再処理期間より十分長くする。consumer checkpoint は別の短い retention を設定できる。
- field 名が password/token/secret/authorization/cookie/credential/api key/private key/signed URL に該当する値は write-time に `[REDACTED]` へ置換し、文字列は最大4,096文字に制限する。response-time mask だけに依存しない。
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

reader は `schemaVersion` ごとの decoder/upcaster を持ち、未知 version は黙って読み飛ばさず quarantine/error にする。schema を変更するときは古い event を in-place update せず、read-time upcast または新しい migration event を使う。

初期 migration は [backfill-audit-events.ts](../server/scripts/backfill-audit-events.ts) を使用する。対象は次の 4 source である。

- 既存 Team Issue event: `created` / `updated` / `commented` を汎用 event に変換する。
- current Team Issue: `work-item.backfilled` snapshot を作る。
- legacy project task: `work-item.backfilled` snapshot を作る。
- project directory: team、project、project-member の `*.backfilled` snapshot を作る。

source item の key から logical idempotency key を決定的に作り、通常 mutation と同じ schema v1 builder で event ID、nested/flat actor/entity/target、4つの GSI key、`idempotencyKeyHash`、`sourceDetails` を生成する。legacy source/key、adapter、scope は `metadata` に保存し、`AuditEventsTable` の `directoryId/eventId` へ conditional Put する。同じ script を何度実行しても event は増えない。current snapshot の時刻は `updatedAt`、`createdAt` の順で採用し、どちらも存在しない row だけ `1970-01-01T00:00:00.000Z` を「unknown historical time」の sentinel として使う。TTL は event の `occurredAt` から `AUDIT_RETENTION_DAYS` 後に設定する。snapshot field の sensitive flag は `[REDACTED]` に変換し、通常 mutation と同じく保存するすべての文字列 payload を最大4,096文字に制限する。

```sh
# まず読み取りだけを最大100件確認する
AWS_ENDPOINT_URL=http://localhost:4566 \
AUDIT_EVENTS_TABLE_NAME=mukuroji-audit-events \
bun server/scripts/backfill-audit-events.ts --dry-run --limit 100

# checkpoint を使って本実行する
AWS_ENDPOINT_URL=http://localhost:4566 \
TEAM_ISSUE_EVENTS_TABLE_NAME=mukuroji-team-issue-events-local \
TEAM_ISSUES_TABLE_NAME=mukuroji-team-issues-local \
TASKS_TABLE_NAME=mukuroji-project-tasks-v2-local \
PROJECT_DIRECTORY_TABLE_NAME=mukuroji-project-directory-local \
AUDIT_EVENTS_TABLE_NAME=mukuroji-audit-events \
bun server/scripts/backfill-audit-events.ts \
  --checkpoint /tmp/mukuroji-audit-backfill.json \
  --limit 1000
```

`--limit` は 1 run で scan する source item 数の上限であり、event 数ではない。source は consistent read で scan する。checkpoint は DynamoDB `LastEvaluatedKey` と累積 counter を source ごとに保持し、endpoint、region、profile、account hint、table 名の configuration hash が異なる環境では再利用を拒否する。page 処理中に停止した場合は同じ page を再処理するが、conditional Put により安全である。`--dry-run` は table、event、checkpoint のいずれも書き込まない。local endpoint の本実行は共通 bootstrap を呼び、`mukuroji-audit-events` が未作成なら本番と同じ key/GSI/Stream を持つ table を作成してから書き込む。

backfill の Put も DynamoDB Stream record を生成するため、`outboxStatus=suppressed` を必ず付ける。consumer はこれを通常通知・自動化へ流さない。過去 event を配送する場合は、対象 event type と期間を明示した別 replay job を用意する。

## #19 / #20 未実装期間の adapter 方針

### Workspace identity / RBAC（#19）

event core は Cognito や将来の invitation lifecycle を直接参照せず、mutation handler から次の `MutationAuditContextInput` だけを受け取る。

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

Issue `#19` 完了前は既存 Cognito `getUser` を使い、audit actor ID は `sub`、次点で Cognito username、表示名と既存 RBAC key は `principal.userKey` とする `CognitoWorkspaceIdentityAdapter` を置く。Issue `#19` 完了後は active Workspace member、owner/admin/member/guest、deactivated/revoked 状態を検証する `WorkspaceMembershipIdentityAdapter` に差し替える。event writer と schema は adapter の実装を知らない。

member event の entity/target ID は、#19 完了前の project member mutation では `<projectId>/<memberId>` とする。Workspace membership を導入するときも scope を ID に含め、同じ user の異なる scope を混同しない。

### Canonical Work Item

event builder は Work Item store と legacy project task table を直接参照せず、canonical mutation adapter が entity ID、before/after revision、field changes を返す。Team-owned Work Item mutation は `metadata.adapter=canonical-work-item` を保存し、公開契約も `WorkItem` に統一する。

`expectedRevision` は state transaction condition と event の `beforeRevision` / `afterRevision` に反映する。legacy project task は read compatibility と backfill sourceだけに限定し、新規 write を API code と Lambda IAM の両方で停止する。scope は ID と metadata の両方に保持し、別 Team/project の同名 ID を混同しない。詳細は [`work-items.md`](./work-items.md) を参照する。

## 運用確認

- mutation の成功 response より先に state/event transaction が成功していること。
- event/outbox を兼ねる `AuditEventsTable` の Point-in-Time Recovery を有効にすること。
- Stream iterator age、retry、DLQ、duplicate checkpoint 数を監視すること。
- audit export と backfill の実行者、filter、件数、correlation ID を別の運用 audit に残すこと。
- backfill 前後で source 件数、written/duplicate/skipped 件数を保存し、sample event の actor/target/diff/redaction を確認すること。
