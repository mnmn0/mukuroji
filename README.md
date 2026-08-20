# mukuroji

mukuroji は、プロジェクトやタスクの進捗をチームで見渡すための進捗管理アプリケーションです。

このリポジトリは Bun workspaces で構成されています。依存関係と lockfile はルートで管理します。

## 構成

- `web/`: React + TypeScript + Vite のフロントエンド
- `server/`: Hono + Bun の API サーバー
- `cdk/`: AWS CDK TypeScript プロジェクト
- `docs/`: ドキュメント

SLO、alarm、incident response、migration、deploy、restore drill の運用契約は
[`docs/operational-readiness.md`](docs/operational-readiness.md) を参照してください。

## セットアップ

```sh
bun install
```

ローカル環境を初めて起動する前に `openssl rand -hex 32` を3回実行し、それぞれ独立した
64桁の小文字hex出力をgit管理外の `.env` に保存してください。Docker Compose が Floci
コンテナへ渡すのは Workspace audit key だけで、ready hook がその形式を検証します。
Enterprise credential/state secret は host 上の `server:dev` と `floci:deploy-backend` が
`.env` から直接読み込み、Floci コンテナには渡しません。保存後は `chmod 600 .env` で
owner以外からの読み取りを禁止してください。

```dotenv
MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=<64-character-lowercase-hex-output>
ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET=<different-64-character-lowercase-hex-output>
ENTERPRISE_SSO_STATE_SECRET=<third-64-character-lowercase-hex-output>
```

Codex cloud のカスタムセットアップスクリプトには、以下を指定できます。

```sh
bash scripts/codex-setup.sh
```

検証まで実行したい場合は `CODEX_VALIDATE=1 bash scripts/codex-setup.sh` を使います。

レビュー Skill の source は `.codex/skills/mukuroji-review` で管理します。この場所は
repository-scoped Skill の自動検出先ではなく、reviewer instructions を branch-controlled
なセットアップ処理から書き換えないため、`scripts/codex-setup.sh` も Skill を自動同期
しません。

personal scope へ導入するときは、変更が trusted な default branch へ merge された後に
Codex の Skill installer へ以下を明示してください。

- GitHub repository: `mnmn0/mukuroji`
- path: `.codex/skills/mukuroji-review`
- ref: `main`

feature branch や可変な PR head から直接インストールしないでください。installer は同名の
導入先が既に存在すると停止するため、更新時は現在の
`$CODEX_HOME/skills/mukuroji-review` を `$CODEX_HOME/skills` の外にある backup 先へ
移動してから、`ref: main` を明示して再導入します。導入に失敗した場合は backup を元の
場所へ戻してください。レビュー開始前には `origin/main` の使用する commit OID を固定し、
その commit の Skill tree と installed copy の全ファイルが一致することを確認して
ください。欠落や差分がある場合はレビューを開始せず、trusted source から更新します。

source 自体を変更した場合は次の検証を実行します。

```sh
bun run skill:validate
bun run skill:validate:test
git diff --check
```

trusted validator とその test、`review-skill.yml`、またはレビュー必須条件を持つ root /
nested `AGENTS.md` を変更する PR では、default branch 側の
`pull_request_target` workflow が変更前の validator と negative tests を使って対象
Skill を検証します。全階層の `AGENTS.md` の追加・変更・削除も trust-root 変更として
扱います。これらの trust root の変更を merge するには、内容を独立レビューした
repository maintainer が現在の head commit SHA 全体を含む
`review-ok:<full-head-sha>` label を付ける必要があります。Skill tree 自体の変更もこの
承認対象です。workflow は、その完全一致 label を PR author 以外の label 権限を持つ
user が付けた最新 event だけを承認として受け入れます。
さらに GitHub の collaborator permission API で、その user の現在の base permission が
`write` または `admin` であることを検証します（`maintain` は同 API で `write` に
対応します）。head が更新されると別の label が必要になり、該当 label を外すと承認も
無効になります。無関係な label 操作は承認状態を変えません。PR の本文や変更ファイル内の
同名文字列、bot、PR author、read / triage 権限だけの user が付けた label は承認として
扱われません。

## 開発

Floci + Cognito + DynamoDB:

```sh
bun run floci:up
```

`4566` が既に使われている場合は host 側の port を変更できます。

```sh
FLOCI_PORT=4567 bun run floci:up
set -a
. .floci/generated/cognito.env
set +a
bun run server:dev
```

Floci の ready hook がローカル Cognito と Workspace を初期化します。作成される初期 owner は以下です。

