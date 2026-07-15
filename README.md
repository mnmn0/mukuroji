# mukuroji

mukuroji は、プロジェクトやタスクの進捗をチームで見渡すための進捗管理アプリケーションです。

このリポジトリは Bun workspaces で構成されています。依存関係と lockfile はルートで管理します。

## 構成

- `web/`: React + TypeScript + Vite のフロントエンド
- `server/`: Hono + Bun の API サーバー
- `cdk/`: AWS CDK TypeScript プロジェクト
- `docs/`: ドキュメント

## セットアップ

```sh
bun install
```

Codex cloud のカスタムセットアップスクリプトには、以下を指定できます。

```sh
bash scripts/codex-setup.sh
```

検証まで実行したい場合は `CODEX_VALIDATE=1 bash scripts/codex-setup.sh` を使います。

## 開発

Floci + Cognito + DynamoDB:

```sh
bun run floci:up
```

`4566` が既に使われている場合は host 側の port を変更できます。

```sh
FLOCI_PORT=4567 bun run floci:up
COGNITO_ENDPOINT=http://localhost:4567 bun run server:dev
```

Floci の ready hook がローカル Cognito と Workspace を初期化します。作成される初期 owner は以下です。

- メールアドレス: `demo@example.com`
- パスワード: `Password123!`

API サーバーはデフォルトで `http://localhost:4566` の Floci Cognito に接続し、`mukuroji-local` user pool と `mukuroji-web-local` client を自動検出します。初期 owner を含む local user の `custom:directory_id` と `custom:workspace_id` は、どちらも `workspace#mukuroji-local` に設定されます。生成された値は `.floci/generated/cognito.env` に出力されます。

同じ ready hook で DynamoDB table `mukuroji-dashboard-local`,
`mukuroji-project-tasks-v2-local`, `mukuroji-project-directory-local`,
`mukuroji-workspace-access-local`, `mukuroji-workspace-search-local` も作成し、ダッシュボード集計、Refero のタスク、
サイドバー用チーム/プロジェクト階層、Workspace metadata/member を投入します。
チーム/プロジェクト階層は `workspace#mukuroji-local` partition に seed され、タスク API はその directory に含まれる project だけを返します。
Workspace access table では `demo@example.com` を active owner、既存の project user を
active member、`viewer@example.com` を active guest として初回だけ seed します。
ready hook の再実行は既存 role/status を上書きしないため、利用停止した member が
Floci 再起動で自動的に再有効化されることはありません。

Floci 上の Lambda + API Gateway に backend をデプロイする場合:

```sh
bun run floci:up
bun run floci:deploy-backend
```

`floci:deploy-backend` は `server/src/index.ts` を Node.js 22 Lambda 用に bundle し、Floci の REST API Gateway から Lambda に proxy します。React から Lambda 経由 API を呼ぶ場合は、生成された `.floci/generated/backend.env` の `VITE_API_BASE_URL` を使います。Lambda adapter は `/teams/projects` のような直下パスと `/api/teams/projects` の両方を同じ Hono route へ正規化します。

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
bun run server:dev
```

ローカルでログインまで確認する場合は、別ターミナルで以下を起動してください。

```sh
bun run floci:up
bun run server:dev
bun run web:dev
```

Web は Vite の proxy 経由で `/api` を `http://localhost:3000` に転送します。必要に応じて以下の環境変数を上書きできます。

