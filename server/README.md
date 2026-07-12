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
- `/api/teams/{teamId}/issues/{issueId}/collaboration`, `/comments`, `/watch`, `/presence`
- `/api/projects/{projectId}/tasks`, `/issues`, `/members`, `/users`, `/watch`
- `/api/notifications`, `/api/notifications/unread-count`, `/api/notification-preferences`

The local API reads DynamoDB through `DYNAMODB_ENDPOINT`, `AWS_ENDPOINT_URL_DYNAMODB`, or `AWS_ENDPOINT_URL`.
Default local table names are:

- `MUKUROJI_DASHBOARD_TABLE=mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE=mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE=mukuroji-project-directory-local`
- `MUKUROJI_COLLABORATION_TABLE=mukuroji-collaboration-local`
- `MUKUROJI_NOTIFICATIONS_TABLE=mukuroji-notifications-local`
- `NOTIFICATIONS_STATUS_INDEX_NAME=RecipientStatusIndex`
- `MUKUROJI_REALTIME_SESSIONS_TABLE=mukuroji-realtime-sessions-local`
- `MUKUROJI_AUDIT_EVENTS_TABLE=mukuroji-audit-events`
- `MUKUROJI_AUDIT_RETENTION_DAYS=2555`
- `MUKUROJI_WORKSPACE_DIRECTORY_ID=workspace#mukuroji-local`
- `MUKUROJI_WORKSPACE_ACCESS_TABLE=mukuroji-workspace-access-local`

Project directory rows are scoped by the authenticated Cognito user's Workspace claims.
The local Floci seed writes `workspace#mukuroji-local` to both `custom:directory_id` and
`custom:workspace_id`. Project task rows are queried by
`workspace#mukuroji-local#project#<projectId>`.

To preview and run the append-only audit backfill against local DynamoDB:

```sh
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --checkpoint /tmp/mukuroji-audit-backfill.json
```

The write run bootstraps `mukuroji-audit-events` with the production-compatible
keys, GSIs, and stream when the local table does not exist. Dry runs do not
create the table or write events/checkpoints.