- メールアドレス: `demo@example.com`
- パスワード: `Password123!`

API サーバーはデフォルトで `http://localhost:4566` の Floci Cognito に接続し、
`mukuroji-local` user pool、password/API 用の `mukuroji-web-local` public client、
Hosted UI SSO 専用の `mukuroji-sso-local` public client を自動検出します。両 client ID は必ず異なり、
SSO client は authorization-code flow、`openid email profile` scope、local callback だけを持ちます。
初期 owner を含む local user の `custom:directory_id` と `custom:workspace_id` は、どちらも
`workspace#mukuroji-local` に設定されます。生成された両 client ID と callback は
`.floci/generated/cognito.env` に出力されます。
この generated file は native Linux の host user からも読み込めるよう非secret値だけを含め、
secret は owner-only の root `.env` だけに保持します。Workspace audit key だけを ready hook
へ渡し、Enterprise credential/state secret は関連する root package scripts が
`--env-file=.env` を指定して host process へ明示的に渡します。

同じ ready hook で DynamoDB table `mukuroji-dashboard-local`,
`mukuroji-team-issues-local`, `mukuroji-project-directory-local`,
`mukuroji-workspace-access-local`, `mukuroji-enterprise-identity-local`,
`mukuroji-workspace-search-local`, `mukuroji-analytics-local` も作成し、
ダッシュボード集計、canonical Work Item、
サイドバー用チーム/プロジェクト階層、Workspace metadata/member を投入します。
Analytics table は保存済みレポート、immutable snapshot、定期配信 receipt を保持し、
`ScheduleDueIndex` で配信対象を取得できる本番同等の key schema を使います。
チーム/プロジェクト階層は `workspace#mukuroji-local` partition に seed され、Project Issue API はその directory に含まれる project だけを返します。
Workspace access table では `demo@example.com` を active owner、既存の project user を
active member、`viewer@example.com` を active guest として初回だけ seed します。
ready hook の再実行は既存 role/status を上書きしないため、利用停止した member が
Floci 再起動で自動的に再有効化されることはありません。

Floci 上の Lambda + API Gateway に backend をデプロイする場合:

```sh
bun run floci:up
bun run floci:deploy-backend
```

`floci:deploy-backend` は `server/src/index.ts` を Node.js 22 Lambda 用に bundle し、Floci の REST API Gateway から Lambda に proxy します。React から Lambda 経由 API を呼ぶ場合は、生成された `.floci/generated/backend.env` の `VITE_API_BASE_URL` を使います。Deploy script は ready hook が生成した `ANALYTICS_TABLE_NAME` と `ANALYTICS_SCHEDULE_INDEX_NAME` を Lambda に渡します。また、確定した REST API URL を `AUTOMATION_INBOUND_WEBHOOK_BASE_URL` として Lambda にも渡し、Secrets Manager の内部 HTTP endpoint と明示的な `MUKUROJI_LOCAL_AWS_RUNTIME=floci` marker を組にして渡します。管理 API が返す signed inbound webhook URL は sender から到達可能な同じ API を指します。Lambda adapter は `/teams/projects` のような直下パスと `/api/teams/projects` の両方を同じ Hono route へ正規化します。

Floci は CloudFormation を使わず、production の4分割 API runtime configuration secret
pointerを渡さないため、`ApiRuntimeConfigurationRevision` は使いません。Local Lambdaには
completeなdiscrete environmentを直接設定し、このfallbackをproduction deployへ流用しません。

停止:

```sh
bun run floci:down
```

Web アプリ:

```sh
bun run web:dev
```

Storybook:

```sh
bun run web:storybook
```

API サーバー:

```sh
set -a
. .floci/generated/cognito.env
set +a
bun run server:dev
```

ローカルでログインまで確認する場合は、別ターミナルで以下を起動してください。

```sh
bun run floci:up
set -a
. .floci/generated/cognito.env
set +a
bun run server:dev
bun run web:dev
```

Web は Vite の proxy 経由で `/api` を `http://localhost:3000` に転送します。必要に応じて以下の環境変数を上書きできます。

