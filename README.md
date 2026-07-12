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

Floci の ready hook がローカル Cognito を初期化します。作成されるテストユーザーは以下です。

- メールアドレス: `demo@example.com`
- パスワード: `Password123!`

API サーバーはデフォルトで `http://localhost:4566` の Floci Cognito に接続し、`mukuroji-local` ユーザープールと `mukuroji-web-local` クライアントを自動検出します。生成された値は `.floci/generated/cognito.env` に出力されます。

同じ ready hook で DynamoDB table `mukuroji-dashboard-local`,
`mukuroji-project-tasks-v2-local`, `mukuroji-project-directory-local`,
`mukuroji-workspace-access-local` も作成し、ダッシュボード集計、Refero のタスク、
サイドバー用チーム/プロジェクト階層、Workspace metadata/member を投入します。
チーム/プロジェクト階層は Cognito の `email` から作る `user#demo@example.com`
partition に seed され、タスク API はその directory に含まれる project だけを返します。
Workspace access table では `demo@example.com` を active owner、既存の project user を
active member、`viewer@example.com` を active guest として初回だけ seed します。
ready hook の再実行は既存 role/status を上書きしないため、利用停止した member が
Floci 再起動で自動的に再有効化されることはありません。

Floci 上の Lambda + API Gateway に backend をデプロイする場合:

```sh
bun run floci:up
bun run floci:deploy-backend
```

`floci:deploy-backend` は `server/src/index.ts` を Node.js 22 Lambda 用に bundle し、Floci の REST API Gateway から Lambda に proxy します。React から直接 Lambda 経由 API を呼ぶ場合は、生成された `.floci/generated/backend.env` の `VITE_API_BASE_URL` を使います。

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
- `VITE_TASKS_API_BASE_URL`: DynamoDB のタスク一覧を取得する Lambda Function URL。CDK デプロイ後の `ProjectTasksApiUrl` 出力値を指定してください。未指定時は `VITE_API_BASE_URL` または `/api` を使います。
- `VITE_PROJECTS_API_BASE_URL`: DynamoDB のチーム/プロジェクト階層を取得する Lambda Function URL。未指定時は `VITE_TASKS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_WORKSPACE_API_BASE_URL`: 本番環境で Workspace member / invitation API を呼ぶ base URL。未指定時は `VITE_PROJECTS_API_BASE_URL`、`VITE_TASKS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: 明示指定する場合の Cognito リソース ID
- `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL_DYNAMODB` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci DynamoDB endpoint。未指定時は `http://localhost:4566`
- `MUKUROJI_DASHBOARD_TABLE`: ダッシュボード集計値を保存する DynamoDB table 名。未指定時は `mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE`: プロジェクト別タスクを保存する DynamoDB table 名。未指定時は `mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE`: サイドバー用チーム/プロジェクト階層を保存する DynamoDB table 名。未指定時は `mukuroji-project-directory-local`
- `MUKUROJI_WORKSPACE_ACCESS_TABLE`: Workspace metadata、member、invitation lifecycle を保存する DynamoDB table 名。未指定時は `mukuroji-workspace-access-local`
- `MUKUROJI_TEAM_ISSUES_TABLE`: チーム所有 Issue を保存する DynamoDB table 名。未指定時は `mukuroji-team-issues-local`
- `MUKUROJI_TEAM_ISSUE_EVENTS_TABLE`: チーム Issue のコメント/活動履歴を保存する DynamoDB table 名。未指定時は `mukuroji-team-issue-events-local`
- `MUKUROJI_AUDIT_EVENTS_TABLE` / `AUDIT_EVENTS_TABLE_NAME`: immutable audit event/outbox を保存する DynamoDB table 名。ローカル既定値は `mukuroji-audit-events`
- `MUKUROJI_AUDIT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS`: audit event の保持日数。未指定時は 2555 日（7年）
- `MUKUROJI_PROJECT_DIRECTORY_ID`: ready hook が seed する directory partition。未指定時は `user#<COGNITO_TEST_USERNAME の小文字>`。プロジェクト権限付与候補 user は Cognito の `custom:directory_id` / `custom:workspace_id` がこの値に一致する user に限定されます。

API サーバーは `/api/workspace/access`, `/api/dashboard/summary`, `/api/teams/projects`,
`/api/teams/{teamId}/issues`, `/api/projects/{projectId}/issues`,
`/api/projects/{projectId}/tasks`, `/api/audit/events` で DynamoDB を読みます。ローカルでは Vite proxy により、
Web から `/api` を呼ぶだけで Floci 上の DynamoDB データを取得できます。

append-only event schema、activity/audit API、retention/redaction、consumer dedupe、backfill の契約は
[`docs/event-audit.md`](docs/event-audit.md) を参照してください。

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

CDK stack も同じタスクデータと demo user 用の `user#demo@example.com`
チーム/プロジェクト階層に加え、Workspace metadata と初期 active owner を
DynamoDB に idempotent に seed し、Lambda Function URL 経由で取得できます。
AWS 環境で確認する場合は以下の順に実行し、出力された `ProjectTasksApiUrl` を
Web の環境変数へ渡してください。

```sh
bun run cdk:synth
# デプロイ時は AWS アカウントへ影響するため、事前に内容を確認してください。
VITE_TASKS_API_BASE_URL=<ProjectTasksApiUrl> bun run web:dev
```

Lambda Function URL の CORS 許可 origin は CDK parameter
`TaskApiAllowedOrigins` で指定します。未指定時は
`http://localhost:5173,http://127.0.0.1:5173` です。
認証に使う Cognito user pool は CDK parameter `CognitoUserPoolId` で固定し、
Lambda は access token の issuer がその user pool と一致する場合だけ処理します。
Workspace partition は `WorkspaceDirectoryId`、初期 owner の小文字メールアドレスは
`InitialWorkspaceOwnerEmail` で指定します。既定値はそれぞれ
`user#demo@example.com` と `demo@example.com` です。Cognito の
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

毎回環境変数を指定しない場合は、`web/.env.local` に以下を保存してください。

```sh
VITE_TASKS_API_BASE_URL=<ProjectTasksApiUrl>
VITE_WORKSPACE_API_BASE_URL=<ProjectTasksApiUrl>
```

DynamoDB に seed されたタスクデータを直接確認する場合は、CDK output の
`ProjectTasksTableName` を指定して以下を実行します。

```sh
TASKS_TABLE_NAME=<ProjectTasksTableName> bun run tasks:seed-dynamodb
TASKS_TABLE_NAME=<ProjectTasksTableName> bun run tasks:check-dynamodb
```

`TASKS_TABLE_NAME` は必須環境変数です。未設定の場合、
`scripts/seed-project-tasks-dynamodb.sh` と
`scripts/check-project-tasks-dynamodb.sh` は失敗します。CDK output の
`ProjectTasksTableName` を `TASKS_TABLE_NAME` に設定してから実行してください。
`PROJECT_DIRECTORY_ID` を省略した場合は `user#demo@example.com` のタスクとして
seed/check します。
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

CDK stack も同じ seed を Custom Resource として定義します。ローカル互換
endpoint を使う場合は `AWS_ENDPOINT_URL` と必要に応じて
`AWS_NO_SIGN_REQUEST=1` を併用できます。

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