- `VITE_API_BASE_URL`: ブラウザから呼ぶ API の base URL。未指定時は `/api`
- `VITE_TASKS_API_BASE_URL`: Work Item API を取得する Lambda Function URL。環境変数名は旧 client 互換で維持しています。CDK デプロイ後の `ProjectTasksApiUrl` 出力値を指定し、未指定時は `VITE_API_BASE_URL` または `/api` を使います。
- `VITE_PROJECTS_API_BASE_URL`: DynamoDB のチーム/プロジェクト階層を取得する Lambda Function URL。未指定時は `VITE_TASKS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_WORKSPACE_API_BASE_URL`: 本番環境で Workspace member / invitation API を呼ぶ base URL。未指定時は `VITE_PROJECTS_API_BASE_URL`、`VITE_TASKS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_ISSUER`: access token の expected issuer。local ready hook が生成する値を利用します。本番では CDK の user pool から解決します。
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: 明示指定する場合の Cognito リソース ID
- `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL_DYNAMODB` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci DynamoDB endpoint。未指定時は `http://localhost:4566`
- `MUKUROJI_DASHBOARD_TABLE`: ダッシュボード集計値を保存する DynamoDB table 名。未指定時は `mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE`: プロジェクト別タスクを保存する DynamoDB table 名。未指定時は `mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE`: サイドバー用チーム/プロジェクト階層を保存する DynamoDB table 名。未指定時は `mukuroji-project-directory-local`
- `MUKUROJI_WORKSPACE_ACCESS_TABLE`: Workspace metadata、member、invitation lifecycle を保存する DynamoDB table 名。未指定時は `mukuroji-workspace-access-local`
- `MUKUROJI_TEAM_ISSUES_TABLE`: チーム所有 Issue を保存する DynamoDB table 名。未指定時は `mukuroji-team-issues-local`
- `MUKUROJI_WORK_ITEMS_TABLE` / `WORK_ITEMS_TABLE_NAME`: canonical Work Item store。移行期間は `MUKUROJI_TEAM_ISSUES_TABLE` / `TEAM_ISSUES_TABLE_NAME` と同じ既存 table を指します。
- `MUKUROJI_TEAM_ISSUE_EVENTS_TABLE`: チーム Issue のコメント/活動履歴を保存する DynamoDB table 名。未指定時は `mukuroji-team-issue-events-local`
- `MUKUROJI_COLLABORATION_TABLE` / `COLLABORATION_TABLE_NAME`: comment thread、reaction、watcher、presence を保存する DynamoDB table 名。未指定時は `mukuroji-collaboration-local`
- `MUKUROJI_WORKSPACE_SEARCH_TABLE` / `WORKSPACE_SEARCH_TABLE_NAME`: Workspace search document、saved view、ユーザー別 view preference を保存する DynamoDB table 名。未指定時は `mukuroji-workspace-search-local`
- `MUKUROJI_NOTIFICATIONS_TABLE` / `NOTIFICATIONS_TABLE_NAME`: ユーザー別の durable notification timeline と配信設定を保存する DynamoDB table 名。未指定時は `mukuroji-notifications-local`
- `NOTIFICATIONS_STATUS_INDEX_NAME`: unread/read/archive/snooze ごとの timeline query に使う GSI 名。未指定時は `RecipientStatusIndex`
- `MUKUROJI_REALTIME_SESSIONS_TABLE` / `REALTIME_SESSIONS_TABLE_NAME`: WebSocket ticket と connection lease を保存する DynamoDB table 名。未指定時は `mukuroji-realtime-sessions-local`
- `REALTIME_WEBSOCKET_URL`: production の collaboration invalidation/presence 用 WebSocket URL。未指定時は Web が polling fallback を使います。
- `MUKUROJI_AUDIT_EVENTS_TABLE` / `AUDIT_EVENTS_TABLE_NAME`: immutable audit event/outbox を保存する DynamoDB table 名。ローカル既定値は `mukuroji-audit-events`
- `MUKUROJI_AUDIT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS`: audit event の保持日数。未指定時は 2555 日（7年）
- `MUKUROJI_WORKSPACE_DIRECTORY_ID`: Cognito claim と DynamoDB partition で共有する canonical Workspace ID。未指定時は `workspace#mukuroji-local`
- `MUKUROJI_PROJECT_DIRECTORY_ID`: 旧 local 設定との互換入力。`MUKUROJI_WORKSPACE_DIRECTORY_ID` が優先されます。
- `MUKUROJI_INITIAL_OWNER_EMAIL` / `MUKUROJI_INITIAL_OWNER_USERNAME`: 初期 owner の email と Cognito username

API サーバーは `/api/workspace/access`, `/api/dashboard/summary`, `/api/teams/projects`, `/api/work-items`,
`/api/teams/{teamId}/issues`, `/api/projects/{projectId}/issues`,
`/api/projects/{projectId}/tasks`, `/api/search`, `/api/saved-views`, `/api/audit/events`,
`/api/notifications` で DynamoDB を読みます。ローカルでは Vite proxy により、
Web から `/api` を呼ぶだけで Floci 上の DynamoDB データを取得できます。

Task / Issue の strict canonical schema、dynamic workflow、optimistic concurrency、Issue #20 の legacy read-only adapter は
[`docs/work-items.md`](docs/work-items.md) を参照してください。

