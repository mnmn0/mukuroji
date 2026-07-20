# mukuroji API server

Hono で実装した API を、Bun development server と Node.js 22 Lambda の同じ app / route 契約で実行します。コマンドは repository root から実行してください。

## Source layout

- `src/app/`: Hono app の組み立て、middleware、route inventory、共通 error mapping
- `src/modules/<domain>/`: domain ごとの application port、use case、inbound/outbound adapter
- `src/infrastructure/`: 業務知識を持たない runtime config と AWS transport type
- `src/handlers/`: CDK と package script が参照する薄い Lambda entrypoint
- `scripts/backfills/`: HTTP route を経由しない再実行可能な backfill

`src/index.ts` は互換用の公開 re-export だけを持ちます。Bun と Lambda は
`src/handlers/` を entrypoint とし、`createApp(dependencies)` へ instance ごとの依存を渡します。
環境変数の共通 default と production validation は
`src/infrastructure/config/server-config.ts` が所有します。各 module の外部公開面は
`src/modules/<domain>/index.ts` に集約し、module 内部では具体的な sibling file を参照します。

## Local development

初回起動前に `openssl rand -hex 32` を3回実行し、それぞれ独立した64桁小文字hex出力を
git管理外の repository root `.env` に次の形式で保存します。Docker Compose はこれらを
Floci containerへ明示的に渡します。
保存後は `chmod 600 .env` でowner以外からの読み取りを禁止してください。

```dotenv
MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=<64-character-lowercase-hex-output>
ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=<different-64-character-lowercase-hex-output>
ENTERPRISE_SSO_STATE_SECRET=<third-64-character-lowercase-hex-output>
```

```sh
bun install
bun run floci:up
set -a
. .floci/generated/cognito.env
set +a
bun run server:dev
```

server は既定で `http://localhost:4566` の Floci Cognito / DynamoDB に接続します。
Ready hook は password/API 用 `mukuroji-web-local` と Hosted UI SSO 専用
`mukuroji-sso-local` を別の public client として作成します。
`.floci/generated/cognito.env` は Cognito endpoint、両 client ID、SSO callback などの非secret値を保持し、native Linuxの
host userからも読み込めます。Workspace access audit、enterprise credential digest、SSO state に必要な
固定 secret はこのfileへ複製せず、API writer、backfill、local backend がowner-onlyのroot `.env`から
読み込みます。

health check は `GET http://localhost:3000/api/health` です。Public Request Form / requester reply と `POST /api/auth/login` 以外の application API は、Cognito access token を `Authorization: Bearer <token>` で受け取ります。

## API path contract

Hono app 内の canonical path は `/api` prefix 付きです。Lambda adapter は Function URL / API Gateway から届く prefix なしの path を canonical path へ正規化するため、次の 2 つは同じ route を呼びます。

- `<base-url>/teams/projects`
- `<base-url>/api/teams/projects`

Bun server は canonical path を直接公開するため `http://localhost:3000/api/...` を使います。Lambda では base URL に `/api` を含めても含めなくてもよく、同一 request 内で prefix を重ねて `/api/api/...` にしないでください。

主な route:

- `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/auth/sso/discovery`,
  `POST /api/auth/sso/start`, `POST /api/auth/sso/exchange`
- `GET /api/dashboard/summary`
- `/api/analytics/query`, `/api/analytics/evidence`, `/api/analytics/export`
- `/api/analytics/reports`, `/api/analytics/reports/{reportId}/snapshots`
- `POST /api/teams`, `GET /api/teams/projects`
- `/api/teams/{teamId}/issues`
- `/api/teams/{teamId}/issues/{issueId}/collaboration`, `/comments`, `/watch`, `/presence`
- `/api/projects/{projectId}/tasks`, `/issues`, `/members`, `/users`, `/watch`
- `/api/notifications`, `/api/notifications/unread-count`, `/api/notification-preferences`
- `/api/request-forms`, `/api/request-queue`, `/api/request-submissions/{submissionId}`
- `/api/request-intake/{token}`, `GET /api/request-threads/{threadToken}`, `/api/request-threads/{threadToken}/replies`
- `GET /api/enterprise/security` と `/api/enterprise/security/*` の管理 mutation
- `/api/scim/v2/{workspaceId}/ServiceProviderConfig`,
  `/api/scim/v2/{workspaceId}/Users`, `/api/scim/v2/{workspaceId}/Groups`
