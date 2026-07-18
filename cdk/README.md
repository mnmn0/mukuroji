# mukuroji AWS deployment

この CDK stack は shared Hono handler を Node.js 22 Lambda に bundle し、Lambda Function URL と API Gateway HTTP API の両方へ接続します。DynamoDB table、request intake の email ingestion boundary、private file bucket、GuardDuty malware scan、CORS / IAM、外部 Cognito 設定、Workspace bootstrap も同じ stack で管理します。

コマンドは repository root から実行してください。AWS account を変更する `deploy`、Cognito 更新、data migration / recovery は、対象 account・region と `cdk diff` を確認してから実行します。

## Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `CognitoUserPoolId` | yes | 既存 Cognito user pool ID。access token の issuer と IAM scope に使います。 |
| `CognitoUserPoolClientId` | yes | client secret なし、`ALLOW_USER_PASSWORD_AUTH` 有効の既存 password/API public app client ID。access token の `client_id` と照合します。 |
| `CognitoSsoUserPoolClientId` | yes | Password client とは異なる、Hosted UI authorization-code + PKCE 専用 public app client ID。 |
| `CognitoHostedUiDomain` | yes | Enterprise SSO authorization-code flow に使う Cognito managed login domain。 |
| `CognitoSsoRedirectUri` | yes | App client callback に完全一致で登録した HTTPS SPA callback URI。 |
| `CognitoEnterpriseIdpName` | yes | Cognito に接続した SAML/OIDC provider 名。 |
| `WorkspaceDirectoryId` | yes | Cognito の両 custom attribute と DynamoDB partition に使う canonical ID。例: `workspace#production`。 |
| `WorkspaceAuditPseudonymKey` | yes | Workspace/member/invitation の公開 audit ID を HMAC 化する、32-byte random値を表す64桁の小文字hex固定 key。`openssl rand -hex 32` などで生成し、`NoEcho` で Lambda に渡してbackfillにも同じ値を設定します。 |
| `InitialOwnerEmail` | yes | lowercase の初期 owner email。Workspace/member/alias key に使います。 |
| `InitialOwnerUsername` | yes | `AdminUpdateUserAttributes` に渡す Cognito username。email と異なる username も指定できます。 |
| `TaskApiAllowedOrigins` | production では必須 | 空白なしの comma-separated CORS origin。既定値は local development 用です。 |
| `SystemAdminGroups` | no | system-admin とみなす comma-separated Cognito group。既定値は `mukuroji-system-admins`。 |
| `RequestRateLimitPerHour` | no | public request capability ごとの1時間あたり submit 上限。既定値は 10、範囲は 1–10000 です。 |
| `RequestEmailWebhookSecret` | yes | email adapter から渡される envelope の署名検証に使う 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `RequestTokenHashSecret` | yes | public form / reply capability token を保存前に hash する 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `EnterpriseIdentityTokenHashSecret` | yes | SCIM bearer token と service account credential の kind・Workspace・credential-ID domain-separated digest、および10分間の idempotency response recovery 用 token 導出に使う32–256文字の安定した secret。CloudFormation では `NoEcho` です。 |
| `EnterpriseSsoStateSecret` | yes | 短命な OAuth state を署名する専用の32–256文字 secret。CloudFormation では `NoEcho` です。 |
| `FileRetentionDays` | no | soft delete 後の metadata と S3 noncurrent version の保持日数。既定値は 30 日です。live current object の有効期限ではありません。 |
| `FileUploadUrlTtlSeconds` | no | direct upload URL の有効秒数。既定値 600、範囲 60–3600 秒です。bucket policy もこの上限より古い upload 署名を拒否します。 |
| `FileDownloadUrlTtlSeconds` | no | malware scan 済み file の download URL 有効秒数。既定値 300、範囲 60–3600 秒です。bucket policy もこの上限より古い download 署名を拒否します。 |

`WorkspaceDirectoryId`、`WorkspaceAuditPseudonymKey`、owner email / username は data key と認可境界に使います。環境ごとに固定し、通常の application deploy で変更しないでください。pseudonym key を変更すると既存 resource の audit timeline が分裂するため、通常の rotation 対象にはしません。

## Outputs