append-only event schema、activity/audit API、retention/redaction、consumer dedupe、backfill の契約は
[`docs/event-audit.md`](docs/event-audit.md) を参照してください。

Comment thread、mention/watch 通知、reaction、presence、realtime fallback の契約は
[`docs/collaboration.md`](docs/collaboration.md) を参照してください。

Notification event、Inbox state、filter/cursor、deep link、配信設定、期限通知の契約は
[`docs/notifications.md`](docs/notifications.md) を参照してください。

Web の mutation は operation と入力 fingerprint ごとに `MutationRequestContext` を1つ保持し、失敗後に
同じ入力を retry した場合だけ同じ object を API client へ渡します。HTTP mutation 成功時または
入力変更時は context を破棄し、別の logical mutation に同じ key を流用しません。Web API client の context 引数は必須です。

ローカル backfill は次の command で実行できます。本実行時は共通 bootstrap が未作成の
`mukuroji-audit-events` table を本番互換 schema で作成します。

```sh
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --checkpoint /tmp/mukuroji-audit-backfill.json
```

CDK stack も同じタスクデータと指定した Workspace 用の
チーム/プロジェクト階層に加え、Workspace metadata と初期 active owner を
DynamoDB に idempotent に seed し、Lambda Function URL 経由で取得できます。
AWS 環境で確認する場合は以下の順に実行し、出力された `ProjectTasksApiUrl` を
Web の環境変数へ渡してください。

```sh
export COGNITO_USER_POOL_ID=<user-pool-id>
export COGNITO_USER_POOL_CLIENT_ID=<public-app-client-id>
export MUKUROJI_WORKSPACE_DIRECTORY_ID=<workspace-directory-id>
export MUKUROJI_INITIAL_OWNER_EMAIL=<owner@example.com>
export MUKUROJI_INITIAL_OWNER_USERNAME=<cognito-username>

bash scripts/prepare-workspace-cognito.sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun --filter cdk cdk diff \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME"
```

Lambda Function URL の CORS 許可 origin は CDK parameter
`TaskApiAllowedOrigins` で指定します。未指定時は
`http://localhost:5173,http://127.0.0.1:5173` です。
認証に使う Cognito user pool は CDK parameter `CognitoUserPoolId` で固定し、
Lambda は access token の issuer がその user pool と一致する場合だけ処理します。
Workspace partition は `WorkspaceDirectoryId`、初期 owner の小文字メールアドレスは
`InitialOwnerEmail` で指定します。Cognito の
`custom:directory_id` / `custom:workspace_id` は `WorkspaceDirectoryId` と一致させてください。
同じ Function URL から `/teams/projects`, `/teams/{teamId}/issues`,
`/projects/{projectId}/issues`, `/projects/{projectId}/tasks`,
`/api/workspace/access` などの Workspace invitation API も取得できます。

### Workspace invitation lifecycle

Workspace member と Cognito identity は分離して管理します。Cognito 認証に成功しても、
Workspace access table の member が `active` でなければ、Lambda はすべての業務 API を
`403` で拒否します。`deactivated` member や、`pending` / `revoked` invitation だけが残る
user は project、task、Issue API を利用できません。

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
VITE_TASKS_API_BASE_URL=<ProjectTasksApiUrl>
VITE_WORKSPACE_API_BASE_URL=<ProjectTasksApiUrl>
```

fresh deploy、既存 stack upgrade、bootstrap 検証、rollback、PITR recovery の手順は [cdk/README.md](./cdk/README.md) を参照してください。

`ProjectTasksTableName` は Issue #20 の legacy read-only adapter が参照する table です。旧 row を直接確認する場合だけ次を利用します。

```sh
TASKS_TABLE_NAME=<ProjectTasksTableName> bun run tasks:check-dynamodb
```

`TASKS_TABLE_NAME` は legacy check の必須環境変数です。新しい seed / API mutation はこの table に書き込みません。
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

CDK stack の demo seed は `WorkItemsTableName` が指す canonical store へ `schemaVersion=1`, `revision=1` で投入します。手動 seed も canonical store だけを対象とし、既存 row は conditional write で保持します。

```sh
WORK_ITEMS_TABLE_NAME=<WorkItemsTableName> bun run work-items:seed-dynamodb
```

Canonical Work Item は現行 workflow schema の必須 field をすべて持つ row だけを読みます。開発中の古い row は自動変換せず、削除して現行 seed または API から作り直します。

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