- `GET /api/audit/events`, `GET /api/audit/events/export`
- `/api/documents`, `/api/documents/{documentId}/operations`, `/comments`, `/presence`, `/versions`, `/shares`, `/export`
- `/api/public/documents/{token}`, `/api/document-backlinks`

The local API reads DynamoDB through `DYNAMODB_ENDPOINT`, `AWS_ENDPOINT_URL_DYNAMODB`, or `AWS_ENDPOINT_URL`.
Default local table names are:

- `MUKUROJI_DASHBOARD_TABLE=mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE=mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE=mukuroji-project-directory-local`
- `MUKUROJI_COLLABORATION_TABLE=mukuroji-collaboration-local`
- `MUKUROJI_DOCUMENTS_TABLE` / `DOCUMENTS_TABLE_NAME`（未指定時は `mukuroji-documents-local`）
- `DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET`（public link の冪等再送用 HMAC key。本番 CDK は 64 文字の secret を自動生成）
- `MUKUROJI_NOTIFICATIONS_TABLE=mukuroji-notifications-local`
- `NOTIFICATIONS_STATUS_INDEX_NAME=RecipientStatusIndex`
- `MUKUROJI_REALTIME_SESSIONS_TABLE=mukuroji-realtime-sessions-local`
- `MUKUROJI_AUDIT_EVENTS_TABLE=mukuroji-audit-events`
- `ENTERPRISE_IDENTITY_TABLE_NAME=mukuroji-enterprise-identity-local`（Workspace generation/`CONTROL`
  checkpoint と global domain claim を保存。Enterprise Identity 専用 GSI はありません）
- `ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=<32–256文字の安定したsecret>`（credential
  kind・Workspace・credential ID で domain-separated な digest と10分の response recovery に使用）
- `ENTERPRISE_SSO_STATE_SECRET=<別の32–256文字の安定したsecret>`
- `COGNITO_CLIENT_ID=<password/API用public client ID>`
- `COGNITO_SSO_CLIENT_ID=<Hosted UI SSO専用public client ID>`（通常 client と同じ値は拒否）
- `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_SSO_REDIRECT_URI`, `COGNITO_ENTERPRISE_IDP_NAME`
  （Cognito Hosted UI federation。Local callback の既定値は
  `http://localhost:5173/auth/sso/callback`）
- `PLANNING_TABLE_NAME=mukuroji-planning-local`
- `ANALYTICS_TABLE_NAME=mukuroji-analytics-local`
- `ANALYTICS_SCHEDULE_INDEX_NAME=ScheduleDueIndex`
- `MUKUROJI_WORKSPACE_SEARCH_TABLE` / `WORKSPACE_SEARCH_TABLE_NAME`（未指定時は `mukuroji-workspace-search-local`）
- `MUKUROJI_AUDIT_RETENTION_DAYS=2555`
- `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=<64桁の小文字hex固定key>`（`openssl rand -hex 32` などで生成し、API と backfill で共有して通常は rotation しない）
- `MUKUROJI_WORKSPACE_DIRECTORY_ID=workspace#mukuroji-local`
- `MUKUROJI_WORKSPACE_ACCESS_TABLE=mukuroji-workspace-access-local`
- `REQUEST_INTAKE_TABLE_NAME=mukuroji-request-intake-local`
- `REQUEST_QUEUE_INDEX_NAME=RequestQueueIndex`
- `REQUEST_RATE_LIMIT_PER_HOUR=10`
- `MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES=<comma-separated proxy addresses>`（Bun server で列挙した transport source から到達した場合だけ `X-Forwarded-For` を rate-limit key に使用。未設定時は転送headerを信頼しない）
- `REQUEST_TOKEN_HASH_SECRET=<32文字以上のsecret>`（Lambda では必須）
- `REQUEST_EMAIL_WEBHOOK_SECRET=<32文字以上のsecret>`（専用 email ingestion Lambda で必須）

