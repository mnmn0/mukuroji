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

同じ ready hook で DynamoDB table `mukuroji-dashboard-local` も作成し、ダッシュボード集計用の `summary` item を投入します。

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
- `VITE_API_PROXY_TARGET`: Vite dev server が proxy する API。未指定時は `http://localhost:3000`
- `COGNITO_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci endpoint。未指定時は `http://localhost:4566`
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: 明示指定する場合の Cognito リソース ID
- `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL`: API サーバーから見る Floci DynamoDB endpoint。未指定時は `http://localhost:4566`
- `MUKUROJI_DASHBOARD_TABLE`: ダッシュボード集計値を保存する DynamoDB table 名。未指定時は `mukuroji-dashboard-local`

プロジェクトタスクデータとチーム/プロジェクト階層は CDK stack が DynamoDB に seed し、Lambda Function URL 経由で取得します。AWS 環境で確認する場合は以下の順に実行し、出力された `ProjectTasksApiUrl` を Web の環境変数へ渡してください。

```sh
bun run cdk:synth
# デプロイ時は AWS アカウントへ影響するため、事前に内容を確認してください。
VITE_TASKS_API_BASE_URL=<ProjectTasksApiUrl> bun run web:dev
```

Lambda Function URL の CORS 許可 origin は CDK parameter
`TaskApiAllowedOrigins` で指定します。未指定時は
`http://localhost:5173,http://127.0.0.1:5173` です。
同じ Function URL から `/teams/projects` と `/projects/{projectId}/tasks` を取得します。

毎回環境変数を指定しない場合は、`web/.env.local` に以下を保存してください。

```sh
VITE_TASKS_API_BASE_URL=<ProjectTasksApiUrl>
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
チーム/プロジェクト階層の table 名は CDK output の
`ProjectDirectoryTableName` で確認できます。

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
