# mukuroji API server

Hono で実装した API を、Bun development server と Node.js 22 Lambda の同じ app / route 契約で実行します。コマンドは repository root から実行してください。

## Local development

```sh
bun install
bun run floci:up
bun run server:dev
```

server は既定で `http://localhost:4566` の Floci Cognito / DynamoDB に接続します。Floci が生成した値を明示的に読み込む場合は次のように起動します。

```sh
set -a
. .floci/generated/cognito.env
set +a
bun run server:dev
```

health check は `GET http://localhost:3000/api/health` です。`POST /api/auth/login` 以外の application API は、Cognito access token を `Authorization: Bearer <token>` で受け取ります。

## API path contract

Hono app 内の canonical path は `/api` prefix 付きです。Lambda adapter は Function URL / API Gateway から届く prefix なしの path を canonical path へ正規化するため、次の 2 つは同じ route を呼びます。

- `<base-url>/teams/projects`
- `<base-url>/api/teams/projects`

Bun server は canonical path を直接公開するため `http://localhost:3000/api/...` を使います。Lambda では base URL に `/api` を含めても含めなくてもよく、同一 request 内で prefix を重ねて `/api/api/...` にしないでください。

主な route:

- `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/dashboard/summary`
- `POST /api/teams`, `GET /api/teams/projects`
- `/api/teams/{teamId}/issues`
- `/api/projects/{projectId}/tasks`, `/issues`, `/members`, `/users`

## Runtime configuration

Local 名と Lambda 名は同じ client 実装へ解決されます。

| Purpose | Bun / Floci | Lambda / AWS |
| --- | --- | --- |
| Cognito endpoint | `COGNITO_ENDPOINT` または `AWS_ENDPOINT_URL` | AWS SDK default endpoint |
| Token issuer | Floci が生成する `COGNITO_ISSUER` | user pool ID から導出する AWS issuer |
| User pool | `COGNITO_USER_POOL_ID` | `COGNITO_USER_POOL_ID` |
| Public app client | `COGNITO_CLIENT_ID` | `COGNITO_CLIENT_ID` |
| DynamoDB endpoint | `DYNAMODB_ENDPOINT` または `AWS_ENDPOINT_URL` | AWS SDK default endpoint |
| Project tasks table | `MUKUROJI_PROJECT_TASKS_TABLE` | `TASKS_TABLE_NAME` |
| Project directory table | `MUKUROJI_PROJECT_DIRECTORY_TABLE` | `PROJECT_DIRECTORY_TABLE_NAME` |
| Team issues table | `MUKUROJI_TEAM_ISSUES_TABLE` | `TEAM_ISSUES_TABLE_NAME` |
| Team issue events table | `MUKUROJI_TEAM_ISSUE_EVENTS_TABLE` | `TEAM_ISSUE_EVENTS_TABLE_NAME` |
| Canonical Workspace | `MUKUROJI_WORKSPACE_DIRECTORY_ID` | `MUKUROJI_WORKSPACE_DIRECTORY_ID` |
| System admin groups | `MUKUROJI_SYSTEM_ADMIN_GROUPS` | `SYSTEM_ADMIN_GROUPS` |
| CORS origins | local defaults | `ALLOWED_ORIGINS` |

本番 Lambda は access token の `iss`、`client_id`、`token_use=access` を設定済み user pool / app client と照合します。利用する app client は client secret なしで `ALLOW_USER_PASSWORD_AUTH` が有効である必要があります。

## Workspace identity invariant

認証済み user の `custom:directory_id` と `custom:workspace_id` は、CDK parameter `WorkspaceDirectoryId` および DynamoDB の `directoryId` と同じ値にします。server は移行互換のため両 attribute を読めますが、本番 bootstrap では片方だけを設定せず、`scripts/prepare-workspace-cognito.sh` と `scripts/validate-workspace-bootstrap.sh` で一致を確認してください。

初期 owner の workspace row は Workspace の所有関係を表します。既存 RBAC の system-admin 判定は Cognito group、project 操作権は project member row を source of truth とするため、workspace-owner row だけで system-admin にはなりません。

## Build and test

```sh
bun run server:test
bun run server:build:lambda
```

Lambda bundle は `server/dist/lambda/index.mjs` に生成されます。`dist/` は生成物なので commit しません。