Project directory rows are scoped by the authenticated Cognito user's Workspace claims.
The local Floci seed writes `workspace#mukuroji-local` to both `custom:directory_id` and
`custom:workspace_id`. Project task rows are queried by
`workspace#mukuroji-local#project#<projectId>`.

API の access-token validator は `client_id` が `COGNITO_CLIENT_ID` または
`COGNITO_SSO_CLIENT_ID` に完全一致する token だけを受け入れます。SSO enforcement 対象では、
SSO client の token であることに加え、code exchange 時に server が access-token digest と
provider revision へ記録した authentication assurance を要求します。Token claim に同名の marker を
埋め込むだけでは SSO session になりません。

Floci は外部 SAML/OIDC federation 自体を模擬しませんが、local password auth と OAuth SSO の
境界を保つため専用 client metadata は常に作成します。`COGNITO_ENTERPRISE_IDP_NAME` がない場合の
local placeholder は `COGNITO` provider を使いますが、enterprise federation 設定が揃わないため
SSO start/exchange と enforcement は利用できません。

Planning records use `PLANNING_TABLE_NAME` and the production-compatible
`workspaceId` / `recordKey` key schema. CDK supplies the deployed `PlanningTable`
name to the API Lambda through the same environment variable.

Analytics report、immutable snapshot、scheduled delivery receipt は
`ANALYTICS_TABLE_NAME` の `workspaceId` / `recordKey` に保存します。定期配信対象は
`ANALYTICS_SCHEDULE_INDEX_NAME` の `scheduleShard` / `nextDeliveryAtRecordKey` で取得します。
API は Team partition の canonical Work Item を archived row も含めて読み、current ACL を
確定してから、同じ Team/Work Item entity ID の audit event を `EntityOccurredAtIndex` から
request 読み取り時点まで取得します。Legacy raw ID は metadata またはcanonical targetで
current authorized Work Itemへ一意に解決し、存在するidentity sourceがすべて一致するeventだけを
採用します。
Analytics engine は `asOf` より後の project/archive/status event を巻き戻して historical state を
復元します。`asOf`時点のProjectがcurrent active/readable Project集合の外なら、現在は別の
参照可能Projectに移動済みでも集計しません。現在削除済み、またはcallerのcurrent ACL外になった
itemも集計しません。
Work Item は Team partition 100件、1 partition/合計10,000件、対象Work Itemのaudit eventは
返却合計10,000件、canonical/legacy rawを合わせたidentity timeline 500件、全timeline合計
500 page query、1 identityあたり100 pageを上限とします。raw ID eventが認可・identity
整合性チェックで除外される場合もpage queryと返却eventの上限を消費します。超過時は部分結果を
返さず`413`でfail-closedにします。raw IDが重複しない通常構成では1 Work Itemあたり2 timelineを
確認するため、250件を超える場合はaudit read前にfail-fastします。
無関係なWorkspace historyはevent合計上限を消費しません。
Metric定義、timezone、archive、snapshot、scheduleの詳細は
[`docs/analytics.md`](../docs/analytics.md) を参照してください。

To preview and run the append-only audit backfill against local DynamoDB:

```sh
set -a
. .floci/generated/cognito.env
set +a
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --source workspace-access --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --checkpoint /tmp/mukuroji-audit-backfill-v2.json
```

`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` はgenerated fileではなくowner-onlyのroot
`.env`から読み込みます。未設定または形式不正なら、backfillは開始前にfail-closedで停止します。

The write run bootstraps `mukuroji-audit-events` with the production-compatible
keys, GSIs, and stream when the local table does not exist. Dry runs do not
create the table or write events/checkpoints. The `workspace-access` source maps
`workspace-member` and `workspace-invitation` rows to suppressed snapshot events;
the Workspace metadata row is counted as ignored, while unknown or malformed
lifecycle rows stop the run. Workspace timestamps must use canonical UTC ISO
format. Dry-run logs omit entity and target IDs.