- `ProjectTasksFunctionUrl`: Lambda Function URL
- `ProjectTasksApiGatewayUrl`: API Gateway HTTP API URL
- `ProjectTasksApiUrl`: Function URL の後方互換 output
- `ProjectTasksTableName`（legacy read-only compatibility）
- `WorkItemsTableName`（既存 `TeamIssuesTable` を昇格した canonical store）
- `TeamIssuesTableName`（`WorkItemsTableName` と同じ table を指す互換 output）
- `WorkItemConfigurationTableName`（workflow、custom field、relation graph の scope store）
- `PlanningTableName`（cycle、goal、milestone、roadmap、portfolio の計画 store）
- `RequestIntakeTableName`（form version、link capability、submission、queue、reply thread の scope store）
- `RequestEmailIngestionFunctionName`, `RequestEmailIngestionDlqUrl`
- `ProjectDirectoryTableName`, `TeamIssueEventsTableName`
- `FileProofingTableName`, `FileBucketName`, `FileMalwareProtectionPlanId`
- `NotificationsTableName`, `CollaborationProjectionDlqUrl`, `NotificationScheduleDlqUrl`
- `AuditEventsTableName`, `ProcessedAuditEventsTableName`
- `EnterpriseIdentityMaintenanceDlqUrl`
- `EnterpriseIdentityTableName`（Workspace generation/`CONTROL` checkpoint、global domain claim、SSO/policy/role、SCIM projection、provisioning run の store。Enterprise Identity 専用 GSI は持ちません）
- `WorkItemCollaborationTableName`, `RealtimeSessionsTableName`, `RealtimeWebSocketUrl`
- `WorkspaceSearchTableName`（検索文書、saved view、ユーザー別 view preference）
- `WorkspaceDirectoryId`

Function URL と API Gateway は同じ Lambda を呼びます。いずれも `<base>/teams/projects` と `<base>/api/teams/projects` を同じ canonical `/api` route へ正規化します。

## File storage security and retention

File body は API request body に通さず、認証・認可済み API が発行する短命 URL で `workspaces/<workspaceId>/...` の object key へ直接 upload / download します。client が任意の bucket key を指定する方式ではありません。

- S3 bucket は Block Public Access、Bucket owner enforced、SSE-S3、TLS 強制、versioning、`Retain` を有効にします。
- browser CORS は `TaskApiAllowedOrigins` と揃え、direct `PUT` / `GET` / `HEAD` と checksum / metadata header だけを許可します。
- GuardDuty Malware Protection for S3 は `workspaces/` prefix を scan し、`GuardDutyMalwareScanStatus` tag を付けます。
- bucket policy は GuardDuty 以外による scan status tag の追加・変更・削除を拒否し、API と cleanup consumer は既存 status を同値のまま保持する tag 更新だけを行います。
- bucket policy は GuardDuty scan role と metadata/scan 検証を行う API execution role を除き、`NO_THREATS_FOUND` tag がない object の `GetObject` / `GetObjectVersion` を拒否します。API は clean scan を確認した immutable S3 VersionId だけを署名するため、別 version へ URL が付け替わることはありません。
- upload / download の各 TTL より古い SigV4 query 署名は bucket policy でも拒否します。署名 URL は bearer token として log、audit event、永続 metadata に保存しません。
- delete は S3 delete marker と metadata の soft delete を先に確定し、noncurrent object version と metadata TTL を `FileRetentionDays` 後に失効させます。`file.deleted` audit stream consumer は immutable VersionId に `mukuroji-deleted=true` を冪等に付けて全 principal の read を bucket policy で拒否し、この quarantine tag 自体の削除も拒否します。annotation / approval / reviewer metadata の TTL も補完し、失敗時は stream retry / DLQ で同期 cleanup の取りこぼしを回復します。
- delete marker が作れず deleted-tagged object が current のまま残った場合は 1 日後に lifecycle で非現行化します。scan 完了済みの通常の live current object は lifecycle で期限切れにしません。
- direct upload は `mukuroji-upload=pending` tag で開始し、clean scan 確認後だけ API が `completed` へ更新します。未使用または削除後に再利用された旧 PUT URL による孤立 current object は 1 日後に delete marker で非現行化し、通常の retention 後に物理削除します。
- incomplete multipart upload は 1 日後に破棄します。

GuardDuty plan の作成は Malware Protection for S3 の利用条件と課金対象です。deploy 前の `cdk diff` で `AWS::GuardDuty::MalwareProtectionPlan`、専用 IAM role、S3 bucket policy を確認してください。scan result が `THREATS_FOUND`、`UNSUPPORTED`、`ACCESS_DENIED`、`FAILED` または tag 未設定の間は download できない fail-closed contract です。

## Request intake and email boundary

