# mukuroji AWS deployment

この CDK stack は shared Hono handler を Node.js 22 Lambda に bundle し、Lambda Function URL と API Gateway HTTP API の両方へ接続します。DynamoDB table、CORS / IAM、外部 Cognito 設定、Workspace bootstrap も同じ stack で管理します。

コマンドは repository root から実行してください。AWS account を変更する `deploy`、Cognito 更新、data migration / recovery は、対象 account・region と `cdk diff` を確認してから実行します。

## Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `CognitoUserPoolId` | yes | 既存 Cognito user pool ID。access token の issuer と IAM scope に使います。 |
| `CognitoUserPoolClientId` | yes | client secret なし、`ALLOW_USER_PASSWORD_AUTH` 有効の既存 public app client ID。access token の `client_id` と照合します。 |
| `WorkspaceDirectoryId` | yes | Cognito の両 custom attribute と DynamoDB partition に使う canonical ID。例: `workspace#production`。 |
| `InitialOwnerEmail` | yes | lowercase の初期 owner email。Workspace/member/alias key に使います。 |
| `InitialOwnerUsername` | yes | `AdminUpdateUserAttributes` に渡す Cognito username。email と異なる username も指定できます。 |
| `TaskApiAllowedOrigins` | production では必須 | 空白なしの comma-separated CORS origin。既定値は local development 用です。 |
| `SystemAdminGroups` | no | system-admin とみなす comma-separated Cognito group。既定値は `mukuroji-system-admins`。 |

`WorkspaceDirectoryId`、owner email / username は data key と認可境界に使います。環境ごとに固定し、通常の application deploy で変更しないでください。

## Outputs

- `ProjectTasksFunctionUrl`: Lambda Function URL
- `ProjectTasksApiGatewayUrl`: API Gateway HTTP API URL
- `ProjectTasksApiUrl`: Function URL の後方互換 output
- `ProjectTasksTableName`（legacy read-only compatibility）
- `WorkItemsTableName`（既存 `TeamIssuesTable` を昇格した canonical store）
- `TeamIssuesTableName`（`WorkItemsTableName` と同じ table を指す互換 output）
- `ProjectDirectoryTableName`, `TeamIssueEventsTableName`
- `NotificationsTableName`, `CollaborationProjectionDlqUrl`
- `AuditEventsTableName`, `ProcessedAuditEventsTableName`
- `WorkItemCollaborationTableName`, `RealtimeSessionsTableName`, `RealtimeWebSocketUrl`
- `WorkspaceDirectoryId`

Function URL と API Gateway は同じ Lambda を呼びます。いずれも `<base>/teams/projects` と `<base>/api/teams/projects` を同じ canonical `/api` route へ正規化します。

## Fresh deployment

### 1. Cognito と値を準備する

初期 owner は既に Cognito に存在し、enabled / `CONFIRMED` である必要があります。app client は client secret なしで `ALLOW_USER_PASSWORD_AUTH` を許可します。

`InitialOwnerUsername` が lowercase の `InitialOwnerEmail` と異なる場合、login form から email で認証できるよう、user pool の `UsernameAttributes` または `AliasAttributes` に `email` が必要です。`AliasAttributes=email` を使う場合は、初期 owner の Cognito `email_verified=true` も必須です。また app client の `ReadAttributes` を明示設定する場合は、`email`、`custom:directory_id`、`custom:workspace_id` をすべて含めます。`ReadAttributes` 自体が未設定の場合は Cognito default を利用できます。準備 script はこれらを検証し、不足時は Cognito や DynamoDB を更新する前に停止します。

```sh
export AWS_REGION=<region>
export COGNITO_USER_POOL_ID=<user-pool-id>
export COGNITO_USER_POOL_CLIENT_ID=<public-app-client-id>
export MUKUROJI_WORKSPACE_DIRECTORY_ID=<workspace-directory-id>
export MUKUROJI_INITIAL_OWNER_EMAIL=<lowercase-owner@example.com>
export MUKUROJI_INITIAL_OWNER_USERNAME=<cognito-username>

bash scripts/prepare-workspace-cognito.sh
```