AWS runs require `WORKSPACE_ACCESS_TABLE_NAME` in addition to the existing source
table variables and `AUDIT_EVENTS_TABLE_NAME`. Audit backfill checkpoint v2 adds
the Workspace access source and is not compatible with a v1 checkpoint. Use a new
checkpoint path; rescanning older sources is safe because event writes are
deterministic and conditional. The default v2 checkpoint is
`./audit-event-backfill-v2.checkpoint.json`; it is created with owner-only
permissions because its `LastEvaluatedKey` can contain source identifiers. Delete
it after the migration is complete. Checkpoints created with the pre-hex-decoding
Workspace access ID contract are rejected by the configuration hash. Unknown-timestamp snapshot events omit TTL so
they are not immediately deleted.

## Workspace search backfill

Workspace search は `WorkspaceSearchTable` の `workspaceId` / `recordKey` に、検索文書、
saved view、ユーザーごとの view preference を保存します。既存データを検索文書へ投影する前に、
まず dry-run で Team、Project、canonical Work Item、comment の mapping と skip 件数を確認します。

```sh
AWS_ENDPOINT_URL=http://localhost:4566 bun run search:backfill -- --dry-run
AWS_ENDPOINT_URL=http://localhost:4566 bun run search:backfill
```

一つの source だけを調査する場合は `--source project-directory`、
`--source work-items`、`--source collaboration` を指定できます。`--limit 100` は
dry-run や小さな検証 run で scan 件数を制限します。

AWS 環境では次の table 名を明示します。

```sh
export PROJECT_DIRECTORY_TABLE_NAME=<ProjectDirectoryTableName>
export WORK_ITEMS_TABLE_NAME=<WorkItemsTableName>
export COLLABORATION_TABLE_NAME=<WorkItemCollaborationTableName>
export DOCUMENTS_TABLE_NAME=<DocumentsTableName>
export WORKSPACE_SEARCH_TABLE_NAME=<WorkspaceSearchTableName>

bun run search:backfill -- --dry-run
bun run search:backfill
```

各検索文書の key は entity type と canonical entity ID から決定され、put/delete は同じ key に
適用されます。そのため、失敗後や source 更新後も同じコマンドを安全に再実行できます。
Soft delete 済み comment と archived Team/Project は、再実行時に対応する検索文書を削除します。
同じ `issueId` が複数 Team に存在しても、Work Item と comment の entity ID は Team scope を
含むため混在しません。

Backfill は checkpoint を保存せず、再実行時は選択した source の先頭から読み直します。
Source の更新と projection が競合すると古い scan 結果を一時的に再投影し得るため、本番では
書き込みを止めた maintenance window で実行し、API の live projection を有効化した後に
もう一度 backfill を完走してから書き込みを再開してください。

現時点では file の保存元は未導入のため、file は backfill 対象になりません。
Work Item は canonical row の `creatorMemberKey`、`workflowStatusId`、`customFieldValues`、
`relationIds` を検索文書の `creatorUserId`、`status`、`customFields`、`relationIds` へ投影します。
旧 `customFields` や必須 canonical field を欠く row は変換せず、invalid source として扱います。

Document は mutation のたびに current snapshot を検索文書へ live projection します。
Detail polling は検索 table へ書き込みません。既存 Document の再同期や一時障害後の
reconciliation は
`bun run search:backfill -- --source documents` で実行できます。Archived Document は対応する
検索文書を削除し、malformed row や version/receipt row は fail-closed で skip します。

Runtime API は `GET /api/search?filters=<JSON>&cursor=<opaque>&limit=<count>` と、
`GET|POST /api/saved-views`、`PATCH|DELETE /api/saved-views/{viewId}` を提供します。
DELETE は `expectedRevision` query parameter を必須とし、saved view definition の更新・削除は
revision が競合した場合に `SavedViewRevisionConflict` を返します。