- `VITE_API_BASE_URL`: ブラウザから呼ぶ API の base URL。未指定時は `/api`
- `VITE_PROJECTS_API_BASE_URL`: DynamoDB のチーム/プロジェクト階層を取得する Lambda Function URL。未指定時は `VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_WORKSPACE_API_BASE_URL`: 本番環境で Workspace member / invitation API を呼ぶ base URL。未指定時は `VITE_PROJECTS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_ENTERPRISE_IDENTITY_API_BASE_URL`: Enterprise identity/security 管理 API を呼ぶ base URL。未指定時は `VITE_WORKSPACE_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_ISSUER`: access token の expected issuer。local ready hook が生成する値を利用します。本番では CDK の user pool から解決します。
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: trust する User Pool と password/API 用 public client ID
- `COGNITO_SSO_CLIENT_ID`: Hosted UI SSO 専用 public client ID。`COGNITO_CLIENT_ID` と同じ値は拒否します。API は access token の `client_id` がこの2値のいずれかに完全一致する場合だけ受け入れます。
- `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_SSO_REDIRECT_URI`, `COGNITO_ENTERPRISE_IDP_NAME`: Cognito authorization-code + PKCE の enterprise federation 設定。Local callback の既定値は `http://localhost:5173/auth/sso/callback`
- `COGNITO_SSO_USER_POOL_CLIENT_NAME`: Floci が作る SSO client 名。未指定時は `mukuroji-sso-local`
- `ENTERPRISE_SSO_STATE_SECRET`: SSO state 署名専用の 32–256 文字 secret
- `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL_DYNAMODB` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci DynamoDB endpoint。未指定時は `http://localhost:4566`
- `MUKUROJI_DASHBOARD_TABLE`: ダッシュボード集計値を保存する DynamoDB table 名。未指定時は `mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE`: サイドバー用チーム/プロジェクト階層を保存する DynamoDB table 名。未指定時は `mukuroji-project-directory-local`
- `MUKUROJI_WORKSPACE_ACCESS_TABLE`: Workspace metadata、member、invitation lifecycle を保存する DynamoDB table 名。未指定時は `mukuroji-workspace-access-local`
- `MUKUROJI_TEAM_ISSUES_TABLE`: チーム所有 Issue を保存する DynamoDB table 名。未指定時は `mukuroji-team-issues-local`
- `MUKUROJI_WORK_ITEMS_TABLE` / `WORK_ITEMS_TABLE_NAME`: canonical Work Item store。移行期間は `MUKUROJI_TEAM_ISSUES_TABLE` / `TEAM_ISSUES_TABLE_NAME` と同じ既存 table を指します。
- `MUKUROJI_TEAM_ISSUE_EVENTS_TABLE`: チーム Issue のコメント/活動履歴を保存する DynamoDB table 名。未指定時は `mukuroji-team-issue-events-local`
- `MUKUROJI_COLLABORATION_TABLE` / `COLLABORATION_TABLE_NAME`: comment thread、reaction、watcher、presence を保存する DynamoDB table 名。未指定時は `mukuroji-collaboration-local`
- `MUKUROJI_DOCUMENTS_TABLE` / `DOCUMENTS_TABLE_NAME`: Document tree、version、comment、presence、share、backlink を保存する DynamoDB table 名。未指定時は `mukuroji-documents-local`
- `MUKUROJI_WORKSPACE_SEARCH_TABLE` / `WORKSPACE_SEARCH_TABLE_NAME`: Workspace search document、saved view、ユーザー別 view preference を保存する DynamoDB table 名。未指定時は `mukuroji-workspace-search-local`
- `WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME`: Workspace Search migration の durable state、authority、application writer-fence row を保存する DynamoDB table 名。本番 writer runtime では必須です。
- `MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE`: 本番CDKはCloudFormation parameter `WorkspaceSearchWriterFenceMode` で `rollout-pending` / `required` の明示選択を要求します。`rollout-pending` は初回open row bootstrap前にAppConfigを`disabled`としてwriter drainを実測した期間だけ使う一時的なproduction bridgeで、このmode自体も対象tableへのmutationをSDK middlewareで拒否します。通常運用やmigration実行には使いません。Bootstrap後は全Lambdaの`required`反映を確認してから再開します。Floci deployだけが、local HTTP DynamoDB/Secrets Manager endpointと`MUKUROJI_LOCAL_AWS_RUNTIME=floci`を併用して`local-floci-bypass`を設定します。
- `ANALYTICS_TABLE_NAME`: 保存済みレポート、immutable snapshot、定期配信 receipt を保存する DynamoDB table 名。未指定時は `mukuroji-analytics-local`
- `ANALYTICS_SCHEDULE_INDEX_NAME`: 定期配信対象の取得に使う `scheduleShard` / `nextDeliveryAtRecordKey` GSI 名。未指定時は `ScheduleDueIndex`
- `MUKUROJI_NOTIFICATIONS_TABLE` / `NOTIFICATIONS_TABLE_NAME`: ユーザー別の durable notification timeline と配信設定を保存する DynamoDB table 名。未指定時は `mukuroji-notifications-local`
- `PLANNING_TABLE_NAME`: Cycle、Milestone、Release、Phase、Goal/OKR、Initiative、Roadmap、Portfolio の Planning entity、entity dependency、qualified Work Item schedule dependency、Work Item link を保存する DynamoDB table 名。未指定時は `mukuroji-planning-local`
- `NOTIFICATIONS_STATUS_INDEX_NAME`: unread/read/archive/snooze ごとの timeline query に使う GSI 名。未指定時は `RecipientStatusIndex`
- `MUKUROJI_REALTIME_SESSIONS_TABLE` / `REALTIME_SESSIONS_TABLE_NAME`: WebSocket ticket と connection lease を保存する DynamoDB table 名。未指定時は `mukuroji-realtime-sessions-local`
- `REALTIME_WEBSOCKET_URL`: production の collaboration invalidation/presence 用 WebSocket URL。未指定時は Web が polling fallback を使います。
- `MUKUROJI_AUDIT_EVENTS_TABLE` / `AUDIT_EVENTS_TABLE_NAME`: immutable audit event/outbox を保存する DynamoDB table 名。ローカル既定値は `mukuroji-audit-events`
- `TENANT_ADMINISTRATION_TABLE_NAME`: tenant profile、entitlement、governance、lifecycle を保存する DynamoDB table 名。ローカル既定値は `mukuroji-tenant-administration-local`
- `ENTERPRISE_IDENTITY_TABLE_NAME`: Workspace generation/`CONTROL` checkpoint、global domain claim、SSO/domain/policy/role、SCIM identity/group、provisioning run、service account、break-glass metadata を保存する DynamoDB table 名。Enterprise Identity 専用 GSI はなく、ローカル既定値は `mukuroji-enterprise-identity-local`
- `ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET`: SCIM bearer token と service account credential を HMAC-SHA-256 する32–256文字の安定した secret。DynamoDB には credential kind・Workspace・credential ID で domain-separated な digest だけを保存します。作成・rotate response の raw credential は通常一回だけ表示し、同じ idempotency request の応答消失時に限り10分以内は同じ値を回復できます。
- `MUKUROJI_AUTOMATION_TABLE` / `AUTOMATION_TABLE_NAME`: rule/template/recurring/execution/bulk/template application に加え、inbound webhook endpoint と delivery/replay receipt を保存する DynamoDB table 名。ローカル既定値は `mukuroji-automation-local`
- `AUTOMATION_WEBHOOK_SECRET_PREFIX`: outbound webhook の workspace-scoped signing secret を置く Secrets Manager prefix。未指定時は `mukuroji/automation-webhooks`
- `AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX`: server-issued inbound webhook signing secret を outbound secret から分離して置く Secrets Manager prefix。未指定時は `mukuroji/automation-inbound-webhooks`
- `AUTOMATION_INBOUND_WEBHOOK_BASE_URL`: Sender に渡す inbound webhook URL の public API base URL。Server はこの値へ `/api/automation/inbound-webhooks/{opaqueEndpointId}` を追加します。HTTPS が必須で、HTTP は `localhost`、`127.0.0.1`、`[::1]` の loopback development host だけに許可します。Floci deploy では作成済み REST API ID と stage から自動設定します。
- `SECRETS_MANAGER_ENDPOINT` / `AWS_ENDPOINT_URL_SECRETS_MANAGER` / `AWS_ENDPOINT_URL_SECRETSMANAGER` / `AWS_ENDPOINT_URL`: API Lambda から見る Secrets Manager endpoint（左から優先）。AWS 接続では `AWS_REGION` と一致する standard/FIPS の HTTPS hostname だけを許可します。ローカル Lambda では Floci 内部 endpoint の `http://floci:4566` を使います。
- `MUKUROJI_LOCAL_AWS_RUNTIME`: `floci` のときだけ loopback、`localhost`、`floci`、`localstack` の HTTP Secrets Manager endpoint を許可する明示的な local marker。`floci:deploy-backend` が自動設定し、`NODE_ENV=production` では常に無効です。本番環境へ設定しないでください。
- `MUKUROJI_AUDIT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS`: audit event の保持日数。未指定時は 2555 日（7年）
- `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY`: Workspace/member/invitation の公開 audit ID を HMAC 化する、32-byte random値を表す64桁の小文字hex固定 key。本番では `openssl rand -hex 32` などで生成し、backfill と API で同じ値を使います。
- `MUKUROJI_WORKSPACE_DIRECTORY_ID`: Cognito claim と DynamoDB partition で共有する canonical Workspace ID。未指定時は `workspace#mukuroji-local`
- `MUKUROJI_PROJECT_DIRECTORY_ID`: 旧 local 設定との互換入力。`MUKUROJI_WORKSPACE_DIRECTORY_ID` が優先されます。
- `MUKUROJI_INITIAL_OWNER_EMAIL` / `MUKUROJI_INITIAL_OWNER_USERNAME`: 初期 owner の email と Cognito username
- `MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET`: email adapter envelope の署名検証に使う 32–256 文字の secret
- `MUKUROJI_REQUEST_TOKEN_HASH_SECRET`: request/reply capability の hash に使う別の 32–256 文字の secret