`RequestIntakeTable` は `scopeKey` / `recordKey` を primary key とし、queue projection には `RequestQueueIndex` の `queueKey` / `queueRecordKey` を使います。Table は `PAY_PER_REQUEST`、PITR、`Retain` を有効にし、期限付き link、365日保持の reply capability、rate-limit bucket などの transient row だけを epoch seconds の `expiresAt` TTL で失効させます。Form version と submission の正本を TTL で暗黙削除しないでください。

Shared API Lambda は `REQUEST_INTAKE_TABLE_NAME`、`REQUEST_QUEUE_INDEX_NAME`、`REQUEST_RATE_LIMIT_PER_HOUR` と token hash secret parameter を environment から受け取り、request state、canonical Work Item、audit event を同じ DynamoDB transaction で更新できます。Email webhook secret は dedicated ingestion Lambda だけに渡します。Attachment body は新しい public bucket を作らず、既存の private `FileBucket` と GuardDuty scan boundary を利用します。外部 response に Workspace / Team / Project / workflow / IAM 情報を含めず、opaque capability token の hash だけを table に保存します。

`RequestEmailIngestionFunction` は public HTTP URL、API Gateway route、SES receipt rule をこの stack では持ちません。Email provider / SES adapter は署名付きの正規化 envelope を作り、明示的に `lambda:InvokeFunction` を許可された principal からこの Lambda を非同期 invoke してください。Lambda は `RequestEmailWebhookSecret` で envelope を検証し、`RequestTokenHashSecret` で reply capability を解決します。Execution role は `RequestIntakeTable` への direct `GetItem` と、`dynamodb:EnclosingOperation=TransactWriteItems` 条件付き `PutItem`、failure destination の `GetQueueAttributes` / `GetQueueUrl` / `SendMessage` だけを持ちます。非同期 retry を2回使い、最終失敗は14日保持・stack rollback 時 Retain の encrypted DLQへ送られます。Visible message と `DestinationDeliveryFailures` は別々の alarm で検出します。Alarm action は環境共通の監視 stack から設定してください。

`RequestEmailWebhookSecret` は adapter と Lambda の両方で同じ値を設定し、log、output、request metadata に残さないでください。`RequestTokenHashSecret` の rotation は未失効の public form / reply link を無効化するため、通常 deploy と分け、active capability の再発行を含む手順として実施します。`NoEcho` は CloudFormation 表示を抑止しますが、secret の command history や Lambda environment への露出を防ぐものではないため、値は CI/CD の secret store から渡してください。

DLQ の envelope は署名 timestamp が5分で失効するため、そのまま redrive しません。Operator は失敗原因を解消した後、保存済み envelope の内容と `Message-ID` を変更せず、新しい timestamp で adapter 側から再署名して `RequestEmailIngestionFunction` を invokeし、成功を確認してから元 message を削除します。同じ `Message-ID` は request table の receipt で冪等化されます。

## Fresh deployment

### 1. Cognito と値を準備する

初期 owner は既に Cognito に存在し、enabled / `CONFIRMED` である必要があります。
Password/API client は client secret なしで `ALLOW_USER_PASSWORD_AUTH` を許可します。SSO client は
別の client ID とし、client secret なし、`ExplicitAuthFlows=ALLOW_REFRESH_TOKEN_AUTH` のみ、
OAuth server 有効、flow は `code` のみ、scope は `openid email profile` のみ、callback は
`COGNITO_SSO_REDIRECT_URI` の1件だけ、`SupportedIdentityProviders` は
`COGNITO_ENTERPRISE_IDP_NAME` の1件だけにします。Native user-pool login の `COGNITO` を
SSO client に追加しないでください。

`InitialOwnerUsername` が lowercase の `InitialOwnerEmail` と異なる場合、login form から email で認証できるよう、user pool の `UsernameAttributes` または `AliasAttributes` に `email` が必要です。`AliasAttributes=email` を使う場合は、初期 owner の Cognito `email_verified=true` も必須です。また両 app client の `ReadAttributes` を明示設定する場合は、`email`、`custom:directory_id`、`custom:workspace_id` をすべて含めます。`ReadAttributes` 自体が未設定の場合は Cognito default を利用できます。準備 script は両 client と external IdP を含むこれらの contract を検証し、不足時は Cognito や DynamoDB を更新する前に停止します。

