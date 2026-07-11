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
`mukuroji-project-tasks-v2-local`, `mukuroji-project-directory-local` も作成し、
ダッシュボード集計、Refero のタスク、サイドバー用チーム/プロジェクト階層を投入します。
チーム/プロジェクト階層は `workspace#mukuroji-local` partition に seed され、タスク API はその directory に含まれる project だけを返します。Workspace metadata、owner member、lowercase email alias も同じ partition に冪等に作成されます。

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
- `VITE_TASKS_API_BASE_URL`: DynamoDB のタスク一覧を取得する Lambda Function URL。CDK デプロイ後の `ProjectTasksApiUrl` 出力値を指定してください。未指定時は `VITE_API_BASE_URL` または `/api` を使います。
- `VITE_PROJECTS_API_BASE_URL`: DynamoDB のチーム/プロジェクト階層を取得する Lambda Function URL。未指定時は `VITE_TASKS_API_BASE_URL`、`VITE_API_BASE_URL`、`/api` の順に使います。
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_ISSUER`: access token の expected issuer。Floci ready hook が browser から見える public endpoint と user pool ID から生成します。本番 AWS では未指定にします。
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: 明示指定する場合の Cognito resource ID
- `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci DynamoDB endpoint。未指定時は `http://localhost:4566`
- `MUKUROJI_DASHBOARD_TABLE`: ダッシュボード集計値を保存する DynamoDB table 名。未指定時は `mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE`: プロジェクト別タスクを保存する DynamoDB table 名。未指定時は `mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE`: サイドバー用チーム/プロジェクト階層を保存する DynamoDB table 名。未指定時は `mukuroji-project-directory-local`
- `MUKUROJI_TEAM_ISSUES_TABLE`: チーム所有 Issue を保存する DynamoDB table 名。未指定時は `mukuroji-team-issues-local`
- `MUKUROJI_TEAM_ISSUE_EVENTS_TABLE`: チーム Issue のコメント/活動履歴を保存する DynamoDB table 名。未指定時は `mukuroji-team-issue-events-local`
- `MUKUROJI_WORKSPACE_DIRECTORY_ID`: ready hook が seed する canonical Workspace directory partition。未指定時は `workspace#mukuroji-local`。Cognito の `custom:directory_id` / `custom:workspace_id` と必ず同じ値にします。
- `MUKUROJI_PROJECT_DIRECTORY_ID`: 旧 local 設定との互換入力。`MUKUROJI_WORKSPACE_DIRECTORY_ID` が指定されている場合は後者を優先します。
- `MUKUROJI_INITIAL_OWNER_EMAIL`: 初期 owner の email。email alias と member key には lowercase を保存します。未指定時は `demo@example.com`。
- `MUKUROJI_INITIAL_OWNER_USERNAME`: 初期 owner の Cognito username。未指定時は `COGNITO_TEST_USERNAME`。

API サーバーは `/api/dashboard/summary`, `/api/teams/projects`,
`/api/teams/{teamId}/issues`, `/api/projects/{projectId}/issues`,
`/api/projects/{projectId}/tasks` で DynamoDB を読みます。ローカルでは Vite proxy により、
Web から `/api` を呼ぶだけで Floci 上の DynamoDB データを取得できます。

CDK stack は指定した Workspace partition に metadata、初期 owner、email alias、初期 project を冪等に seed します。外部 Cognito user pool と app client を利用するため、次の値を明示してから deploy します。

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

本番 deploy ではさらに `TaskApiAllowedOrigins=https://<web-origin>` を指定します。Lambda は access token の issuer と `client_id` を、指定された user pool / app client と照合します。初期 owner に system-admin 操作も許可する場合は、deploy 前に `SystemAdminGroups` で指定する Cognito group へ所属させてください。Workspace owner row は project seed の manager 権限を与えますが、system-admin group の代替ではありません。

deploy 後は Function URL または API Gateway URL の output を Web に設定します。どちらも base URL の直下パスと `/api` prefix を受け付けます。

```sh
VITE_API_BASE_URL=<ProjectTasksApiUrl>
```

fresh deploy、既存 stack upgrade、bootstrap 検証、migration、rollback、PITR recovery の手順は [cdk/README.md](./cdk/README.md) を参照してください。

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