API サーバーは `/api/workspace/access`, `/api/dashboard/summary`, `/api/teams/projects`, `/api/work-items`,
`/api/teams/{teamId}/issues`, `/api/projects/{projectId}/issues`,
`/api/search`, `/api/saved-views`, `/api/audit/events`,
`/api/notifications`, `/api/documents`, `/api/automation/rules`, `/api/automation/templates`,
`/api/automation/inbound-webhooks`, `/api/recurring-work`,
`/api/automation/executions`, `/api/bulk-operations`, `/api/planning`,
`/api/auth/sso/discovery`, `/api/auth/sso/start`, `/api/auth/sso/exchange`,
`/api/enterprise/security`, `/api/scim/v2/{workspaceId}`,
`/api/analytics/query`, `/api/analytics/evidence`, `/api/analytics/reports`,
`/api/analytics/reports/{reportId}/snapshots`, `/api/analytics/export`
で各機能を提供します。ローカルでは Vite proxy により、
Web から `/api` を呼ぶだけで Floci 上の DynamoDB データを取得できます。

Analytics の権限、snapshot、schedule、forecast の契約は
[`docs/analytics.md`](docs/analytics.md) を参照してください。

Inbound webhook の管理 API は Workspace 管理者専用です。`/api/automation/inbound-webhooks` 以下で作成、pause/resume、rotate、revoke を行い、public sender は発行された `/api/automation/inbound-webhooks/{opaqueEndpointId}` へ署名済み JSON を POST します。Signing secret は create/rotate response で一度だけ返し、応答消失時の同一 key による recovery も 24 時間で失効します。Delivery idempotency receipt は、365 日保持する audit outbox の deterministic event ID 衝突期間を覆うため 400 日保持します。`provisioning` が完了しない場合は管理者が revoke して abort できますが、rotate 途中の abort も endpoint を終端失効させるため、Rule と sender を新しい endpoint へ再設定する必要があります。Revoke は durable cleanup intent を残し、即時削除後も schedule Lambda が inbound-only `DeleteSecret` 権限で 5 分間隔に recovery window 24 時間とその後の 5 分間の grace が終わるまで secret 削除を再試行し、期限直前に開始済みの late provisioning write も回収します。