この script は user pool / client / owner を検証し、不足している mutable custom attribute `directory_id` と `workspace_id` を追加して、owner の `custom:directory_id` / `custom:workspace_id` を同じ Workspace ID に設定します。Cognito schema へ追加した custom attribute は削除できないため、値と対象 account を先に確認してください。再実行は同じ値へ収束します。

team 作成・team archive など system-admin 操作も初期 owner に許可する場合は、`SystemAdminGroups` に指定する group へ owner を追加します。Workspace owner row は system-admin group の代替ではありません。

```sh
export SYSTEM_ADMIN_GROUP=mukuroji-system-admins

if ! aws cognito-idp get-group \
  --region "$AWS_REGION" \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --group-name "$SYSTEM_ADMIN_GROUP" >/dev/null 2>&1; then
  aws cognito-idp create-group \
    --region "$AWS_REGION" \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --group-name "$SYSTEM_ADMIN_GROUP"
fi

aws cognito-idp admin-add-user-to-group \
  --region "$AWS_REGION" \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --group-name "$SYSTEM_ADMIN_GROUP"
```

### 2. Build、test、diff、deploy

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth

bun --filter cdk cdk diff CdkStack \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters TaskApiAllowedOrigins=https://app.example.com

bun --filter cdk cdk deploy CdkStack \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters TaskApiAllowedOrigins=https://app.example.com \
  --outputs-file /tmp/mukuroji-cdk-outputs.json
```

Bootstrap は次を同一 `WorkspaceDirectoryId` partition に冪等投入します。

- `WORKSPACE#METADATA` / `workspace-metadata`
- `WORKSPACE_MEMBER#<lowercase email>` / `workspace-member` / `role=owner`
- `EMAIL_ALIAS#<lowercase email>` / `email-alias`
- seed project 4 件の `PROJECT_MEMBER#<projectId>#<lowercase email>` / `role=manager`

owner が demo member と同じ email でも最後に manager へ収束します。Workspace owner row 自体は既存 RBAC の global system-admin 判定には使いません。

### 3. Bootstrap と API を検証する

```sh
export PROJECT_DIRECTORY_TABLE_NAME="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name CdkStack \
  --query "Stacks[0].Outputs[?OutputKey=='ProjectDirectoryTableName'].OutputValue | [0]" \
  --output text)"

bash scripts/validate-workspace-bootstrap.sh
```

validator は Cognito pool/client、owner status/email、両 custom attribute、Workspace metadata/owner/alias、全 seed project の manager row を consistent read で照合します。

次に owner の新しい Cognito access token を用意し、4 経路がすべて `200` かつ同じ Workspace response を返すことを確認します。古い token は group / identity 更新前の session を表す可能性があるため再利用しません。

```sh
export FUNCTION_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name CdkStack \
  --query "Stacks[0].Outputs[?OutputKey=='ProjectTasksFunctionUrl'].OutputValue | [0]" \
  --output text)"
export API_GATEWAY_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name CdkStack \
  --query "Stacks[0].Outputs[?OutputKey=='ProjectTasksApiGatewayUrl'].OutputValue | [0]" \
  --output text)"
export ACCESS_TOKEN=<fresh-owner-access-token>

curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${FUNCTION_URL%/}/teams/projects"
curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${FUNCTION_URL%/}/api/teams/projects"
curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${API_GATEWAY_URL%/}/teams/projects"
curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${API_GATEWAY_URL%/}/api/teams/projects"
```

Web にはどちらか一方を設定します。

```sh
VITE_API_BASE_URL="$FUNCTION_URL" bun run web:dev
# または VITE_API_BASE_URL="$API_GATEWAY_URL" bun run web:dev
```

## Existing stack upgrade

