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

Project directory rows are scoped by the authenticated Cognito user's `email`
as `user#<email>`. The local Floci seed writes `user#demo@example.com`.
Project task rows are queried by `user#<email>#project#<projectId>`.