Task / Issue の strict canonical schema、dynamic workflow、optimistic concurrency は
[`docs/work-items.md`](docs/work-items.md) を参照してください。

append-only event schema、activity/audit API、retention/redaction、consumer dedupe、backfill の契約は
[`docs/event-audit.md`](docs/event-audit.md) を参照してください。

Comment thread、mention/watch 通知、reaction、presence、realtime fallback の契約は
[`docs/collaboration.md`](docs/collaboration.md) を参照してください。

Notification event、Inbox state、filter/cursor、deep link、配信設定、期限通知の契約は
[`docs/notifications.md`](docs/notifications.md) を参照してください。

Versioned rule、signed inbound webhook、template、timezone/DST recurring、bulk dry-run/retry/undo、実行履歴の契約は
[`docs/automation.md`](docs/automation.md) を参照してください。

Cycle rollover、戦略階層、roll-up、timeline dependency、critical path の契約は
[`docs/planning.md`](docs/planning.md) を参照してください。

Request Form、public intake、queue/triage、attachment、email reply、Work Item conversion の契約は
[`docs/request-intake.md`](docs/request-intake.md) を参照してください。

SSO discovery、SCIM provisioning、custom role、MFA/session/IP policy、service account、
break-glass administrator の契約は
[`docs/enterprise-identity.md`](docs/enterprise-identity.md) を参照してください。