既存 data をそのまま利用する upgrade では、現在使われている directory partition ID を `WorkspaceDirectoryId` に指定します。例えば既存 user partition が `user#owner@example.com` なら、その値を初回 upgrade でも維持します。新しい `workspace#...` へ同時に変更しないでください。

1. 現在の stack template、parameters、outputs と table 名を記録する。
2. stack が管理する全 stateful table で PITR が有効か確認する。未有効なら on-demand backup も取得する。
3. lowercase owner email と、既存 project で manager 権限を持つ owner を選ぶ。
4. 既存 partition ID を使って `prepare-workspace-cognito.sh` を実行する。
5. `cdk diff` で table replacement / deletion がないこと、Lambda / custom resource / Retain / PITR の更新だけであることを確認する。
6. deploy 後に `validate-workspace-bootstrap.sh` と Function URL / API Gateway の 4 経路を確認する。

bootstrap update は同じ key・同じ owner なら再実行できます。既存の異なる種類の row と key が衝突した場合は上書きせず stack update を失敗させるため、row を調査してから再実行します。

通知 upgrade では `NotificationsTable` に `RecipientStatusIndex` が追加されます。deploy 前に GSI backfill の所要時間と table throttling を確認し、deploy 後は `CollaborationProjectionDlqUrl` の滞留、`NotificationScheduleFunction` の失敗、Inbox の unread count を監視してください。期限 schedule は UTC date-only で1時間ごとに走査し、同じ Work Item / due date / reason の event を決定的に重複排除します。

`InitialOwnerEmail` / `InitialOwnerUsername` の変更は通常 deploy と分けて owner rotation として扱います。新 owner の検証後、旧 owner の Cognito attributes、system-admin group、workspace/member/alias row、各 project role を明示的に棚卸ししてください。parameter 変更だけでは旧 owner の row や group membership は削除されません。

## Workspace partition migration

`WorkspaceDirectoryId` を変える操作は application deploy ではなく data migration です。CDK bootstrap は既存 task / issue / activity を新 partition へコピーしません。

安全な移行順序:

1. maintenance window を設定し、write を停止する。
2. source table 名、旧/new Workspace ID、item count、最新 timestamp を記録し、PITR / on-demand backup を確認する。
3. 同じ table 内の新 partition へ conditional put で copy する。task / issue / event は全 row の payload `directoryId` を new Workspace ID に更新し、最低限、次の derived key を再構築する。
   - tasks: `directoryId=<workspace>`、`directoryProjectId=<workspace>#project#<projectId>`
   - directory: team / project / project-member row の `directoryId=<workspace>`。通常の `entryKey` は維持する。
   - team issues: `directoryId=<workspace>`、`directoryTeamId=<workspace>#team#<teamId>`、存在する `directoryProjectId=<workspace>#project#<projectId>`
   - issue events: `directoryId=<workspace>`、`directoryTeamIssueId=<workspace>#team#<teamId>#issue#<issueId>`
   - `workspace-metadata`、`workspace-member`、`email-alias` の 3 種は旧 partition から copy しない。旧 `workspaceId` や owner key を残すと bootstrap condition と衝突するため、CDK deploy で new Workspace ID / owner parameter から再生成する。
4. source / destination の件数と代表 item を照合し、重複 key や未処理 write がないことを確認する。
5. new Workspace ID を parameter にして `cdk diff` / deploy を実行する。CDK が owner attributes と bootstrap row を new partition に揃える。
6. fresh token で両 API endpoint を検証してから write を再開する。
7. rollback window 中は旧 partition を削除しない。

大量 data の migration を shell の `scan | put-item` で即時実行しないでください。pagination、retry、conditional write、件数/内容照合を備えた一時 migration job として review・dry run してから実行します。

## Canonical Work Item cutover