```sh
export AWS_REGION=<region>
export COGNITO_USER_POOL_ID=<user-pool-id>
export COGNITO_USER_POOL_CLIENT_ID=<password-public-app-client-id>
export COGNITO_SSO_USER_POOL_CLIENT_ID=<dedicated-sso-public-app-client-id>
export COGNITO_HOSTED_UI_DOMAIN=<pool-prefix>.auth.<region>.amazoncognito.com
export COGNITO_SSO_REDIRECT_URI=https://app.example.com/auth/sso/callback
export COGNITO_ENTERPRISE_IDP_NAME=<cognito-idp-name>
export MUKUROJI_WORKSPACE_DIRECTORY_ID=<workspace-directory-id>
export MUKUROJI_INITIAL_OWNER_EMAIL=<lowercase-owner@example.com>
export MUKUROJI_INITIAL_OWNER_USERNAME=<cognito-username>
export MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY="$(openssl rand -hex 32)"
export ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="$(openssl rand -hex 32)"
export ENTERPRISE_SSO_STATE_SECRET="$(openssl rand -hex 32)"
export MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET=<at-least-32-random-characters>
export MUKUROJI_REQUEST_TOKEN_HASH_SECRET=<different-at-least-32-random-characters>

bash scripts/prepare-workspace-cognito.sh
```

`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` は環境作成時に一度だけ生成し、64桁の小文字hex値を secret store に保存して、以後の diff/deploy と audit backfill で再利用します。CloudFormation parameter とAPI/backfillのいずれも、この形式以外をfail-closedで拒否します。
`ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET` も環境ごとに固定し、CI/CD の secret store から渡します。
Raw SCIM/service credential は DynamoDB に保存しません。同じ idempotency request の応答消失時だけ
10分以内は同じ token を決定的に回復でき、期限後は新しい logical rotate が必要です。
Enterprise SSO を有効化する場合は、専用 app client に
`COGNITO_ENTERPRISE_IDP_NAME` と同名の SAML/OIDC provider だけを接続します。
CDK は既存 user pool と2つの app client ID を受け取り、同じ client ID の指定を deploy 前に拒否して
Lambda へ渡しますが、それらの外部設定を上書きしません。`prepare-workspace-cognito.sh` が事前に
code-flow/provider/callback contract を fail closed で検証し、API も SSO start/exchange ごとに
current Cognito client contract を再検証します。
通常 deploy で変更すると既存の SCIM/service account credential がすべて失効するため、rotation は
credential 再発行を伴う独立した運用として実施してください。

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
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters TaskApiAllowedOrigins=https://app.example.com

bun --filter cdk cdk deploy CdkStack \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
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

`prepare-workspace-cognito.sh` は2つの client と external IdP contract を検証します。Bootstrap
validator は Cognito pool/password client、owner status/email、両 custom attribute、
Workspace metadata/owner/alias、全 seed project の manager row を consistent read で照合します。

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

通知 upgrade では `NotificationsTable` に `RecipientStatusIndex` が追加されます。deploy 前に GSI backfill の所要時間と table throttling を確認し、deploy 後は `CollaborationProjectionDlqUrl` と `NotificationScheduleDlqUrl` の滞留、Inbox の unread count を監視してください。期限 schedule は UTC date-only で1時間ごとに走査し、同じ Work Item / due date / reason の event を決定的に重複排除します。走査が `NOTIFICATION_SCHEDULE_MAX_PAGES` の上限に達した場合も例外として非同期 retry され、最終失敗は schedule DLQ に保存されます。DLQ の visible message が1件以上になると CloudWatch alarm が `ALARM` 状態になるため、alarm と DLQ message を調査し、再実行または due-date GSI への移行を判断してください。

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

## Canonical Work Item deploy

CDK は既存 `TeamIssuesTable` construct と key schema を維持し、`WorkItemsTableName` という canonical alias を公開します。`ProjectTasksTable` は Issue #20 の read-only adapter 用に Retain/PITR のまま残しますが、API Lambda には read permission だけを付与します。

Demo seed の custom resource は canonical `WorkItemsTable` だけに `creatorMemberKey`、`workflowSchemaVersion`、`workflowStatusId`、`statusCategory`、`customFieldValues`、空の `relationIds` を含む strict row を作成します。既存 row の upcast や legacy task からの copy は行いません。

Deploy 時は `cdk diff` で table replacement/deletion がなく、legacy task table の write IAM が付与されていないことを確認します。Deploy 後は Team/project/Workspace list、任意の workflow status への detail update、stale revision の `409 WorkItemRevisionConflict` を Function URL と API Gateway の両方で確認します。Strict schema を満たさない開発用 row は削除し、現行 seed または API から作り直します。