Document tree、block / whiteboard schema、同時編集、履歴、ACL、共有、検索、export の契約は
[`docs/documents.md`](docs/documents.md) を参照してください。

Web の mutation は operation と入力 fingerprint ごとに `MutationRequestContext` を1つ作り、同じ
in-flight request で共有します。transport failure 後は結果が不明な間だけ保持し、Workspace snapshot の
再取得に成功した時点で破棄します。自動再送は行わず、利用者の続行操作を新しい logical mutation として
扱います。Web API client の context 引数は必須です。

ローカル backfill は次の command で実行できます。本実行時は共通 bootstrap が未作成の
`mukuroji-audit-events` table を本番互換 schema で作成します。

```sh
set -a
. .floci/generated/cognito.env
set +a
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --checkpoint /tmp/mukuroji-audit-backfill-v2.json
```

`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` は generated file へ複製せず、API writer と
backfill の両方が owner-only の root `.env` から同じ値を読み込みます。
`ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET` と `ENTERPRISE_SSO_STATE_SECRET` も generated file
へ複製せず、local backend deploy と `server:dev` が root `.env` の安定値を共有します。
これら2つの Enterprise secret は ready hook や Floci コンテナへ渡しません。

CDK stack も同じタスクデータと指定した Workspace 用の
チーム/プロジェクト階層に加え、Workspace metadata と初期 active owner を
DynamoDB に idempotent に seed し、Lambda Function URL 経由で取得できます。
AWS 環境で確認する場合は以下の順に実行し、出力された `ApiFunctionUrl` を
Web の環境変数へ渡してください。

```sh
export COGNITO_USER_POOL_ID=<user-pool-id>
export COGNITO_USER_POOL_CLIENT_ID=<password-public-app-client-id>
export COGNITO_SSO_USER_POOL_CLIENT_ID=<dedicated-sso-public-app-client-id>
export COGNITO_HOSTED_UI_DOMAIN=<pool-prefix>.auth.<region>.amazoncognito.com
export COGNITO_SSO_REDIRECT_URI=https://app.example.com/auth/sso/callback
export COGNITO_ENTERPRISE_IDP_NAME=<cognito-idp-name>
export MUKUROJI_WORKSPACE_DIRECTORY_ID=<workspace-directory-id>
export MUKUROJI_INITIAL_OWNER_EMAIL=<owner@example.com>
export MUKUROJI_INITIAL_OWNER_USERNAME=<cognito-username>
export MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY="$(openssl rand -hex 32)"
export ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="$(openssl rand -hex 32)"
export ENTERPRISE_SSO_STATE_SECRET="$(openssl rand -hex 32)"
export MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET=<at-least-32-random-characters>
export MUKUROJI_REQUEST_TOKEN_HASH_SECRET=<different-at-least-32-random-characters>
export MUKUROJI_ALARM_PRIMARY_TOPIC_NAME=<primary-standard-sns-topic-name>
export MUKUROJI_ALARM_SECONDARY_TOPIC_NAME=<secondary-standard-sns-topic-name>
export MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION=2026-07-28-01
# 初回 writer-fence bootstrap 時のみ rollout-pending。
# 既存環境の再 deploy では required を指定します（required からの巻き戻しは禁止）。
export MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=rollout-pending
export MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN=arn:aws:iam::<account-id>:role/<data-owner-role>
export MUKUROJI_TASK_API_ALLOWED_ORIGINS=https://app.example.com

bash scripts/prepare-workspace-cognito.sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
# 初回の Team Issue event table GSI rollout は2段階です。
# まず event stage の diff と deploy を実行し、
# TeamIssueEventCreatedAtIndex が ACTIVE になったことを確認してから、
# 下記の最終 comment stage を実行します。
# 既存環境で event stage が完了済みの場合は、下記だけを実行します。
bun --filter cdk cdk diff CdkStack \
  -c triageIndexDeploymentStage=wake \
  -c teamIssueCommentIndexDeploymentStage=event \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters WorkspaceSearchWriterFenceMode="$MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE" \
  --parameters TaskApiAllowedOrigins="$MUKUROJI_TASK_API_ALLOWED_ORIGINS"

bun --filter cdk cdk deploy CdkStack \
  -c triageIndexDeploymentStage=wake \
  -c teamIssueCommentIndexDeploymentStage=event \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters WorkspaceSearchWriterFenceMode="$MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE" \
  --parameters TaskApiAllowedOrigins="$MUKUROJI_TASK_API_ALLOWED_ORIGINS"

bun --filter cdk cdk diff CdkStack \
  -c triageIndexDeploymentStage=wake \
  -c teamIssueCommentIndexDeploymentStage=comment \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters WorkspaceSearchWriterFenceMode="$MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE" \
  --parameters TaskApiAllowedOrigins="$MUKUROJI_TASK_API_ALLOWED_ORIGINS"
```

