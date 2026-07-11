To install dependencies:
```sh
bun install
```

To run:
```sh
bun run server:dev
```

Run these commands from the repository root.

open http://localhost:3000

The local API reads DynamoDB through `DYNAMODB_ENDPOINT` or `AWS_ENDPOINT_URL`.
Default local table names are:

- `MUKUROJI_DASHBOARD_TABLE=mukuroji-dashboard-local`
- `MUKUROJI_PROJECT_TASKS_TABLE=mukuroji-project-tasks-v2-local`
- `MUKUROJI_PROJECT_DIRECTORY_TABLE=mukuroji-project-directory-local`
- `MUKUROJI_AUDIT_EVENTS_TABLE=mukuroji-audit-events`
- `MUKUROJI_AUDIT_RETENTION_DAYS=2555`

Project directory rows are scoped by the authenticated Cognito user's `email`
as `user#<email>`. The local Floci seed writes `user#demo@example.com`.
Project task rows are queried by `user#<email>#project#<projectId>`.

To preview and run the append-only audit backfill against local DynamoDB:

```sh
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- --dry-run --limit 100
AWS_ENDPOINT_URL=http://localhost:4566 bun run audit:backfill -- \
  --checkpoint /tmp/mukuroji-audit-backfill.json
```

The write run bootstraps `mukuroji-audit-events` with the production-compatible
keys, GSIs, and stream when the local table does not exist. Dry runs do not
create the table or write events/checkpoints.