## Work Item configuration

`WorkItemConfigurationTable` は `scopeKey` / `recordKey` を primary key とし、Workspace default、Team override、relation graph metadata を同じ scope partition に保存します。API Lambda には `WORK_ITEM_CONFIGURATION_TABLE_NAME` を設定し、この table への read/write と `TransactWriteItems` だけを stack resource に限定して許可します。Realtime Lambda と projection Lambda は configuration を直接変更しないため、この table の権限を付与しません。

CDK は configuration row を強制 seed しません。row が無い Workspace / Team は runtime の built-in default と Workspace 継承を通常仕様として利用します。

運用時は次を確認します。

1. `WorkItemConfigurationTableName` output と Lambda の `WORK_ITEM_CONFIGURATION_TABLE_NAME` が同じ table を指すこと。
2. Table が `Retain`、PITR、`expiresAtEpochSeconds` TTL を維持していること。
3. API role の read/write/transaction resource に configuration table が含まれ、Realtime / projection role には不要な権限がないこと。
4. Workspace default 未登録、Workspace default、Team override の各 API read が期待した継承元を返すこと。
5. Configuration revision CAS と relation graph revision CAS が stale mutation を拒否すること。

高リスクな definition 変更の前には table 名、configuration revision、item count を記録し、必要に応じて on-demand backup を取得します。誤削除・破損時は下記の PITR recovery に従い、復元結果を確認する前に元 table や relation row を削除しません。

## Planning data

`PlanningTable` は `workspaceId` / `recordKey` を primary key とし、cycle、goal、milestone、roadmap、portfolio とその関連情報を Workspace ごとに保存します。API Lambda には `PLANNING_TABLE_NAME` を設定し、この table への read/write と `TransactWriteItems` を stack resource に限定して許可します。

Table は `PAY_PER_REQUEST`、`Retain`、PITR enabled で作成します。deploy 前後に `PlanningTableName` output と Lambda の `PLANNING_TABLE_NAME` が同じ table を指すこと、table replacement がないこと、API role 以外へ不要な planning data 権限が付いていないことを確認してください。

## Rollback

code / infrastructure rollback は、原則として直前に成功した revision を同じ必須 parameters（request intake 用の2 secretを含む）で deploy します。現行 stack に存在する retained resource を rollback template から削除しないでください。DynamoDB table は `Retain` で、PITR も有効ですが、stack から外れた resource は自動で再接続されません。Cognito custom schema は rollback しても残ります。

`RequestIntakeTable` または email DLQ を初めて追加した deploy から、それらを知らない旧 template へ直接 rollback しないでください。先に forward-fix revision で API/email ingestion を無効化し、retained resource と output を template に残したまま application code を戻します。どうしても旧 template を使う場合は resource import 用 template と logical ID を準備し、CloudFormation から外れた retained resource を放置した状態で同名 resource を再作成しません。

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
- Lambda IAM は stack table、`workspaces/` file object prefix、指定 user pool に限定します。API role に bucket-wide `ListBucket` は付与しません。
- Email ingestion Lambda は HTTP route を持たず、Request Intake table と failure DLQ 以外の data-plane 権限を持ちません。
- stack が管理するすべての DynamoDB table は `Retain` + PITR enabled です。Enterprise Identity
  table は deletion protection と `expiresAt` TTL を有効にし、Workspace partition と
  conditional domain claim で一意性を保ちます。Entity delta を generation ごとに staging し、
  `CONTROL` revision/head、domain claim、audit event の transaction を commit point とします。
  16世代で CONTROL stream の15分 maintenance Lambda が sealed snapshot を非同期作成し、64世代の
  hard bound までに CAS compaction します。旧 generation は in-flight read 用に1時間残してから
  `expiresAt` を付与し、stream retry/DLQ で取りこぼしを回復します。Worker は credential secret を
  受け取らず、IAM は対象 table の Get/Query/Put/Update/BatchWrite と stream read に限定します。
  専用の lookup/due GSI、SCIM/RUN partition、worker fencing token はありません。FileProofing /
  Request Intake table は `expiresAt`、Work Item configuration table は
  `expiresAtEpochSeconds` TTL も有効です。
- File bucket は public access を遮断し、TLS / SSE-S3 / versioning / `Retain` / malware tag-based download deny を有効にします。
- Lambda は `server/src/index.ts` を deploy 時に bundle します。旧 inline Lambda copy はありません。

## Commands

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun --filter cdk cdk diff CdkStack
```