Project task / Team Issue の state migration は Workspace partition migration と分けて実行します。CDK は既存 `TeamIssuesTable` construct と key schema を維持し、`WorkItemsTableName` という canonical alias を追加します。`ProjectTasksTable` は Retain/PITR のまま残しますが、API Lambda には read permission だけを付与します。

安全な順序:

1. `ProjectTasksTable`, `WorkItemsTable`, `ProjectDirectoryTable` の table 名・件数・PITR を記録し、on-demand backup を取得する。
2. write freeze を設定し、`cdk diff` で table replacement/deletion がなく、legacy task table の write IAM が削除されることを確認する。
3. この revision を deploy する。
4. `docs/work-items.md` の `work-items:migrate -- --dry-run` を実行する。複数 Team に属する project は `--project-team` で owner を明示する。
5. checkpoint 付き apply と `--verify` を完了する。
6. Team/project/Workspace list、detail update、stale revision の `409 WorkItemRevisionConflict` を Function URL と API Gateway の両方で確認して write を再開する。

Demo seed の custom resource は旧 `SeedProjectTasks` の論理 ID を維持します。fresh stack の create では canonical `WorkItemsTable` だけに seed し、既存 stack の update では `onUpdate` を持たないため seed transaction を再実行しません。同じ論理 ID のまま旧 revision に戻すため、rollback 時にも legacy seed custom resource が新規作成されることはありません。既存 stack の canonical data は上記 migration で投入します。

Rollback window 中はどちらの table も削除しません。rollback は直前 revision を同じ parameter で deploy し、旧 handler が同じ `TeamIssuesTable` の追加属性を無視して読めることを確認します。Migrated row の一括削除は migration 後の正規 write を失うため禁止します。

## Rollback

code / infrastructure rollback は、直前に成功した revision を同じ 5 parameters で deploy します。DynamoDB table は `Retain` で、PITR も有効なため stack rollback / deletion で削除されません。Cognito custom schema は rollback しても残ります。

Workspace migration の切替後に戻す場合:

1. write を停止する。
2. owner の両 Cognito custom attribute を旧 Workspace ID に戻す。
3. 直前 revision を旧 `WorkspaceDirectoryId` で deploy する。
4. fresh token で旧 partition の API response を検証する。
5. rollback 中に new partition へ発生した write を照合してから運用を再開する。

CloudFormation が `UPDATE_ROLLBACK_FAILED` になった場合は、失敗 resource と data conflict を調査してから `continue-update-rollback` を使います。復旧を簡単にする目的で stack を削除しないでください。Retain table が残っても、新 stack への再接続には resource import または data copy が必要です。

## PITR recovery

誤削除・破損時は先に write を止め、PITR から別名 table へ復元します。元 table を直ちに削除しません。

```sh
aws dynamodb restore-table-to-point-in-time \
  --region "$AWS_REGION" \
  --source-table-name <source-table> \
  --target-table-name <source-table>-recovery-YYYYMMDDHHMM \
  --restore-date-time <ISO-8601-timestamp>

aws dynamodb wait table-exists \
  --region "$AWS_REGION" \
  --table-name <source-table>-recovery-YYYYMMDDHHMM
```

復元 table の key schema / GSI / item count / representative records を確認します。その後は、(a) reviewed conditional copy で元 table の対象 item を修復する、または (b) CDK を更新して復元 table を参照し resource import する、のどちらかを選びます。切替確認前に元 table や旧 partition を削除しません。

## Security and durability checks

- Function URL の edge auth は `NONE` ですが、Hono API が Cognito Bearer token の issuer / client / token use を検証します。
- Function URL、HTTP API、Hono CORS は同じ `TaskApiAllowedOrigins` に揃えます。本番で local default を使いません。
- Lambda IAM は stack table と指定 user pool に限定します。
- 4 DynamoDB table は `Retain` + PITR enabled です。
- Lambda は `server/src/index.ts` を deploy 時に bundle します。旧 inline Lambda copy はありません。

## Commands

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun --filter cdk cdk diff CdkStack
```