`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` は環境作成時に一度だけ `openssl rand -hex 32` などで生成し、64桁の小文字hex値を secret store に保存して、API deploy と audit backfill で再利用してください。通常の再 deploy で生成し直すと Workspace access の audit ID が変わります。

`MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION` は1〜32文字のdeploy識別子です。APIの
code、または4分割runtime configuration secretへ入るparameter/resource値を変更するdeployごとに
新しい値へ進め、同じrevisionを異なる内容へ再利用しません。初回導入では物理Lambdaが`-api-v2`へ
置換されるため、`ApiFunctionUrl`も変わります。
Function URL利用者は新しいstack outputへの計画的な切替が必要です。
`ApiGatewayUrl`は同じHTTP API endpointを維持し、default routeだけが新しい
`live` Aliasへ切り替わります。以後のdeployは新しいimmutable configuration secretとLambda
Versionの準備後に`live` Aliasでtrafficを切り替えます。旧secretは`Retain`されますが、
CloudFormationが自動で再接続・削除するものではないため、rollback/recovery evidenceとして管理します。
4分割secretはtransformを使わないv2 line envelopeでgroup identityと同一revisionを保持し、各値は
canonical Base64として保存します。NoEchoの4値はrevision-boundな個別retained secretへ直接保存し、
Document public-share secretとともにenvelopeにはARNだけを入れます。APIは4 group、同一revision、
全canonical key、nested secret ARN/valueをすべて検証してから環境へ原子的に反映します。

`MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=rollout-pending` は初回writer-fence
bootstrap前の一時値です。このdeployはAppConfigの初期baselineを`disabled`にし、controlled
Lambdaはその反映完了後に更新されます。Webhook authorization backfillのCreate/Updateはpending中に
tableへ触れません。Deleteはread-onlyでv3 migration stateが空であることを確認して短絡し、既存stateが
あればdurable open-row guard付きtransactionでrollbackを完了するまで削除を成功させません。
Application clientもpending中は通常のfenced mutationをnetwork I/O前に拒否するため、
AppConfigが誤って`enabled`へ戻ってもunguarded writeを通しません。反映とwriter drainを確認した状態でopen rowをbootstrapし、全Lambdaを
`required`へ更新してguarded backfillを完了させてから、新しい`enabled` revisionでwriterを
再開してください。通常deployで`required`から`rollout-pending`へ戻してはいけません。

SSO client は password client とは別に作成し、client secret なし、
`ExplicitAuthFlows=ALLOW_REFRESH_TOKEN_AUTH` のみ、OAuth server 有効、flow は `code` のみ、
scope は `openid email profile` のみ、callback は `COGNITO_SSO_REDIRECT_URI` の1件だけにします。
`SupportedIdentityProviders` も `COGNITO_ENTERPRISE_IDP_NAME` の1件だけとし、native login の
`COGNITO` を含めないでください。通常の password client に federation を同居させると、password login
で得た code を SSO exchange へ持ち込めるため、この構成は fail-closed で拒否されます。

Lambda Function URL の CORS 許可 origin は CDK parameter
`TaskApiAllowedOrigins` で指定します。未指定時は
`http://localhost:5173,http://127.0.0.1:5173` です。
認証に使う Cognito user pool は CDK parameter `CognitoUserPoolId` で固定し、
Lambda は access token の issuer がその user pool と一致する場合だけ処理します。
Workspace partition は `WorkspaceDirectoryId`、初期 owner の小文字メールアドレスは
`InitialOwnerEmail` で指定します。Cognito の
`custom:directory_id` / `custom:workspace_id` は `WorkspaceDirectoryId` と一致させてください。
同じ Function URL から `/teams/projects`, `/teams/{teamId}/issues`,
`/projects/{projectId}/issues`,
`/api/workspace/access` などの Workspace invitation API も取得できます。

### Workspace invitation lifecycle

Workspace member と Cognito identity は分離して管理します。Cognito 認証に成功しても、
Workspace access table の member が `active` でなければ、Lambda はすべての業務 API を
`403` で拒否します。`deactivated` member や、`pending` / `revoked` invitation だけが残る
user は Project、Work Item、Issue API を利用できません。

招待 API は以下です。Lambda Function URL では `/api` prefix の有無をどちらも受け付けます。

- `GET /api/workspace/access`: current member、member/invitation 一覧、操作 capability
- `POST /api/workspace/invitations`: invitation 作成
- `POST /api/workspace/invitations/{email}/resend`: invitation 再送
- `POST /api/workspace/invitations/{email}/revoke`: invitation 取消
- `POST /api/workspace/invitations/{email}/cleanup/acknowledge`: Cognito の手動 cleanup 完了確認（`expectedVersion` 必須）
- `POST /api/workspace/invitations/{email}/reinvite`: 期限切れ・取消済み invitation の再招待
- `PATCH /api/workspace/members/{email}`: `expectedVersion` 付き role/status 更新

invitation は `provisioning`, `pending`, `delivery-failed`, `expired`, `revoked`,
`accepted` の状態を持ちます。Cognito user の ownership は `workspace-created`,
`pre-existing`, `ambiguous` で保存します。取消時に Cognito user を削除できるのは
`workspace-created` の未受諾 user だけです。`pre-existing` と、Cognito 作成成功後の
DynamoDB 確定失敗が疑われる `ambiguous` user は削除しません。

Cognito 成功後に DynamoDB 更新だけが失敗した場合、invitation は
`provisioning` / `ambiguous` から安全に再送できます。`NEW_PASSWORD_REQUIRED` 完了後の
membership 確定失敗は通常ログイン時にも再照合されるため、同じ password で再ログインして
復旧できます。owner の降格・利用停止は metadata の active owner count と member version を
同じ DynamoDB transaction で更新し、最後の active owner と自己停止を拒否します。

deploy 後は Function URL または API Gateway URL の output を Web に設定します。どちらも base URL の直下パスと `/api` prefix を受け付けます。

```sh
VITE_API_BASE_URL=<ApiFunctionUrl>
```

fresh deploy、既存 stack upgrade、bootstrap 検証、rollback、PITR recovery の手順は [cdk/README.md](./cdk/README.md) を参照してください。

`PROJECT_DIRECTORY_ID` には CDK parameter `WorkspaceDirectoryId` と同じ値を指定します。
チーム/プロジェクト階層の table 名は CDK output の
`ProjectDirectoryTableName` で確認できます。

チーム所有 Issue の table と GSI を直接確認する場合は、CDK output の
`TeamIssuesTableName` と `TeamIssueEventsTableName` を指定して以下を実行します。
`ISSUE_ID` を指定すると、その Issue のコメント/活動履歴 table も query します。

```sh
TEAM_ISSUES_TABLE_NAME=<TeamIssuesTableName> \
TEAM_ISSUE_EVENTS_TABLE_NAME=<TeamIssueEventsTableName> \
bun run issues:check-dynamodb

TEAM_ISSUES_TABLE_NAME=<TeamIssuesTableName> \
TEAM_ISSUE_EVENTS_TABLE_NAME=<TeamIssueEventsTableName> \
ISSUE_ID=<IssueId> \
bun run issues:check-dynamodb
```

CDK stack の demo seed は stack 作成時だけ、`WorkItemsTableName` が指す canonical store へ
`schemaVersion=2`, `revision=1` で投入します。手動 seed はローカル Floci 専用で、canonical store
だけを対象とし、既存 row は conditional write で保持します。

```sh
DYNAMODB_ENDPOINT=http://localhost:4566 \
MUKUROJI_LOCAL_AWS_RUNTIME=floci \
WORK_ITEMS_TABLE_NAME=<LocalWorkItemsTableName> \
bun run work-items:seed-dynamodb
```

この legacy seed は remote AWS endpointや未指定endpointでは停止します。本番データは guarded API/
workerまたは認可済みmigration workflowからだけ変更します。Canonical Work Item は現行 workflow
schema の必須 field をすべて持つ row だけを読みます。開発中の古い row は自動変換せず、削除して現行
seed または API から作り直します。

## 検証

Web:

```sh
bun run web:lint
bun run web:build
bun run web:build-storybook
```

CDK:

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

## 依存管理

依存追加や更新はルートから実行してください。`bun.lock` はルートに集約し、各 workspace 配下には追加しません。

```sh
bun install
```

## エージェント向け補足

作業ルールは [AGENTS.md](./AGENTS.md) を参照してください。
