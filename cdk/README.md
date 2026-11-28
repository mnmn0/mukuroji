# mukuroji AWS deployment

この CDK stack は shared Hono handler を Node.js 22 Lambda に bundle し、API Gateway HTTP API へ接続します。Web app は private S3 bucket から CloudFront で配信し、同じ CloudFront domain の `/api/*` を HTTP API へ転送します。DynamoDB table、request intake の email ingestion boundary、private file bucket、GuardDuty malware scan、CORS / IAM、外部 Cognito 設定、Workspace bootstrap も同じ stack で管理します。

コマンドは repository root から実行してください。AWS account を変更する `deploy`、Cognito 更新、data migration / recovery は、対象 account・region と `cdk diff` を確認してから実行します。

## Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `AlarmPrimaryTopicName` | yes | 全 CloudWatch alarm の primary action に使う、同一 account/region 内の既存 standard SNS topic 名。 |
| `AlarmSecondaryTopicName` | yes | 全 CloudWatch alarm の secondary action に使う、primary と異なる同一 account/region 内の既存 standard SNS topic 名。 |
| `CognitoUserPoolId` | no | 既存 Cognito user pool ID。access token の issuer と IAM scope に使います。既定値は空で、空のままなら stack が user pool を作ります。 |
| `CognitoUserPoolClientId` | no | client secret なし、`ALLOW_USER_PASSWORD_AUTH` 有効の既存 password/API public app client ID。access token の `client_id` と照合します。`CognitoUserPoolId` と一緒に指定するか、両方とも空にします。 |
| `CognitoSsoUserPoolClientId` | SSO有効時 | Password client とは異なる、Hosted UI authorization-code + PKCE 専用 public app client ID。 |
| `CognitoHostedUiDomain` | SSO有効時 | Enterprise SSO authorization-code flow に使う Cognito managed login domain。 |
| `CognitoSsoRedirectUri` | SSO有効時 | App client callback に完全一致で登録した HTTPS SPA callback URI。 |
| `CognitoEnterpriseIdpName` | SSO有効時 | Cognito に接続した SAML/OIDC provider 名。 |
| `WorkspaceDirectoryId` | yes | Cognito の両 custom attribute と DynamoDB partition に使う canonical ID。例: `workspace#production`。 |
| `WorkspaceAuditPseudonymKey` | yes | Workspace/member/invitation の公開 audit ID を HMAC 化する、32-byte random値を表す64桁の小文字hex固定 key。`openssl rand -hex 32` などで生成し、`NoEcho` で Lambda に渡します。 |
| `RestoreDrillCleanupApproverRoleArn` | 復元ドリル有効時 | Cleanup approval policyを一時attachできる唯一の既存data-owner IAM role ARN。別roleへpolicyをattachしてもapproval APIは許可されず、receipt内のSTS assumed-role sessionもこのroleへ帰属する必要があります。 |
| `ApiRuntimeConfigurationRevision` | yes | 1〜32文字のoperator管理revision。先頭はASCII英数字、以降はASCII英数字と `.` `_` `-` だけを使えます（例: `2026-07-28-01`）。API code、またはruntime configuration secretへ入るparameter/resource値を変更するdeployごとに増分し、同じrevisionを異なる内容へ再利用しません。worker が Secrets Manager から読む secret（`EnterpriseIdentityTokenHashSecret`、`RequestEmailWebhookSecret`、`RequestTokenHashSecret`）を変えるときも増分します。worker は値を cold start で読んで保持するため、revision が変わらないと warm な実行環境が古い値を使い続けます。 |
| `ApplicationCommitSha` | yes | deploy対象としてreview済みのfull lowercase Git commit SHA（40桁）。APIのliveness responseに公開され、production-like evaluationが意図したcommitを検証します。 |
| `AiBedrockModelId` | AI有効時 | AI assistanceでdefault/allowlistの両方に使う、現在サポートしているexact Bedrock model ID。現在はJP Geo profileの `jp.anthropic.claude-sonnet-4-6` のみを許可し、Tokyo/Osaka stackだけが使用できます。 |
| `AiBedrockInputPricePerMillionTokensUsd` | AI有効時 | deploy時にAWS公式料金表と照合した、選択modelのstandard input 100万token当たりUSD。 |
| `AiBedrockOutputPricePerMillionTokensUsd` | AI有効時 | deploy時にAWS公式料金表と照合した、選択modelのstandard output 100万token当たりUSD。 |
| `AiBedrockModelArn` | AI有効時 | API Lambdaに `bedrock:InvokeModel` を許可するexact foundation-modelまたはinference-profile ARN。wildcardは使用できません。 |
| `AiBedrockDestinationModelArns` | AI有効時のJP profileではyes | Cross-Region inference profileの全destination foundation-model ARNを空白なしcomma-separatedで指定します。Direct model invocationでは空にします。指定時だけprofile ARN一致condition付きIAM statementを作ります。 |
| `InitialOwnerEmail` | yes | lowercase の初期 owner email。Workspace/member/alias key に使います。 |
| `InitialOwnerUsername` | yes | `AdminUpdateUserAttributes` に渡す Cognito username。email と異なる username も指定できます。 |
| `ApiAllowedOrigins` | production では必須 | 空白なしの comma-separated CORS origin。既定値は local development 用です。 |
| `SystemAdminGroups` | no | system-admin とみなす comma-separated Cognito group。既定値は `mukuroji-system-admins`。 |
| `ConnectorRuntimeConfiguration` | no（`mukuroji:connectors` 有効時だけ存在） | connector 用 Secrets Manager secret の初期 JSON。`NoEcho`、既定値 `{}`。本番 credential は parameter で渡さず、deploy 後に secret value を更新します。 |
| `NotificationEmailSender` | no | 通知を Email で送るときの SES 送信元アドレス。既定値は空で、空のあいだは Email 配信を行いません（通知設定の Email は保存だけされます）。設定前に SES でこのアドレスかドメインを検証し、sandbox を解除してください。送信元ドメインの SPF / DKIM / DMARC は運用者が DNS に設定します。stack は SES configuration set を作り、bounce と complaint を EventBridge と SQS で受けて宛先を止めます。詳しくは [`docs/notifications.md`](../docs/notifications.md#email-配信) を参照してください。 |
| `WebPushVapidPublicKey` | no | 通知の Web Push に使う VAPID 公開鍵（padding なし base64url の非圧縮 P-256）。既定値は空で、空のあいだは push の購読登録も配信も行いません（通知設定のプッシュは保存だけされます）。`bun run web-push:vapid-keys` で鍵の組を作り、秘密鍵を Secrets Manager の secret `mukuroji/web-push/vapid-private-key` に保存してから設定してください。詳しくは [`docs/notifications.md`](../docs/notifications.md#web-push-配信) を参照してください。 |
| `InboxDigestDeliveryEnabled` | no | `true`（既定）なら、メンバーが「受信トレイのダイジェスト設定」で同意した Update の日次・週次ダイジェストを scheduled-jobs Lambda が15分おきに受信トレイへ配ります。`false` にすると同意は保存されたまま何も配りません。[ADR 0066](../docs/adr/0066-inbox-digest-scheduled-job.md) を参照してください。 |
| `CognitoEmailSender` | no | stack が作る user pool の招待・パスワード再設定メールを SES から送るときの送信元アドレス。既定値は空で、空のあいだは Cognito の既定の送信機能（1日 50 通まで）を使います。既存の user pool を使う場合は指定できません。[招待と再設定のメールを SES から送る](#招待と再設定のメールを-ses-から送る) を参照してください。 |
| `CognitoEmailSesIdentity` | no | `CognitoEmailSender` を認可する SES の検証済み identity（アドレスかドメイン）。既定値は空で、空なら `CognitoEmailSender` のアドレス自体を使います。ドメインを検証した場合はそのドメインを指定します。 |
| `MonthlyCostBudgetUsd` | no | 月次の AWS 予算（USD）。既定値は 20。実績が 80%・100%、予測が 100% を超えると email で知らせます。[費用の目安と予算 alert](#費用の目安と予算-alert) を参照してください。 |
| `CostBudgetAlertEmail` | no | 予算 alert の送信先 email。既定値は空で、空なら `InitialOwnerEmail` へ送ります。 |
| `RequestRateLimitPerHour` | no | public request capability ごとの1時間あたり submit 上限。既定値は 10、範囲は 1–10000 です。 |
| `RequestEmailWebhookSecret` | `mukuroji:requestEmail` 有効時 | email adapter から渡される envelope の署名検証に使う 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `RequestTokenHashSecret` | yes | public form / reply capability token を保存前に hash する 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `EdgeOriginSecret` | yes | CloudFront が `/api/*` の request に付ける 32–128 文字の英数字・`_`・`-` の secret。API はこの値が一致する request の viewer address だけを rate limit と Enterprise IP policy に使います。`openssl rand -hex 32` などで生成し、CloudFormation では `NoEcho` です。 |
| `EnterpriseIdentityTokenHashSecret` | yes | SCIM bearer token と service account credential の kind・Workspace・credential-ID domain-separated digest、および10分間の idempotency response recovery 用 token 導出に使う32–256文字の安定した secret。CloudFormation では `NoEcho` です。 |
| `EnterpriseSsoStateSecret` | SSO有効時 | 短命な OAuth state を署名する専用の32–256文字 secret。CloudFormation では `NoEcho` です。 |
| `FileRetentionDays` | no | soft delete 後の metadata と S3 noncurrent version の保持日数。既定値は 30 日です。live current object の有効期限ではありません。 |
| `FileUploadUrlTtlSeconds` | no | direct upload URL の有効秒数。既定値 600、範囲 60–3600 秒です。bucket policy もこの上限より古い upload 署名を拒否します。 |
| `FileDownloadUrlTtlSeconds` | no | malware scan 済み file の download URL 有効秒数。既定値 300、範囲 60–3600 秒です。bucket policy もこの上限より古い download 署名を拒否します。 |

`WorkspaceDirectoryId`、`WorkspaceAuditPseudonymKey`、owner email / username は data key と認可境界に使います。環境ごとに固定し、通常の application deploy で変更しないでください。pseudonym key を変更すると既存 resource の audit timeline が分裂するため、通常の rotation 対象にはしません。

`InitialOwnerEmail` / `InitialOwnerUsername` の変更は通常 deploy と分けて owner rotation として扱います。新 owner の検証後、旧 owner の Cognito attributes、system-admin group、workspace/member/alias row、各 project role を明示的に棚卸ししてください。parameter 変更だけでは旧 owner の row や group membership は削除されません。

### Optional modules

社内の単一 Workspace で常に必要とは限らない次の機能は、CDK context でモジュールごとに `true` を
指定したときだけ作ります。既定では 1 つも作らず、関連する resource、output、parameter、runtime
wiring も stack に含めません。Context は `bin/cdk.ts` だけが読み、stack には Props として渡します。

| Context key | 作るもの | 無効時の動作 |
| --- | --- | --- |
| `mukuroji:restoreDrill` | [隔離 restore drill](#scheduled-isolated-restore-drill) の workflow、Object Lock evidence bucket（400日 COMPLIANCE）、専用 KMS key 2 個、alarm 14 個。`RestoreDrillCleanupApproverRoleArn` parameter が必要になります。 | 定期 drill は行いません。PITR による [incident recovery](#pitr-recovery) は引き続き使えます。削除済み file version は誰も読めません。 |
| `mukuroji:connectors` | Connector sync / poll worker、sync queue と DLQ、`ConnectorRuntimeSecret` と `ConnectorRuntimeConfiguration` parameter。 | API は connector provider を読み込まず、audit projection は connector への fan-out を行いません（`CONNECTOR_SYNC_ENABLED=false`）。Webhook と public API は使えます。 |
| `mukuroji:requestEmail` | 外部の mail relay が invoke する `RequestEmailIngestionFunction`、DLQ、alarm。`RequestEmailWebhookSecret` parameter が必要になります。 | 公開フォームと手動での依頼登録は使えます。メールからの依頼取り込みだけがありません。 |
| `mukuroji:tenantLifecycle` | テナントのエクスポートと閉鎖を実行する 6 つの resource owner Lambda（export、access、identity、data、secrets、verification）、それぞれの execution queue、エクスポート成果物を置く `TenantExportBucket`。API にはその bucket の読み取り権限を付けます。 | API はエクスポート・閉鎖の要求と、操作の download・pause・resume・verify を `503 TenantLifecycleNotDeployed` で断ります（`TENANT_LIFECYCLE_OPERATIONS=disabled`）。テナントのプロフィールとガバナンス設定、操作の参照は使えます。`TenantOperationFunction` は残り、監査ログの保持期間の処理だけを行います。 |
| `mukuroji:softwareFactory` | 追加の resource はありません。API と scheduled-jobs Lambda に `SOFTWARE_FACTORY=enabled` を渡し、scheduled-jobs Lambda に Agent Run triage job（毎分）とその IAM policy を足します。 | API は Agent Run（Web の Factory board・Work Item の Run 履歴と報告・期間サマリー・release、Public API の Agent Run 系と `/v1/agent-settings`・`/v1/agent-context`）と Team の agent 設定を認証前に `503 SoftwareFactoryNotDeployed` で断ります（`SOFTWARE_FACTORY=disabled`）。Agent Run triage job は動きません。Web は `/api/auth/me` の `softwareFactoryEnabled` を見て Factory board、Team の agent 設定、Work Item の「エージェントへ引き継ぐ」と Run 履歴、Project 概要の Agent Run 欄、ヘルプの coding agent ガイドを出しません。Public API の Work Item の読み書きと本人用 token（発行・rotate・失効）は使えます。Web の agent 接続は MCP の Workspace profile の設定例を出します。 |
| `mukuroji:agentAnalytics` | coding agent の telemetry 分析ストア：`AgentAnalyticsBucket`、Glue database と table 3 つ（partition projection）、Firehose stream 3 本（Parquet 変換・dynamic partitioning）、scan 上限 1 GiB の Athena workgroup。API に events・runs stream への `PutRecordBatch`、scheduled-jobs Lambda に日次の書き出し job（UTC 0 時）を足します。`mukuroji:softwareFactory` が必要です（[ADR 0118](../docs/adr/0118-agent-telemetry-analytics-store.md)）。 | API と job は Firehose に何も送りません。画面の集計（ADR 0117）はそのまま使えます。 |

有効にするときは、`cdk diff` / `cdk deploy` に context と、そのモジュールの parameter を足します。

```sh
bun --filter cdk cdk deploy Mukuroji \
  -c mukuroji:restoreDrill=true \
  -c mukuroji:requestEmail=true \
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  ...（通常の parameter）
```

`cdk.json` の `context` に `"mukuroji:connectors": true` のように書いても同じです。`true` と文字列の
`"true"` 以外の値は無効として扱います。

一度作ったモジュールを外すと、CloudFormation は Lambda、alarm、IAM role などを削除しますが、`Retain` の
resource は stack から外れるだけで AWS アカウントに残ります。残るのは table、bucket、secret、KMS key、
log group と、connectors の `ConnectorSyncQueue`・`ConnectorSyncDlq`・`ConnectorPollDlq`、requestEmail の
`RequestEmailIngestionDlq`、tenantLifecycle の 6 つの `Tenant*ExecutionQueue` と `TenantExportBucket` です。queue 内の message も保持期間までは残ります。Object Lock の evidence
bucket は保持期間が終わるまで削除できません。外す前に次を行ってください。

- そのモジュールの queue と DLQ が空であることを確認し、`cdk deploy` の output から queue URL と secret ARN を
  記録します。残った resource は記録した URL / ARN で後から確認し、不要なら手で削除します。
- tenantLifecycle を外す前に、実行中のエクスポートと閉鎖がないことを確認します。外したあとは worker が操作の
  record を受け取らないため、途中の操作は進まなくなります。完了済みのエクスポート成果物は `TenantExportBucket` に
  残りますが、API からは download できません。
- connectors を外すと `ConnectorRuntimeSecret` も stack から外れます。あとで再び有効にすると、stack は
  `ConnectorRuntimeConfiguration`（既定値 `{}`）で新しい secret を作るため、provider 設定は自動では戻りません。
  secret ARN が変わるので、再有効化の deploy では `ApiRuntimeConfigurationRevision` を増やします。
  再有効化の deploy が終わると SQS event source と 5 分ごとの poll がすぐ動き始め、値をコピーするまでの
  sync job は provider 設定がないため失敗します。`ConnectorSyncQueue` は visibility timeout 30 分、
  最大 5 回の受信で DLQ へ移します。例外で失敗した job はこの retry で再実行されるため、コピーが早いほど
  DLQ に入る job は減ります。
  次の順で復元してください。
  1. deploy 直後に、記録した旧 secret の値を新しい secret（`ConnectorRuntimeSecretArn` output）へコピーします。
  2. Warm Lambda は connector 設定を最大 60 秒 cache するため、コピー後 1 分以上待ちます。
  3. `ConnectorSyncQueue` の `ApproximateNumberOfMessagesVisible` と `ApproximateNumberOfMessagesNotVisible` が
     0 に戻るまで（retry 中の job は最大 30 分見えません）、`ConnectorSyncFunction` の log に新しい error が
     出ないことを確認します。
  4. それでも `ConnectorSyncDlq` に入った message は一括 redrive しません。`disconnect-links` は
     [Connector disconnect recovery](#connector-disconnect-recovery) の手順で扱います。`outbound` は provider への
     反映が漏れている可能性があるため、body の `workspaceId`・`linkId`・`sourceEventId` を記録し、installation は
     その external link から確認します。message は削除せずに運用責任者へエスカレーションし、対象を確認して
     から個別に再送するか判断します（link を特定できない場合も message を残したままエスカレーションします）。`poll` は次の定期実行が成功すれば
     取り直されるので、成功を確認してから削除します。

Developer platform の Webhook secret、connector credential、cursor state と connector runtime secret は、
1 つの `DeveloperPlatformKey` で暗号化します。用途ごとに `mukuroji:purpose` encryption context を付け、
IAM grant も用途ごとの condition で絞っているため、key を分けなくても用途をまたいだ復号はできません。

### Optional SSO and AI

SSO と AI は独立したオプションです。新規 stack では、SSO は関連 parameter をすべて省略すると無効になります。AI は `AiExternalProviders` が既定で有効なため、無効にするには Bedrock の parameter を省略したうえで `AiExternalProviders=` を空にします。一部だけの指定は CloudFormation rule が拒否します。SSOはruntimeでも不完全な設定を拒否し、password loginへ暗黙に切り替えません。

- SSO: `CognitoSsoUserPoolClientId`、`CognitoHostedUiDomain`、`CognitoSsoRedirectUri`、`CognitoEnterpriseIdpName`、`EnterpriseSsoStateSecret` の5項目をまとめて設定します。未設定時はSSO discovery/redirectと保存済みdomainのSSO強制を使わず、通常のpassword/MFA loginを使います。
- AI: `AiBedrockModelId`、`AiBedrockModelArn`、input/outputの両token単価をまとめて設定します。現在サポートするJP profileには `AiBedrockDestinationModelArns` も必要です。Bedrock が未設定で `AiExternalProviders` も空のときは保存済みWorkspace policyにかかわらずAI操作を拒否し、Bedrock呼び出しIAM policyを作らず、AI observabilityのstream mappingを無効にします。データ保持のため既存table、queue、log、worker定義は維持します。Webの別途opt-in buildは不要です。
- 外部 AI provider: `AiExternalProviders`（既定 `anthropic,openai`）で、Workspace 管理者が API キーを登録して使える provider を決めます。空にすると Bedrock だけになります。Bedrock が未設定でもこの値が空でなければ AI は有効になり、AI observability の stream mapping も有効です。API キーは Secrets Manager ではなく既存の `DeveloperPlatformKey` で暗号化して Workspace Search table に保存するため、固定費は増えません（[ADR 0036](../docs/adr/0036-ai-external-provider-workspace-keys.md)）。

既存stackの更新ではCloudFormationが前回のparameter値を保持するため、省略だけでは無効化されません。無効にするサービスの上記全parameterへ明示的に空文字を渡し、`ApiRuntimeConfigurationRevision` を更新してください。たとえばAIを止めるなら `--parameters AiBedrockModelId=` に加え、ARN、単価2項目、destination ARN、`AiExternalProviders=` も空にします。Bedrock だけを止めて外部 provider を残す場合は `AiExternalProviders` を空にしません。SSOなら5項目をすべて空にします。API version/aliasの切り替えで新しい設定が適用されます。既に開始した呼び出しの即時取り消しは行いません。

Workspace、複数Project/Team、権限、監査、backup、export/closureは引き続き利用できます。商用plan、seat quota、月次課金集計はありません。

## 費用の目安と予算 alert

新しい環境を作る前に、この節で月額の目安を確認してください。金額は 2026 年 11 月時点の東京リージョン（`ap-northeast-1`）の公開価格をもとにした概算で、税は含みません。実際の額は Cost Explorer で確認します。

### 予算 alert

Stack は AWS Budgets の月次コスト予算（`MonthlyCostBudget`）を 1 つ作り、次のときに email を送ります。予算そのものは無料です。

- その月の実績が予算の 80% を超えたとき
- その月の実績が予算の 100% を超えたとき
- その月の予測が予算の 100% を超えたとき

| Parameter | 既定値 | 説明 |
| --- | --- | --- |
| `MonthlyCostBudgetUsd` | `20` | 月の予算（USD、1〜100000）。既定値は利用者 50 人程度（試算で約 $16〜19）までの目安です。下の試算を見て環境ごとに決めます。 |
| `CostBudgetAlertEmail` | 空 | alert の送信先 email。空なら `InitialOwnerEmail` へ送ります。 |

- 予算は AWS アカウント全体の費用を対象にします。cost allocation tag で絞らないのは、tag は Billing console で有効にするまで Budgets に届かず、data transfer や税のように tag の付かない費用もあるためです。Mukuroji 専用のアカウントに deploy してください。他のシステムと同じアカウントでは、他のシステムの費用も合算されます。
- Budgets は請求データを 1 日に数回まとめて評価するため、通知は費用の発生から最大 1 日ほど遅れます。急な増加をすぐ止める仕組みではありません。
- 通知が来たら、Cost Explorer の service 別の内訳で増えた service を確かめ、下の固定費・試算と比べます。任意 module、AI、SES の利用、Lambda の実行時間が主な増加要因です。
- email は AWS Budgets（`budgets@costalerts.amazonaws.com`）から届きます。購読の確認は不要です。迷惑メールに入らないよう、受信側で許可してください。

### Cost allocation tag

Stack は tag を付けられる resource すべてに `mukuroji:application=mukuroji` を付けます（AppConfig の deployment と deployment strategy は、tag を変えると作り直しになるため除きます。どちらも課金されません）。Cost Explorer で Mukuroji の費用を分けて見るには、deploy 後に management account で tag を cost allocation tag として有効にします。

```sh
# tag は resource ができてから最大 24 時間で一覧に出ます
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=mukuroji:application,Status=Active
```

有効にした日以降の費用だけが tag で集計されます。過去の分はさかのぼりません。

### 既定構成の固定費

任意 module をすべて無効にした既定構成で、利用がなくてもかかる費用です。合計はおよそ **月 $6〜8** です。

| 構成要素 | 数 | 月額の目安 | 備考 |
| --- | --- | --- | --- |
| CloudWatch metric alarm | 23 個（25 metric） | 約 $1.50 | $0.10 / alarm metric。アカウントの無料枠 10 metric を差し引いた額です。AI の alarm 10 個は AI を有効にしたときだけ作ります（下の増分の表）。`AiExternalProviders` は既定で有効なので、既定の deploy ではこの 10 個（約 $1）も加わります。Bedrock を設定せず `AiExternalProviders=` を空にすると作りません。 |
| CloudWatch composite alarm | 1 個 | $0.50 | |
| CloudWatch custom metric（EMF） | 約 15 系列 | 約 $1.50 | $0.30 / metric。アカウントの無料枠 10 metric を差し引いた額です。`Mukuroji/RuntimeControl` 5 個（毎分の heartbeat）、`Mukuroji/API` 6 個（API が呼ばれている時間だけ）、`Mukuroji/Notifications` 4 個（Slack と Email の channel ごと）。AI を設定すると `Mukuroji/AIAssistance` が増えます。metric は data が届いた時間単位で課金されるため、dimension を 1 つ足すと系列の数だけ固定費が増えます。 |
| Secrets Manager secret | 4 個 | $1.60 | $0.40 / secret。inbound automation Webhook を 1 つ作るごとに secret が 1 つ増えます。 |
| KMS customer-managed key | 1 個（`DeveloperPlatformKey`） | $1.00 | request 料金は少量です。 |
| DynamoDB table（on-demand、PITR 有効） | 26 個 | $0.1〜0.5 | 保存量 25 GB までは無料枠。PITR は保存量 1 GB あたり約 $0.23 です。 |
| EventBridge の毎分 rule と `ScheduledJobsFunction` | 1 個 | ほぼ $0 | 月 43,200 回の起動（1,024 MB）は、1 回が平均数秒で終われば Lambda の無料枠（100 万 request、40 万 GB 秒）に収まります。無料枠はほかの Lambda と共有です。job が読む DynamoDB の料金は数十セントです。 |
| SQS の待機中の polling | 3 queue | $0〜1 | Lambda の event source が空の queue を long polling し続けます。無料枠は月 100 万 request、超えた分は $0.40 / 100 万です。 |
| X-Ray | application Lambda | $0 | 既定の `LambdaTracingMode=PassThrough` では trace を記録しません。調査で必要なときだけ `Active` にします（[X-Ray tracing の切り替え](#x-ray-tracing-の切り替え)）。 |
| CloudWatch Logs | 22 log group（90 日保持、data migration は 365 日） | ほぼ $0 | 月 5 GB まで無料。超えた分は取り込み $0.76 / GB です。 |
| GuardDuty Malware Protection for S3 | 1 plan | ほぼ $0 | 無料枠は月 1,000 object・1 GB。超えた分は scan した容量（米国東部で $0.09 / GB）と評価した object 数で課金されます。 |
| Cognito user pool（Essentials） | 1 個 | $0 | 月 10,000 MAU まで無料。SAML / OIDC 連携の利用者は無料枠が小さく、超えると MAU 単位で課金されます。 |
| CloudFront、S3、AppConfig、AWS Budgets | — | ほぼ $0 | CloudFront は月 1 TB・1,000 万 request まで無料です。 |

固定費の大半は alarm、secret、KMS key、custom metric です。alarm を減らすときは、通知の契約（[Alarm destination contract](#alarm-destination-contract)）と [`docs/operational-readiness.md`](../docs/operational-readiness.md) の alarm 一覧を確認してから、別の変更で行います。

### 任意 module を有効にしたときの増分

| Context key / 設定 | 増える固定費の目安 | 主な内訳 |
| --- | --- | --- |
| `mukuroji:restoreDrill` | +$3.5 / 月と復元ごとの料金 | KMS key 2 個（$2）、alarm 14 個（$1.40）、Step Functions。drill ごとに PITR の復元料金（復元量 1 GB あたり約 $0.17）と一時 table の料金がかかります。 |
| `mukuroji:connectors` | +$1 前後 / 月 | secret 1 個、alarm 3 個、5 分ごとの poll（月 8,640 回）、queue の polling。 |
| `mukuroji:requestEmail` | +$1 / 月 | secret 2 個、alarm 2 個。 |
| `mukuroji:tenantLifecycle` | +$0〜2 / 月 | Lambda 6 個と queue 6 個。待機中の queue polling が SQS の無料枠を超えた分です。 |
| `mukuroji:softwareFactory` | ほぼ $0 | 毎分の Agent Run triage job。opt-in した Team がなければ AgentRuns table の index を読むだけです。 |
| `mukuroji:agentAnalytics` | 利用量に比例（50 人で月 $1 前後） | Firehose は受けた量 1 GB あたり約 $0.09（Direct PUT・Parquet 変換・dynamic partitioning）、Athena は scan 1 TB あたり $5。待機中は S3 の保存分だけです。 |
| AI（Bedrock の parameter 設定、または `AiExternalProviders` が空でない。既定は有効） | +$1 / 月と利用量に比例 | AI の alarm 10 個（$1）。Bedrock と外部 provider で共有し、両方を使っても増えません。token 料金の上限は Workspace の AI 設定で決めます。 |
| AI（Claude API・OpenAI のキー登録） | 利用量に比例 | token 料金は各提供元へ直接かかります。AWS 側はキー復号の KMS request（1万回あたり約 $0.03）だけです。 |
| `LambdaTracingMode=Active`（X-Ray） | 利用量に比例 | 月 10 万 trace まで無料、超えた分は $5 / 100 万 trace。sampling は 1 秒あたり 1 request と残りの 5% で、毎分の job だけで月約 4.3 万 trace、50 人で月約 70 万 trace（約 $3）です。 |
| `NotificationEmailSender`（SES） | 利用量に比例 | 1,000 通あたり約 $0.10。 |
| `CognitoEmailSender`（SES） | 利用量に比例 | 招待と再設定のメール。1,000 通あたり約 $0.10。 |

### 任意化しない構成要素と毎分 job の費用

次の構成要素は、無効にしても下がる固定費がほとんどないため、任意 module にしていません（2026 年 11 月に確認）。費用を下げたいときは、上の任意 module と AI の設定から見直してください。

| 構成要素 | 無効にして下がる固定費 | 任意化しない理由 |
| --- | --- | --- |
| SCIM group job と enterprise identity maintenance の worker | 約 $0.20 / 月（DLQ の alarm 2 個） | DynamoDB stream で起動する Lambda なので、待機中は stream の読み取りも含めて課金されません。event filter で SCIM の group job と identity maintenance の記録だけを受けるため、SCIM を使わない Workspace では起動しません。 |
| AI assistance の observability worker | $0 | DynamoDB stream で起動し、alarm 5 個は AI を設定したときだけ作ります（上の増分の表の「AI」）。 |
| X-Ray | $0 | 既定の `LambdaTracingMode=PassThrough` で記録しません。 |
| GuardDuty Malware Protection for S3 | $0 | 料金は scan した容量と object 数だけです。無効にすると upload した file を scan できず、download を許す条件（scan 済みの tag）が成り立たないため、必須にしています。 |

`ScheduledJobsFunction` は毎分 1 回起動し、その分に実行する job だけを動かします（毎分: Automation、Triage、Agent Run triage、Slack 通知、Email 通知、Web Push 通知、Email の bounce / complaint 取り込み。5 分: Analytics。60 分: 通知の予定、Cycle。6 時間: 祝日の取り込み）。毎分の job は、対象を期限の sparse index（Automation の `ScheduleDueIndex`、Triage の `triage-wake-index` の 8 partition、通知の配信待ち index）から query して読むため、対象がない分は空の query だけで終わります。Software factory を deploy しない環境では Agent Run triage を動かしません。月 43,200 回の起動は Lambda の無料枠に収まる見込みで、DynamoDB の読み取りは月数十セントです。間隔を延ばすと期限の通知や Automation の実行が最大でその分遅れるため、毎分のままにしています。

### 利用規模ごとの試算

1 人が 1 営業日に API を約 1,500 回呼ぶと仮定した試算です。Document 画面は WebSocket の変更通知を受けている間、本文・comment・presence の再取得を 60 秒ごとに落とすため、1 時間開いても約 500 回です（WebSocket がない環境や接続断では従来の 3.5〜4 秒ごとの polling に戻り、1 時間で約 3,400 回になります。ADR 0041）。月 20 営業日、既定構成、AI なしで計算しています。

| 利用者 | API request / 月 | 従量費の目安 | 合計の目安 |
| --- | --- | --- | --- |
| 10 人 | 約 30 万 | 約 $2〜3 | 約 $8〜11 |
| 50 人 | 約 150 万 | 約 $4〜5 | 約 $10〜13 |
| 200 人 | 約 600 万 | 約 $19〜23 | 約 $25〜31 |

従量費の主な内訳は HTTP API（$1.29 / 100 万 request）、DynamoDB の読み書き、Lambda（無料枠を超えた request と実行時間）、CloudWatch Logs の取り込み、WebSocket の接続時間と message（Document の変更通知は 100 万件あたり $1.14）です。税（日本の請求では消費税 10%）、独自 domain の Route 53 hosted zone（$0.50 / 月）、AI の token 料金は含みません。利用者が増えたら、まず Cost Explorer の service 別の内訳で HTTP API と Lambda の伸びを確認してください。

### X-Ray tracing の切り替え

既定では X-Ray に trace を記録しません。障害調査で API の流れを trace で追いたいときだけ、
`--parameters LambdaTracingMode=Active` を付けて deploy します。調査が終わったら `PassThrough` に戻してください。
切り替えで変わるのは Lambda の tracing mode と state machine の tracing flag だけで、IAM role は変わりません。
API は alias が指す published version で動き、version の tracing mode は公開後に変えられないため、`LambdaTracingMode` を変えた deploy では API の新しい version を公開して alias を切り替えます（`ApiRuntimeConfigurationRevision` の増分は不要です）。
`PassThrough` の間は API log の `traceId` に対応する trace が X-Ray にないため、`invocationId` と UTC の時間帯から
Lambda log を起点に調査します（[`docs/operational-readiness.md`](../docs/operational-readiness.md)）。

## API observability

Application Lambda と restore drill の state machine は `LambdaTracingMode` parameter に従います。既定の
`PassThrough` では X-Ray に trace を記録せず、`Active` にすると active tracing になります。各 execution
role には切り替えても role が変わらないよう、X-Ray が要求する trace/telemetry write action だけを常に追加します。API Lambda は readiness probe 用に
`AuditEventsTable`、`WorkItemsTable`、`WorkspaceAccessTable` への `dynamodb:DescribeTable` だけを
持つ独立 policy を使います。

Stack は API Lambda の `Errors`、`Throttles`、p95 `Duration`（12秒）、HTTP API の 5xx、
application EMF の `ServerErrorCount` を CloudWatch alarm として作成します。51 metric alarmと
1 composite alarmのうち、notification無効のfast-burn component 2件を除く50件の
`AlarmActions` は、必須parameterで指定した既存のprimary/secondary SNS topicへ接続します。
AI の alarm 10件（`AiAssistance*`）は AI を設定した stack にだけ作ります。
Stackはtopic、subscription、Incident Manager escalation planを作成・変更しません。Topic ownerは
同一account/regionのstandard topicを用意し、managed rosterへのsubscription、暗号化key policy、
test notificationの受信をdeploy前に確認してください。CloudWatchはalarm遷移時に両topicへ同時に
publishするため、ack target未達時の段階escalationはsubscription先のon-call systemで管理します。
非同期 worker の DLQ alarm に加え、Notification schedule は failure destination 自体への配信失敗を
`DestinationDeliveryFailures` で別に検出します。Audit projection、Automation event/schedule、
Analytics/Notification schedule、Enterprise SCIM group/identity maintenance の各 DLQ は14日保持し、
stack replacement/delete 時にも Retain します。

AI assistance は `ProviderFailureCount`、`ProviderThrottledCount`、
`ProviderInvalidOutputCount`、p95 `ProviderLatency`、`UsageUnavailableCount` の5 provider alarmに加え、
観測workerの`ProjectionFailureCount`、Lambda `Errors` / `Throttles`とDynamoDB stream `IteratorAge`の
4 projection-health alarmを
持ちます。provider attempt と user decision のEMFは、明示的に有効化したevent-source mappingで
`WorkspaceSearchTable` のterminal rowを専用LambdaがDynamoDB Streamsから投影します。terminal
mutation自体はtransaction/CASで一度だけcommitされますが、
stream deliveryはat-least-onceであり、成功応答喪失、partial-batch retry、manual replayではmetricが
稀に重複し得ます。WorkerにはAPIと同じ`ApplicationCommitSha` parameterを
`MUKUROJI_APPLICATION_COMMIT_SHA`として渡し、live evidenceは`Service`と`ApplicationCommitSha`のexact dimension setで
対象deployへ帰属させます。Event-source mappingは初回作成時に`LATEST`から開始するため、worker導入前のterminal rowを
historical replayしません。Partial batch responseはLambda `Errors`を増やさないため、handlerがpartial-batch
failureとして返したrecord数を`ProjectionFailureCount`へ集約し、専用alarmで検出します。DynamoDB Streamsが
実際に再試行する範囲はlowest failed sequence以降を含み得るため、このmetricをretry総record数とは解釈しません。
Worker logは90日保持・Retainの明示LogGroupへ保存します。
retryを使い切ったrecordは14日保持・Retainの`AiAssistanceObservabilityDlq`へ隔離し、別のDLQ alarmが
visible messageを検出します。このqueueはraw DynamoDB recordではなく
`DDBStreamBatchInfo`だけを受け取るため直接redriveせず、24時間以内のexact stream range復元と
限定invoke、または期限超過時のmetric gap処理を`docs/operational-readiness.md`の専用手順で行います。
`LATEST`はmapping作成後のretryやDLQをdrainした証拠ではないため、live promotionではIteratorAgeの低下、worker
Errors / Throttles 0、DLQ empty、late datapointがないことを別途確認します。

### Alarm destination contract

このstackは外部topicの存在、resource policy、KMS key policy、subscriptionを変更しません。
Deploy前に両topicの`GetTopicAttributes`と`ListSubscriptionsByTopic`を取得し、次をすべて
environment evidenceへ保存します。

- ARNがdeploy対象と同じpartition/account/regionと指定topic名を持つ。
- Confirm済みsubscriptionが1件以上あり、primary/secondaryが異なるmanaged destinationへ到達する。
- Topic policyが`cloudwatch.amazonaws.com`の`sns:Publish`を許可し、
  `aws:SourceAccount=<target-account>`と
  `aws:SourceArn=arn:<partition>:cloudwatch:<region>:<target-account>:alarm:*`の両方で制限する。
- SSE topicは編集可能なcustomer-managed KMS keyを使用し、同じCloudWatch principalへ
  `kms:GenerateDataKey*`と`kms:Decrypt`を許可する。KMS policyも同じSourceAccount/SourceArnで
  制限し、keyがtarget account/regionでenabledであることを確認する。

Operator自身の`sns:Publish`だけではCloudWatch principalとKMS経路を検証できません。Deploy後は
同じ両topic actionを持つcontrolled test alarmを実際に`OK → ALARM`へ遷移させ、CloudWatch alarm
history、両subscriptionの受信時刻/message ID、`ALARM → OK`への復帰を保存します。全52 alarmの
`AlarmActions`がprimary/secondaryの2 ARNを含み、inventory済みの既存actionも保持していることを
templateとdeployed configurationの両方で照合します。

## Outputs

- `WebUrl`: アプリの正規 URL。`cdk.json` の `mukuroji:webDomainName` を指定した場合はその domain、空なら CloudFront の domain
- `WebDistributionDomainName`: CloudFront distribution の domain（`dxxxx.cloudfront.net`）。独自 domain の DNS を stack の外で設定するときの向き先
- `WebBucketName` / `WebDistributionId`: `bun run web:deploy` が使う Web bucket と distribution
- `ApiGatewayUrl`: API Gateway HTTP API URL（外部 webhook と、local の Web から直接呼ぶ場合）
- `UserPoolId` / `UserPoolClientId`: API が使う Cognito user pool と password client（stack が作ったものか、parameter で渡したもの）
- `WorkItemsTableName`（canonical Work Item store）
- `WorkItemConfigurationTableName`（workflow、custom field、relation graph の scope store）
- `PlanningTableName`（cycle、goal、milestone、roadmap、portfolio の計画 store）
- `DocumentsTableName`（document、whiteboard、share、comment の workspace store）
- `AnalyticsTableName`（report、immutable snapshot、scheduled delivery receipt の store）
- `RequestIntakeTableName`（form version、link capability、submission、queue、reply thread の scope store）
- `RequestEmailIngestionFunctionName`, `RequestEmailIngestionDlqUrl`（`mukuroji:requestEmail` 有効時のみ）
- `ProjectDirectoryTableName`, `TeamIssueEventsTableName`
- `FileProofingTableName`, `FileBucketName`, `FileMalwareProtectionPlanId`
- `FileBucketIncarnationMarkerKey`, `FileBucketIncarnationMarkerVersionId`, `FileBucketIncarnationMarkerChecksumSha256`, `FileBucketIncarnationMarkerSize`（同名 bucket 再作成を検出する固定 marker の exact S3 version、base64 SHA-256、byte size。cross-domain integrity operator の明示入力に使い、current version へ fallback しない）
- `DataMigrationFunctionName`, `DataMigrationCheckpointTableName`, `DataMigrationOperatorPolicyArn`（operator が起動する data migration の Lambda、checkpoint と run record の table、その Lambda の invoke だけを許す未接続 policy。下記「Data migration」）
- `CrossDomainIntegrityOperatorPolicyArn`（6表の `Scan` / `DescribeTable`、exact FileBucket の `GetBucketVersioning`、`workspaces/*` の exact-version read、出力された marker VersionId に条件固定した marker exact-key read だけを持つ未接続 read-only policy）
- `NotificationsTableName`, `CollaborationProjectionDlqUrl`
- `ScheduledJobsFunctionName`, `ScheduledJobsDlqUrl`（定期ジョブをまとめて実行する Lambda と、その失敗を14日保持する Retain DLQ）
- `AuditEventsTableName`, `ProcessedAuditEventsTableName`
- `EnterpriseIdentityMaintenanceDlqUrl`
- `EnterpriseScimGroupJobFunctionName`, `EnterpriseScimGroupJobDlqUrl`
- `EnterpriseIdentityTableName`（Workspace generation/`CONTROL` checkpoint、global domain claim、SSO/policy/role、SCIM projection、provisioning run の store。Enterprise Identity 専用 GSI は持ちません）
- `WorkItemCollaborationTableName`, `RealtimeSessionsTableName`, `RealtimeWebSocketUrl`
- `WorkspaceSearchTableName`（検索文書、saved/task view、ユーザー別 view preference、24 時間保持の task view mutation receipt、保持期限付きAI generation/idempotency/feedback/budget record。期限付きrowは `expiresAt` TTL で失効）
- `AiAssistanceObservabilityDlqUrl`（terminal AI observability stream recordの最終失敗を14日保持するRetain DLQ）
- `RestoreDrillStateMachineArn`, `RestoreDrillCleanupStateMachineArn`
- `RestoreDrillEvidenceBucketName`, `RestoreDrillScratchBucketName`, `RestoreDrillStateTableName`
- `RestoreDrillCleanupApprovalPolicyArn`, `RestoreDrillScheduleDlqUrl`（`RestoreDrill*` は `mukuroji:restoreDrill` 有効時のみ）
- `DeveloperPlatformTableName`, `DeveloperPlatformLookupIndexName`
- `WebhookDeliveryQueueUrl`, `WebhookDeliveryDlqUrl`
- `WorkItemImportBucketName`, `WorkItemImportQueueUrl`, `WorkItemImportDlqUrl`
- `ConnectorRuntimeSecretArn`, `ConnectorSyncQueueUrl`, `ConnectorSyncDlqUrl`, `ConnectorPollDlqUrl`（`mukuroji:connectors` 有効時のみ）
- `TenantOperationFunctionName`, `TenantOperationDlqUrl`（テナント操作の開始と監査ログ保持の一括処理。新しい監査 event 1 件ごとの保持期間の反映は audit projection が行います）
- `TenantExportCapabilityFunctionName` など 6 つの `Tenant*CapabilityFunctionName`（`mukuroji:tenantLifecycle` 有効時のみ）
- `WorkspaceDirectoryId`

CloudFront は `/api/*` を cache せず、Host 以外の viewer header をそのまま HTTP API へ渡します。
HTTP API から見た接続元は CloudFront の edge address になるため、viewer-request の CloudFront Function が
client の送った値を上書きして `x-mukuroji-viewer-address` に viewer address を入れ、origin custom header
`x-mukuroji-edge-secret` に `EdgeOriginSecret` を付けます。API は secret が一致した request だけ
この address を request intake の rate limit と Enterprise IP policy に使い、HTTP API を直接呼ぶ request
では両 header を無視して transport の接続元を使います。`EdgeOriginSecret` を変えると CloudFront と
Lambda が同じ deploy で切り替わりますが、切り替え中の数分は一部の request が edge address で判定されます。
それ以外の path は Web bucket から返し、拡張子のない path は CloudFront Function が `index.html` に
書き換えるため、client-side route を直接開いても SPA が表示されます。この書き換えは `/api/*` には
かからないので、API の 404 はそのまま返ります。HTTP API は `<base>/teams/projects` と
`<base>/api/teams/projects` を同じ canonical `/api` route へ正規化します。

### 独自 domain で配信する

独自 domain は `cdk/cdk.json` の `context` で指定します。3つとも空（既定）のあいだは CloudFront の domain だけで
配信し、distribution・DNS・link は従来どおりです。`-c mukuroji:webDomainName=...` のように command line で
上書きもできますが、GitHub Actions の deploy は `cdk.json` の値を使うため、本番の domain は `cdk.json` を変える
PR で切り替えます。

```json
"context": {
  "mukuroji:webDomainName": "wbs.example.com",
  "mukuroji:webCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/...",
  "mukuroji:webHostedZoneId": "Z0123456789ABCDEFGHIJ",
  ...
}
```

| Context key | 必須 | 説明 |
| --- | --- | --- |
| `mukuroji:webDomainName` | no | Web app と `/api` を配信する独自 domain（例: `wbs.example.com`、小文字）。指定すると `WebUrl`、通知 Email の link、Cognito の招待・パスワード再設定メールの link がこの domain になります。 |
| `mukuroji:webCertificateArn` | `mukuroji:webDomainName` 指定時 | `mukuroji:webDomainName` を含む、**us-east-1** の発行済み ACM 証明書 ARN。CloudFront は us-east-1 の証明書しか読めません。 |
| `mukuroji:webHostedZoneId` | no | `mukuroji:webDomainName` の A / AAAA alias record を stack に作らせる Route 53 public hosted zone ID。空なら DNS は stack の外で設定します。 |

domain と証明書の片方だけ、または hosted zone だけを指定した場合や、形式が違う値は `cdk synth` / `cdk deploy` の
時点で止まります。指定すると同じ distribution が独自 domain でも Web app と `/api/*` を配信し、証明書は
TLSv1.2_2021 の viewer policy と SNI で使います。CloudFront の domain（`WebDistributionDomainName`）も
引き続き使えます。

1. **us-east-1** の ACM で domain の証明書を発行し、DNS 検証を済ませます（ACM の公開証明書は無料）。
2. `cdk.json` に domain と証明書 ARN を書きます。domain の hosted zone が同じ account の Route 53 にあれば
   `mukuroji:webHostedZoneId` も書き、stack に A / AAAA alias を作らせます。それ以外の DNS では、domain の
   CNAME を output の `WebDistributionDomainName` に向けます。
3. 画面と `/api` は同じ origin なので、`ApiAllowedOrigins`（API の CORS）は変えなくて構いません。
   ブラウザの error 送信が受け付ける origin（`WEB_APP_ORIGINS`）にも、独自 domain と CloudFront domain を stack が自動で入れます。
   file bucket の CORS には独自 domain と CloudFront domain の両方を stack が自動で入れます。
4. Enterprise SSO を使う場合は、Cognito の SSO app client の callback URL を
   `https://<domain>/auth/sso/callback` に変え、同じ値を `CognitoSsoRedirectUri` に指定して deploy します。
   独自 domain の指定中に `CognitoSsoRedirectUri` が空でもこの値でもないと、CloudFormation の rule
   （`WebSsoCallbackOnCustomDomain`）が deploy 前に止めます。callback は1件だけ許可するため、切り替え後は
   CloudFront の domain からの SSO login は使えません。
5. `bun run web:deploy` で配信し直す必要はありません。PWA の `manifest.webmanifest` は `start_url` と `scope` を
   相対 path で持つため、独自 domain でそのまま install できます。ただし PWA と Web Push の購読は origin ごとなので、
   CloudFront の domain で install・購読した利用者には、独自 domain で開き直して入れ直してもらいます。

domain を変えると distribution の alias と証明書は同じ resource の更新で切り替わり、Route 53 の record は
作り直されます。`cdk.json` の値を空に戻すと独自 domain の alias と record は外れます。

Lambda Function URL は作りません。外部 sender に渡す signed inbound webhook URL は Lambda の version
に依存しない安定した HTTP API endpoint を使い、CloudFront の origin も同じ HTTP API にそろえます。

Shared APIのproduction runtime configurationは1つのSecrets Manager secret
(`ApiRuntimeConfigurationSecret`)にまとめ、Lambda environmentにはそのARNと
`MUKUROJI_API_RUNTIME_CONFIG_REVISION`だけを渡します。Secret名は固定で、deployごとに値を
in-placeで更新するため、revisionを進めてもsecretは増えません。Stack削除時は`Retain`されます。
Envelopeはtransformを使わないv3 line formatで、revisionとcanonical Base64 valueまたはnested
Secret ARNを保持します。NoEcho parameterもenvelopeの`Fn::Join`へ直接入ります。stackは
transformを使わないため、processed templateへ値が展開されることはありません。Workspace audit
pseudonym secretとDocument public-share secretの2つだけをnested secretとして参照し、API roleが
読みます。Loaderは`AWSCURRENT`のrevisionが期待値と違えば`AWSPREVIOUS`を読み、どちらも一致しなければ
起動を拒否します。全canonical keyとnested secretを検証し終えてから環境へ原子的に反映します。

API Gatewayのdefault routeは`live` Aliasを呼び出します。新しいconfiguration
secretとLambda Versionの準備完了後にAliasが新Versionへ切り替わるため、API trafficは
code/configurationが揃ったversion単位で切り替わります。

## Bedrock AI assistance boundary

API Lambdaにはstack region、exact default/allowlisted model ID、既存Workspace Search table名を
`AI_ASSISTANCE_BEDROCK_REGION`、`AI_ASSISTANCE_DEFAULT_MODEL_ID`、
`AI_ASSISTANCE_ALLOWED_MODEL_IDS`、`AI_ASSISTANCE_TABLE_NAME`として直接bindします。review済みinput/output
単価も `AI_ASSISTANCE_BEDROCK_*_PRICE_PER_MILLION_TOKENS_USD` としてbindし、provider token usageから
generation recordの推定costを算出します。加えて
Workspace/memberの1分固定窓generation上限（32 / 4）とtoken予約上限
（32,000,000 / 4,000,000、1 keyあたり1,000,000）を`AI_ASSISTANCE_*_PER_MINUTE` /
`AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION`へ固定します。AI recordは
既存tableのAI専用key prefixへ保存し、新しいtableは作成しません。同期10–12秒のmodel callに対して
Lambda timeoutは20秒ですが、p95 12秒alarmは維持します。

Production認証はLambda execution roleの短期credentialとSigV4だけを使い、
`AWS_BEARER_TOKEN_BEDROCK`、static access key、Bedrock API keyを設定しません。IAM actionは
non-streamingの`bedrock:InvokeModel`だけで、exact configured ARN以外を許可しません。Local profile、
JP profile/destination ARN inventory、scheduled live evalを含む完全な手順は
[`docs/ai-assistance.md`](../docs/ai-assistance.md)を参照してください。

## Connector runtime configuration

この節は任意モジュール `mukuroji:connectors` を有効にした stack だけが対象です（[Optional modules](#optional-modules)）。Stack は provider 設定と signing secret 用の Secrets Manager secret を `{}` で作成し、rotation-enabled な `DeveloperPlatformKey` で暗号化します。Secret の read 権限は OAuth callback を扱う API Lambda と provider 呼び出しを行う connector queue worker に限定します。Audit stream projection と scheduled poller は secret を読まず、secret-free な sync job ID だけを SQS へ送ります。

Production credential を CloudFormation parameter、Lambda environment、repository、`cdk diff`、shell history に含めないでください。初回 deploy 後に `ConnectorRuntimeSecretArn` output を取得し、権限を限定した作業端末から reviewed JSON file を新しい secret version として保存します。

```sh
export CONNECTOR_RUNTIME_SECRET_ARN="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='ConnectorRuntimeSecretArn'].OutputValue | [0]" \
  --output text)"

aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$CONNECTOR_RUNTIME_SECRET_ARN" \
  --secret-string file://connector-runtime.production.json
```

Secret JSON は string value の object とし、次の key だけを許可します。

- `MUKUROJI_CONNECTOR_PROVIDERS_JSON`
- `CONNECTOR_OAUTH_STATE_SIGNING_SECRET`
- `CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON`
- `CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET`
- `CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON`
- `CONNECTOR_REAUTHORIZATION_RETURN_URL`
- provider client secret 用の `MUKUROJI_CONNECTOR_<NAME>` key

`MUKUROJI_CONNECTOR_PROVIDERS_JSON` 自体は JSON array を文字列化した値です。各 provider entry の `clientSecretEnvironmentVariable` は同じ secret object 内の `MUKUROJI_CONNECTOR_<NAME>` を参照させます。Signing secret はそれぞれ独立した十分に長い random value を使います。Warm runtime も約1分の TTL 後に secret を再取得するため、更新は cold start を待たずに反映されます。

`github` の entry は、`resources` を書かなければ同梱の issue 同期を使い、`provider`・`clientId`・
`clientSecretEnvironmentVariable`・`redirectUri` の 4 項目だけで動きます。GitHub OAuth App の endpoint、token と
account の対応（`access_token`、`/user` の `id` と `login`）、scope `repo`、許可 host（`github.com`、`api.github.com`、
`redirectUri` の host）は省略時に補われ、書いた値が優先されます。例:

```json
[{"provider":"github","clientId":"Iv1.xxxx","clientSecretEnvironmentVariable":"MUKUROJI_CONNECTOR_GITHUB_SECRET","redirectUri":"https://<domain>/api/developer/connector-oauth/callback"}]
```

GitHub の OAuth App では Authorization callback URL に同じ `redirectUri` を登録します。`resources` を書いた `github`
entry は従来どおり REST の対応付けで動きます。

`google-calendar` と `outlook-calendar` の entry には `resources` を書きません。予定の読み書きは組み込みの処理が
行い、`resources` があると起動時に拒否します。`apiBaseUrl` は Google なら `https://www.googleapis.com/calendar/v3/`、
Outlook なら `https://graph.microsoft.com/v1.0/` とし、scope には予定の読み書き
（Google は `https://www.googleapis.com/auth/calendar.events`、Outlook は `Calendars.ReadWrite` と `offline_access`）を含めます。

Provider の OAuth callback（`/api/developer/connector-oauth/callback`）は接続を完了せず、state と code を URL fragment に載せて Web の `/settings/connectors/oauth-callback` へ 303 で引き渡します。接続を始めた本人がログインしたまま、その画面から `POST /api/developer/connector-oauth/complete` を呼んで完了します。CloudFront 経由で Web と API が同じ origin にある通常の構成では設定は不要です。provider に登録した redirect URI が Web と別の API origin を指す場合（local の Web から HTTP API を直接使う場合など）は、API の process 環境変数 `CONNECTOR_OAUTH_WEB_ORIGIN` に Web の origin（例: `http://localhost:5173`）を設定します。https の origin、または localhost の http origin だけを受け付けます。

OAuth state signing key は、warm runtime の旧・新 keyring が混在しても相互検証できるよう次の順序で rotation します。

1. 旧 key を `CONNECTOR_OAUTH_STATE_SIGNING_SECRET` に維持したまま、新 key を JSON array 文字列の `CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON` へ verification-only key として追加します。
2. Cache TTL（現在は約1分）と secret 伝播の猶予を待ち、すべての warm runtime が新 key を検証できる状態にします。
3. 新 key を `CONNECTOR_OAUTH_STATE_SIGNING_SECRET` へ昇格し、旧 key を `CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON` に残します。旧 runtime が cache TTL 中に発行した state も完了できるよう、昇格後は旧 key を state TTL（現在は10分）に cache TTL と伝播猶予を加えた期間以上保持してから削除します。

Connector origin signing key も current key だけを直接置換せず、未消費の
outbound origin marker と warm runtime をまたいで検証できるよう二段階で
rotation します。`CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON` は
32-byte 以上の secret を最大3件持つ JSON array 文字列です。

1. 旧 key を `CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET` に維持したまま、新 key を `CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON` へ verification-only key として追加します。Cache TTL（現在は約1分）と secret 伝播の猶予を待ち、すべての warm runtime が旧・新の両 key を検証できる状態にします。
2. 新 key を `CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET` へ昇格し、旧 key を `CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON` に残します。旧 key で署名済みの outbound operation が provider から返却される grace period、cache TTL、provider の webhook retry window がすべて経過し、Connector sync/poll queue と DLQ に旧 operation が残っていないことを確認してから旧 key を削除します。

各段階は別の secret version として反映し、次の段階へ進む前に current /
previous の両方で origin marker の検証が成功することを確認してください。
未消費 marker が残っている間は旧 key を削除しません。

更新後は設定確認用の再認証を行い、`ConnectorSyncDlqUrl`、`ConnectorPollDlqUrl`、queue age alarm、provider 側 callback error を監視します。CloudFormation parameter は `{}` のまま維持し、通常 deploy で手動更新した current secret version を戻さないでください。

## Connector poll DLQ recovery

`ConnectorPollDlq` は自動 redrive consumer を持たない、operator inspection 用の
共有 failure sink です。EventBridge が poll Lambda を invoke できなかった場合と、
invoke 後の Lambda が非同期 retry を使い切った場合の両方を保持するため、
message をそのまま Function や EventBridge へ再投入しないでください。

- EventBridge delivery failure は元の scheduled event が body に入り、
  `ERROR_CODE`、`ERROR_MESSAGE`、`RULE_ARN`、`TARGET_ARN` などが SQS message
  attribute に入ります。
- Lambda async failure は body の `requestContext`、`requestPayload`、
  `responseContext`、`responsePayload` で識別します。

Alarm 発生時は account、region、stack、message attribute と body を保全し、
EventBridge の invoke 権限、Lambda runtime error、Developer Platform table、
Connector sync queue の状態を先に修正します。その後
`ConnectorPollFunction` を空の event `{}` で同期 invokeし、成功と
`ConnectorSyncQueue` への bounded job enqueue を確認します。Poll は global
inventory と checkpoint により冪等に再開できるため、次の定期実行が成功したことも
確認してから元 message を receipt handle で削除します。形式が上記どちらにも一致
しない message や原因を確認できない message は削除せず、運用責任者へ
エスカレーションします。

## Connector disconnect recovery

Connector disconnect は `AuditEventsTable` の pending outbox から共有
`CollaborationProjectionFunction` が ID-only の `disconnect-links` job を
`ConnectorSyncQueue` へ送り、worker が bounded page ごとに external link を
`paused` へ変更します。共有 projection、connector queue のどちらでも retry
上限に達した場合に備え、`CollaborationProjectionDlq` と
`ConnectorSyncDlq` の visible message alarm を監視してください。

`CollaborationProjectionDlq` は collaboration、Webhook、connector の共有 DLQ
です。message を `ConnectorSyncQueue` へ直接送らず、次の順序で元の Audit
stream batch を共有 projection へ再投入します。

1. 対象 account、region、stack と alarm 発生時刻を確認し、原因となった
   downstream dependency、権限、設定を先に修正します。
2. `CollaborationProjectionDlqUrl` から message を1件だけ長い visibility
   timeout で受信し、削除せず保全します。DynamoDB Streams event source
   mapping が SQS destination へ保存する Body は
   `DDBStreamBatchInfo` を含む failure metadata だけで、元の
   `Records` は含みません。
3. DynamoDB Streams の record 保持期間である24時間以内に、
   `DDBStreamBatchInfo` の stream ARN、shard ID、開始・終了 sequence number
   を使って元の batch を取得します。`DescribeStream` で対象 shard と
   `NEW_IMAGE` view を確認し、`AT_SEQUENCE_NUMBER` の shard iterator から
   `GetRecords` を繰り返します。終了 sequence number と
   `batchSize` の両方が一致しない場合は再投入もDLQ messageの削除も行いません。
   24時間を過ぎて record を取得できない場合もmessageを削除せず、AuditEvents
   base tableから対象eventを特定する別の承認済み復旧作業へエスカレーション
   します。
4. 復元した `Records` 内の
   `connector.status.updated` event が
   `metadata.adapter=developer-platform`、
   `metadata.status=disconnected`、`outboxStatus=pending` であることを確認します。
   別用途の record が同じ batch に含まれる場合も record を切り出さず、
   共有 projection 全体へ同じ batch を渡します。
5. Stack resource から `CollaborationProjectionFunction` の physical name を
   取得し、復元した batch を同期 invoke します。応答の
   `batchItemFailures` が空であることを確認します。重複 invoke は downstream
   の event ID と disconnect lifecycle revision で冪等化されます。
6. `ConnectorSyncQueue` へ `disconnect-links` が到達し、対象 installation の
   external link がすべて `paused`、installation row の
   `connectorDisconnectCleanupRevision` が削除済みになったことを確認してから、
   元の共有 DLQ message を receipt handle で削除します。失敗または確認不能時は
   message を削除せず、visibility timeout 後に再調査します。

```sh
set -euo pipefail

export STACK_NAME=Mukuroji
export COLLABORATION_PROJECTION_DLQ_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='CollaborationProjectionDlqUrl'].OutputValue | [0]" \
  --output text)"
export COLLABORATION_PROJECTION_FUNCTION_NAME="$(aws cloudformation list-stack-resources \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'CollaborationProjectionFunction')].PhysicalResourceId | [0]" \
  --output text)"

aws sqs receive-message \
  --region "$AWS_REGION" \
  --queue-url "$COLLABORATION_PROJECTION_DLQ_URL" \
  --max-number-of-messages 1 \
  --wait-time-seconds 10 \
  --visibility-timeout 900 \
  > collaboration-projection-dlq-message.json

jq -e '
  .Messages as $messages |
  ($messages | length) == 1 and
  (($messages[0].ReceiptHandle | type) == "string") and
  (
    ($messages[0].Body | fromjson) as $failure |
    ($failure.DDBStreamBatchInfo | type) == "object" and
    ($failure.DDBStreamBatchInfo.streamArn | type) == "string" and
    ($failure.DDBStreamBatchInfo.shardId | type) == "string" and
    ($failure.DDBStreamBatchInfo.startSequenceNumber | type) == "string" and
    ($failure.DDBStreamBatchInfo.endSequenceNumber | type) == "string" and
    ($failure.DDBStreamBatchInfo.batchSize | type) == "number"
  )
' collaboration-projection-dlq-message.json

export AUDIT_STREAM_ARN="$(jq -r \
  '.Messages[0].Body | fromjson | .DDBStreamBatchInfo.streamArn' \
  collaboration-projection-dlq-message.json)"
export AUDIT_SHARD_ID="$(jq -r \
  '.Messages[0].Body | fromjson | .DDBStreamBatchInfo.shardId' \
  collaboration-projection-dlq-message.json)"
export AUDIT_START_SEQUENCE_NUMBER="$(jq -r \
  '.Messages[0].Body | fromjson | .DDBStreamBatchInfo.startSequenceNumber' \
  collaboration-projection-dlq-message.json)"
export AUDIT_END_SEQUENCE_NUMBER="$(jq -r \
  '.Messages[0].Body | fromjson | .DDBStreamBatchInfo.endSequenceNumber' \
  collaboration-projection-dlq-message.json)"
export AUDIT_EXPECTED_BATCH_SIZE="$(jq -r \
  '.Messages[0].Body | fromjson | .DDBStreamBatchInfo.batchSize' \
  collaboration-projection-dlq-message.json)"

aws dynamodbstreams describe-stream \
  --region "$AWS_REGION" \
  --stream-arn "$AUDIT_STREAM_ARN" \
  > collaboration-projection-stream.json
jq -e --arg shardId "$AUDIT_SHARD_ID" '
  .StreamDescription.StreamStatus == "ENABLED" and
  .StreamDescription.StreamViewType == "NEW_IMAGE" and
  any(.StreamDescription.Shards[]?; .ShardId == $shardId)
' collaboration-projection-stream.json

export AUDIT_SHARD_ITERATOR="$(aws dynamodbstreams get-shard-iterator \
  --region "$AWS_REGION" \
  --stream-arn "$AUDIT_STREAM_ARN" \
  --shard-id "$AUDIT_SHARD_ID" \
  --shard-iterator-type AT_SEQUENCE_NUMBER \
  --sequence-number "$AUDIT_START_SEQUENCE_NUMBER" \
  --query ShardIterator \
  --output text)"
test "$AUDIT_SHARD_ITERATOR" != "None"

jq -n '{Records: []}' > collaboration-projection-replay.json
export AUDIT_STREAM_READ_ATTEMPTS=0
while [ "$AUDIT_STREAM_READ_ATTEMPTS" -lt 120 ]; do
  aws dynamodbstreams get-records \
    --region "$AWS_REGION" \
    --shard-iterator "$AUDIT_SHARD_ITERATOR" \
    --limit 1000 \
    > collaboration-projection-stream-page.json

  jq \
    --arg start "$AUDIT_START_SEQUENCE_NUMBER" \
    --arg end "$AUDIT_END_SEQUENCE_NUMBER" '
    def decimal_compare($left; $right):
      if ($left | length) < ($right | length) then -1
      elif ($left | length) > ($right | length) then 1
      elif $left < $right then -1
      elif $left > $right then 1
      else 0
      end;
    {
      Records: [
        .Records[]? |
        .dynamodb.SequenceNumber as $sequence |
        select(($sequence | type) == "string") |
        select(
          decimal_compare($sequence; $start) >= 0 and
          decimal_compare($sequence; $end) <= 0
        )
      ]
    }
  ' collaboration-projection-stream-page.json \
    > collaboration-projection-selected-page.json
  jq -s \
    '{Records: (.[0].Records + .[1].Records)}' \
    collaboration-projection-replay.json \
    collaboration-projection-selected-page.json \
    > collaboration-projection-replay-next.json
  mv collaboration-projection-replay-next.json \
    collaboration-projection-replay.json

  if jq -e --arg end "$AUDIT_END_SEQUENCE_NUMBER" '
    any(.Records[]?; .dynamodb.SequenceNumber == $end)
  ' collaboration-projection-stream-page.json; then
    break
  fi
  export AUDIT_SHARD_ITERATOR="$(jq -r \
    '.NextShardIterator // empty' \
    collaboration-projection-stream-page.json)"
  test -n "$AUDIT_SHARD_ITERATOR"
  export AUDIT_STREAM_READ_ATTEMPTS=$((AUDIT_STREAM_READ_ATTEMPTS + 1))
  sleep 1
done

jq -e \
  --arg end "$AUDIT_END_SEQUENCE_NUMBER" \
  --argjson expected "$AUDIT_EXPECTED_BATCH_SIZE" '
  (.Records | length) == $expected and
  any(.Records[]?; .dynamodb.SequenceNumber == $end)
' collaboration-projection-replay.json
jq -e '
  any(
    .Records[];
    .eventName == "INSERT" and
    .dynamodb.NewImage.eventType.S == "connector.status.updated" and
    .dynamodb.NewImage.metadata.M.adapter.S == "developer-platform" and
    .dynamodb.NewImage.metadata.M.status.S == "disconnected" and
    .dynamodb.NewImage.outboxStatus.S == "pending"
  )
' collaboration-projection-replay.json

aws lambda invoke \
  --region "$AWS_REGION" \
  --function-name "$COLLABORATION_PROJECTION_FUNCTION_NAME" \
  --cli-binary-format raw-in-base64-out \
  --payload fileb://collaboration-projection-replay.json \
  collaboration-projection-replay-response.json
jq -e '.batchItemFailures == []' collaboration-projection-replay-response.json

export COLLABORATION_PROJECTION_DLQ_RECEIPT_HANDLE="$(jq -r \
  '.Messages[0].ReceiptHandle' \
  collaboration-projection-dlq-message.json)"
# external link と cleanup marker の確認が完了した後だけ実行します。
aws sqs delete-message \
  --region "$AWS_REGION" \
  --queue-url "$COLLABORATION_PROJECTION_DLQ_URL" \
  --receipt-handle "$COLLABORATION_PROJECTION_DLQ_RECEIPT_HANDLE"
```

`ConnectorSyncDlq` に `disconnect-links` がある場合は、共有 projection を
再実行しません。原因修正後、DLQ message の body が version 1 の
`disconnect-links` で、必須の version、kind、対象 Workspace、installation、
lifecycle revision と、任意の `updatedByUserId` / continuation `cursor` 以外を
含まないことを確認します。secret や credential が含まれていないことも
確認し、その同じ body を `ConnectorSyncQueueUrl` へ送ります。
送信成功を確認してから元 message を削除します。古い lifecycle revision の
job は現在の installation を変更せず終了し、同じ page の重複は既に
`paused` の link を変更しません。DLQ 全体の一括 redrive は他の outbound /
poll job も再実行するため、対象と影響を棚卸しせず実施しないでください。

運用ファイルには Workspace ID や audit metadata が含まれます。権限を限定した
作業領域で扱い、復旧と記録が完了したら安全に削除してください。

## File storage security and retention

File body は API request body に通さず、認証・認可済み API が発行する短命 URL で `workspaces/<workspaceId>/...` の object key へ直接 upload / download します。client が任意の bucket key を指定する方式ではありません。

- S3 bucket は Block Public Access、Bucket owner enforced、SSE-S3、TLS 強制、versioning、`Retain` を有効にします。
- `system/data-integrity/file-bucket-incarnation/v1.json` は bucket policy と TLS 強制の適用後、custom provider が事前 GET を行わず `If-None-Match: *` の条件付き PUT を最初に1回だけ試みます。Policy は同 key の delete / version delete を全 principal に拒否し、provider role 以外の PUT と `If-None-Match: *` を欠く PUT を拒否します。条件不成立または Create response を失った再試行だけ current marker の checksum / size を照合して同じ VersionId を返し、新しい version を作りません。Provider に bucket-wide `ListBucket` は付与しません。Object Lock は有効化しません。
- browser CORS は `ApiAllowedOrigins` と揃え、direct `PUT` / `GET` / `HEAD` と checksum / metadata header だけを許可します。
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

`RequestEmailIngestionFunction` は任意モジュール `mukuroji:requestEmail` を有効にしたときだけ作ります。この Lambda は public HTTP URL、API Gateway route、SES receipt rule をこの stack では持ちません。Email provider / SES adapter は署名付きの正規化 envelope を作り、明示的に `lambda:InvokeFunction` を許可された principal からこの Lambda を非同期 invoke してください。Lambda は `RequestEmailWebhookSecret` で envelope を検証し、`RequestTokenHashSecret` で reply capability を解決します。Execution role は `RequestIntakeTable` への direct `GetItem` と、`dynamodb:EnclosingOperation=TransactWriteItems` 条件付き `PutItem`、failure destination の `GetQueueAttributes` / `GetQueueUrl` / `SendMessage` だけを持ちます。非同期 retry を2回使い、最終失敗は14日保持・stack rollback 時 Retain の encrypted DLQへ送られます。Visible message と `DestinationDeliveryFailures` は別々の alarm で検出し、stack共通のprimary/secondary SNS actionへ通知します。

`RequestEmailWebhookSecret` は adapter と Lambda の両方で同じ値を設定し、log、output、request metadata に残さないでください。`RequestTokenHashSecret` の rotation は未失効の public form / reply link を無効化するため、通常 deploy と分け、active capability の再発行を含む手順として実施します。`NoEcho` は CloudFormation 表示を抑止しますが、secret の command history や Lambda environment への露出を防ぐものではないため、値は CI/CD の secret store から渡してください。

DLQ の envelope は署名 timestamp が5分で失効するため、そのまま redrive しません。Operator は失敗原因を解消した後、保存済み envelope の内容と `Message-ID` を変更せず、新しい timestamp で adapter 側から再署名して `RequestEmailIngestionFunction` を invokeし、成功を確認してから元 message を削除します。同じ `Message-ID` は request table の receipt で冪等化されます。

## Lambda log retention and table deletion protection

`configureStatefulResourceGuards`（`lib/aspects/stateful-resource-guards.ts`）が stack 全体に次を適用します。

- `cdk.json` の `@aws-cdk/aws-lambda:useCdkManagedLogGroup` で CDK が作る `/aws/lambda/<function name>` は、既定の2年保持を90日に変え、`Retain` にします。
- Subsystem が `logGroup` を明示した Lambda（restore drill の365日など）はそのまま使います。どちらもない Lambda は synth error にします。L2 でない CDK 内部の bucket notification handler は `file-storage.ts` が log group を割り当てます。
- `Retain` の DynamoDB table すべてに `DeletionProtectionEnabled: true` を付け、console や CLI からの `DeleteTable` も拒否します。

`stateful-resource-guards.suite.ts` は、`cdk.json` の feature flag あり・なしの両方の template で、保持期間が1年以内の retained log group を持たない Lambda、1年を超えて保持する log group、削除保護のない retained table があると失敗します。

この変更より前に deploy した環境では、Lambda が自動で作った無期限の `/aws/lambda/<function name>` が残ります。新しい log group へ切り替わった後、次で古い log group に保持期間を付けてください（削除する場合は調査に必要な期間が過ぎてから行います）。

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/<StackName>- \
  --query 'logGroups[?retentionInDays==`null`].logGroupName' --output text \
  | xargs -n1 -I{} aws logs put-retention-policy --log-group-name {} --retention-in-days 90
```

Table を意図して削除する場合は、先に `aws dynamodb update-table --table-name <name> --no-deletion-protection-enabled` で保護を外します。

## IAM policy の大きさ

IAM は1つの role に付く inline policy を合計10,240文字（空白を除く）まで、customer-managed policy を1本6,144文字まで、role あたり10本までに制限します。Floci はこの上限を検査しないため、`cdk/test/iam-policy-quotas.suite.ts` が全 role について、ARN を長めの値に置き換えた見積もりで inline の合計と各 managed policy が上限の80%以下、managed policy が10本以下であることを確かめます。

- API role の DynamoDB と SQS の権限は customer-managed policy（`ApiTableDataPolicy`、`ApiAnalyticsTablePolicy`、`ApiFeatureDataPolicy`、`ApiTransactionConditionPolicy`）に置きます。API Lambda はこれらの policy ができてから作られます。
- Role の inline が上限に近づいたら、`grants.*` に `ManagedPolicyPrincipal`（`cdk/lib/policies/managed-policy-principal.ts`）を渡して、権限を customer-managed policy へ移します。

## GitHub Actions から deploy する

本番環境は 1 つで、`main` の commit を GitHub Actions の `production` Environment から deploy します。
job は OIDC で `mukuroji-github-deploy` role を引き受けるので、AWS の access key は GitHub に置きません。
role を引き受けられるのは `mnmn0/mukuroji` の `production` Environment で動く job だけで、Environment は
`main` に限り、required reviewer の承認を待ちます。判断の理由は [ADR 0039](../docs/adr/0039-github-actions-oidc-deploy.md) を参照してください。

| 置き場所 | 中身 |
| --- | --- |
| [`deploy-access/github-deploy-access.template.json`](deploy-access/github-deploy-access.template.json) | 一度だけ作る CloudFormation stack。GitHub の OIDC provider、deploy role、alarm 用 SNS topic 2 つ、deploy の非 secret 値（SSM `/mukuroji/deploy/config/`）。 |
| [`deploy-access/deploy.workflow.yml`](deploy-access/deploy.workflow.yml) | `.github/workflows/deploy.yml` に置く workflow。`scripts/github-deploy.ts` を呼ぶだけです。 |
| [`../scripts/github-deploy.ts`](../scripts/github-deploy.ts) | deploy の手順。SSM から値を読み、`cdk deploy`、`scripts/deploy-web.sh`、`/api/health` の commit 確認を行います。 |

deploy role 自身が持つ権限は、CDK bootstrap の deploy / file-publishing / lookup role を引き受けること、
`Mukuroji` stack の参照、Web bucket への upload と CloudFront の invalidation、runtime control の AppConfig 操作、
`/mukuroji/deploy/` の SSM parameter の読み取りと新規作成（上書きは Deny）、runtime control の切り替えを監査ログに残す
audit table への `dynamodb:PutItem` と tenant administration table の保持設定の `dynamodb:GetItem`
（どちらも `WorkspaceDirectoryId` の partition だけ）だけです。
2026-11-21 より前の template で deploy access stack を作った場合は、手順 1 の `curl` と `aws cloudformation deploy` を
もう一度実行して、この権限を足してください。stack の変更は CDK の標準どおり
bootstrap の CloudFormation execution role が行います。

stack の secret parameter（`WorkspaceAuditPseudonymKey`、`EnterpriseIdentityTokenHashSecret`、`RequestTokenHashSecret`、
`EdgeOriginSecret`）は SSM の SecureString（`/mukuroji/deploy/secrets/`）に置きます。stack がまだないときだけ script が
32 byte の乱数で作り、上書きせずに保存します。stack ができた後に値がなければ、新しい値で audit ID や token hash が
変わらないよう deploy を止めます。値を消したときは同じ値を戻してください。SSO・AI の parameter は
script が渡さないので、CDK の既定どおり前回の値が残ります。有効にするときは script に足す PR を出します。

[任意 module](#optional-modules) の CDK context も script は渡さないため、この経路で deploy する stack では
`cdk/cdk.json` の `context` に書いた module だけが有効になります。現在はどれも書いていないので、本番の stack は
任意 module なしです。有効にするときは `cdk/cdk.json` に `"mukuroji:connectors": true` などを足す PR を出し、
その module の parameter も script に足します。書いた後に消すと、次の deploy で module の resource が削除されます。

`ApiRuntimeConfigurationRevision` は run ごとに `gh-<run id>-<attempt>` になり、再実行でも同じ値を使いません。
`ApplicationCommitSha` は checkout した `GITHUB_SHA` で、deploy 後に `WebUrl` の `/api/health` が同じ値を返すまで待ちます。
初回の deploy では `ApiAllowedOrigins` を渡さず、2 回目からは stack の `WebUrl` を渡します。独自 domain など別の
origin にするときは deploy access stack の `ApiAllowedOrigins` を更新します。

費用: public repository の GitHub Actions は無料です。SNS の email 通知と SSM の standard parameter も無料枠に収まります。

### 最初に一度だけ行うこと

1. AWS console で region を東京（ap-northeast-1）にして CloudShell を開き、次を実行します。`OWNER_EMAIL` は
   初期 owner の小文字の email です。account に GitHub の OIDC provider が既にある場合は、最後の
   `--parameter-overrides` に `ExistingGitHubOidcProviderArn=<その ARN>` を足します。

   ```sh
   export AWS_REGION=ap-northeast-1
   export OWNER_EMAIL=owner@example.com
   curl -fsSLo github-deploy-access.json \
     https://raw.githubusercontent.com/mnmn0/mukuroji/main/cdk/deploy-access/github-deploy-access.template.json
   npx --yes aws-cdk@2.1132.0 bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION"
   aws cloudformation deploy --region "$AWS_REGION" --stack-name MukurojiGitHubDeployAccess \
     --template-file github-deploy-access.json --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides InitialOwnerEmail="$OWNER_EMAIL"
   aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name MukurojiGitHubDeployAccess \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```

   alarm の送り先を owner 以外にするときは `AlarmPrimaryEmail=` と `AlarmSecondaryEmail=` も渡します（できれば別の人か mailbox）。
2. SNS から届く 2 通の「Subscription Confirmation」メールで、それぞれ `Confirm subscription` を押します。
3. GitHub の repository の Settings → Environments で `production` を作り、次を設定します。
   - Required reviewers: 承認する人（例: `mnmn0`）
   - Deployment branches and tags: Selected branches and tags で `main` だけ
   - Environment variables: `AWS_DEPLOY_ROLE_ARN` に手順 1 の最後に表示された ARN。region を変えたときだけ `AWS_REGION` も
4. `deploy-access/deploy.workflow.yml` の内容を `.github/workflows/deploy.yml` として追加し、`main` に merge します。
   Claude の GitHub App は workflow file を push できないため、この 1 回は GitHub の画面から追加します。
5. merge で動いた `Deploy` workflow の `Review deployments` で承認します。初回は 30〜40 分ほどかかります。
6. Actions → `Deploy` → `Run workflow` で `runtime-control-enable` を選んで実行し、承認します（約 30 分）。
   ここまで API は `/api/health` と `/api/ready` 以外（サインインの `/api/auth/*` を含む）に `503` を返すので、
   owner のサインインはこの後に行います。
7. 初期 owner に Cognito から仮パスワードのメールが届いています。`WebUrl`（job の summary に出ます）でサインインし、
   パスワードを変えます。続けて Settings で認証アプリ（TOTP）の MFA を設定します。仮パスワードの期限は 7 日です。
   期限が切れたら CloudShell で `aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <owner の email>
   --message-action RESEND` を実行して送り直します。
8. 初期 owner は stack が `mukuroji-system-admins` group に入れているので、サイドバーの「チームを追加」から最初の Team を
   作れます。Team と Project は stack が作らないため、ここから画面で作ります。

#### 初回 deploy の後に確かめること

- 祝日: `ScheduledJobs` Lambda が runtime control を有効にした後、6 時間ごとに内閣府の CSV を取りに行き、月に 1 回保存します
  （[ADR 0032](../docs/adr/0032-japanese-public-holiday-monthly-sync.md)）。手で取り込む手順はありません。
  取得に失敗しても同梱の祝日を使うので Work Item の作成は止まりません。CloudWatch Logs の名前に `ScheduledJobsLogGroup` を含む log group で
  `japanese-public-holiday-sync` が失敗し続けていないかだけ確認します。
- Data migration: `bun run data:migrate:aws list --function-name <DataMigrationFunctionName>` で登録済みの移行を確認します。
  新しく作った stack には移す既存 row がないので、初回 deploy の後に実行する移行はありません。既存データの backfill
  （例: Focus の担当者索引）は、その移行を含む commit を既存環境へ deploy したときだけ [Data migration](#data-migration) の手順で実行します。
- CORS: 初回の job summary では `ApiAllowedOrigins` が `stack default`（localhost）と表示されます。Web は CloudFront の
  同じ origin から `/api` を呼ぶので影響はなく、次の deploy から `WebUrl` が自動で入ります。

### いつもの deploy と手動の操作

`main` に merge するたびに `Deploy` が承認待ちになります。production の操作は一度に 1 つだけで、承認待ちか実行中の run が
あるあいだに来た run は順番待ちになります。順番待ちは最新の 1 つだけが残り、古い順番待ちは取り消されます。
最新だけを deploy したいときは、古い承認待ちを `Reject` すると次の run が承認待ちになります。動いている deploy は止めません。`Run workflow` の `operation` で次も実行できます。

| operation | すること |
| --- | --- |
| `deploy` | 選んだ branch（`main` のみ）の先頭を deploy します。 |
| `runtime-control-enable` / `runtime-control-disable` | [runtime control](#application-処理を有効にするruntime-control) を切り替えます（canary で約 30 分）。 |
| `runtime-control-disable-all-at-once` | incident commander が即時停止を決めたときだけ使います。`AppConfig.AllAtOnce` で止めます（bake の 10 分は待ちます）。 |
| `web-rollback` | `web_release_commit` に指定した 40 文字の SHA の Web release に戻します（[Web の release を戻す](#web-の-release-を戻す)）。 |

`deploy` は対象の commit が今の `main` の先頭でないと AWS に触れる前に止まります。古い run を再実行して本番を
前の commit に戻すことはできません。stack を前の commit に戻すときは、`main` で該当の PR を revert して通常どおり
deploy します（[Rollback](#rollback) の forward deploy）。

アプリ全体の version は deploy した commit SHA です（[ADR 0057](../docs/adr/0057-app-version-is-deployed-commit.md)）。
`deploy` の job summary には、deploy 前に `/api/health` が返していた前の commit と、GitHub の比較 link
（前の commit から今回の commit まで）が出ます。この link の commit 一覧が、その deploy で入った変更の履歴です。
前の commit が読めない初回などは「不明」と出ます。

初回の stack 作成が失敗して `ROLLBACK_COMPLETE` になった場合は、job の log と CloudFormation の stack event で原因を
直してから再実行します。`cdk deploy` が失敗した stack を消して作り直し、SSM の secret はそのまま使います。
`Retain` の table・bucket・user pool は失敗した stack から外れて残るので、作り直しが成功した後に不要なものを手で削除します。
job の summary には commit、revision、CDK outputs の SHA-256、`WebUrl` が残り、Environment の deployment 履歴と合わせて
change record にします。deploy の後は [本番 deploy 後の確認](../docs/post-deploy-verification.md) の
`bun run deploy:smoke` で CloudFront・runtime control・Cognito・alarm・DLQ などを読み取りだけで確かめ、結果も change record に残します。
PR ごとの read-only な `cdk diff` はまだありません（#362 の残り）。

## Fresh deployment

### 1. Cognito と値を準備する

`CognitoUserPoolId` と `CognitoUserPoolClientId` を両方とも空にすると、stack が Cognito を用意します。
作るのは次の4つです。

- self sign-up なしの user pool。`directory_id` / `workspace_id` custom attribute、12文字以上の password policy、任意の TOTP MFA を持ち、Essentials tier で、削除保護と `Retain` 付きです。
- client secret なし、`ALLOW_USER_PASSWORD_AUTH` だけを許可する password client。user が自分の token で書き換えられる attribute は `name` だけです。API は email と Workspace attribute で認可するため、これらは管理者 API からしか変えられません。
- `SystemAdminGroups` の先頭の group。
- 初期 owner。Workspace attribute と verified email 付きで招待します。この user pool は username でサインインし、API はログインの email を username として送るため、`InitialOwnerUsername` は `InitialOwnerEmail` と同じ値にします。違う値は deploy 前に拒否されます。

Cognito の既定 email が初期 owner に仮パスワードを送り、owner は最初のサインインで新しい password に
変えます。この場合、下の `prepare-workspace-cognito.sh` と group 作成手順は不要です。
`COGNITO_USER_POOL_ID` と `COGNITO_USER_POOL_CLIENT_ID` は空のまま deploy し、deploy 後の検証では `UserPoolId` /
`UserPoolClientId` output の値を使います。Cognito の既定 email は1日 50 通までなので、
全社のメンバーを招待する前に [招待と再設定のメールを SES から送る](#招待と再設定のメールを-ses-から送る)
を済ませてください。SSO を使う場合は、stack が作った
user pool に IdP と SSO 専用 client を追加し、その client ID を SSO parameter に渡します。

既存の user pool を使う場合は、以下の条件をそろえてから両 parameter を渡します。password client の
`WriteAttributes` は明示設定し、`email`、`email_verified`、`custom:directory_id`、`custom:workspace_id`
を含めないでください（例: `name` だけ）。未設定の場合の Cognito default は `email` を書けます。
含めると、user が自分の access token でこれらを書き換え、別の user として認可される可能性があります。
user pool は `AdminCreateUserConfig.AllowAdminCreateUserOnly=true`（self sign-up なし）にします。
この2点は準備 script、bootstrap validator、deploy 時の `ValidateCognitoClientContract` custom
resource が検証し、満たさなければ失敗します。stack が作る user pool は最初から満たしています。
多層防御として、API は `email_verified=false` かつ email が username と異なる user（自分で email を
変えた user）を拒否します。email でサインインする pool（username が Cognito の生成値 = `sub`）は
Cognito が email の重複を拒否するため、この判定の対象外です。

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
export MUKUROJI_REQUEST_TOKEN_HASH_SECRET=<different-at-least-32-random-characters>
export MUKUROJI_EDGE_ORIGIN_SECRET="$(openssl rand -hex 32)"
export MUKUROJI_ALARM_PRIMARY_TOPIC_NAME=<primary-standard-sns-topic-name>
export MUKUROJI_ALARM_SECONDARY_TOPIC_NAME=<secondary-standard-sns-topic-name>

bash scripts/prepare-workspace-cognito.sh
```

`MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` は環境作成時に一度だけ生成し、64桁の小文字hex値を secret store に保存して、以後の diff/deploy で再利用します。CloudFormation parameter とAPIのいずれも、この形式以外をfail-closedで拒否します。
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
2 人目以降の追加と交代は、Workspace owner がメンバー管理画面の **システム管理者にする** / **システム管理者を外す** で行えます（ADR 0067）。API は `SystemAdminGroups` の先頭の group へ追加し、解除では設定したすべての group から外します。

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

#### 招待と再設定のメールを SES から送る

stack が作る user pool は、招待メール（仮パスワード）と確認コードのメール（パスワード再設定と email の確認）を
日本語と英語の文面で送ります。文面には `WebUrl` の `/login` と `/forgot-password` への link が入ります
（独自 domain を設定していれば独自 domain）。送信は既定では Cognito の送信機能で、1日 50 通までに限られ、
送信元も `no-reply@verificationemail.com` になります。全社のメンバーを招待する前に、次の手順で SES から送るように
切り替えます。通知 Email（`NotificationEmailSender`）と同じアドレスと identity を使えます。

1. stack と同じ region の SES で、送信元アドレスかそのドメインを検証します。ドメインの場合は Easy DKIM の
   CNAME を DNS に追加し、SPF / DMARC も設定します。user pool は stack と同じ region の identity だけを使います。

   ```sh
   aws sesv2 create-email-identity --region "$AWS_REGION" --email-identity example.com
   aws sesv2 get-email-identity --region "$AWS_REGION" --email-identity example.com \
     --query '{verified: VerifiedForSendingStatus, dkim: DkimAttributes.Status}'
   ```

2. sandbox の解除と送信上限を確認します。sandbox のあいだは検証済みのアドレスにしか送れず、1日 200 通までです。

   ```sh
   aws sesv2 get-account --region "$AWS_REGION" \
     --query '{production: ProductionAccessEnabled, quota: SendQuota}'
   ```

   `production` が `false` なら、SES console の「本番アクセスをリクエスト」か
   `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url <WebUrl> --use-case-description '<用途>'`
   で解除を申請します。審査には通常 1 日ほどかかります。`quota.Max24HourSend` が一度に招待する人数と
   通知 Email の合計より少なければ、Service Quotas で SES の送信上限の引き上げも申請します。
3. `CognitoEmailSender` に送信元アドレスを指定して deploy します。ドメインを検証した場合は
   `CognitoEmailSesIdentity` にそのドメインを指定します。Cognito は初回に service-linked role
   `AWSServiceRoleForAmazonCognitoIdpEmailService` を作り、それで SES を呼びます。deploy する role に
   `iam:CreateServiceLinkedRole` が要ります。
4. 自分宛てに member を招待して招待メールが指定の送信元から届くこと、login 画面の「パスワードを忘れた場合」で
   確認コードが届くことを確かめます。届かない場合は SES の送信統計と suppression list を確認します。

Cognito の既定の送信機能に戻すときは、`CognitoEmailSender` と `CognitoEmailSesIdentity` の両方を空にして deploy します
（例: `--parameters CognitoEmailSender= --parameters CognitoEmailSesIdentity=`）。`CognitoEmailSesIdentity` だけが残っていると
rule が deploy 前に止めます。文面はどちらでも同じです。
既存の user pool を渡す場合、stack は user pool のメール設定を変えないため、`CognitoEmailSender` を指定すると
deploy 前に rule が止めます。既存の user pool では Cognito console の「メッセージング」で SES を設定してください。

### 2. Build、test、diff、deploy

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

```sh
export MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION=2026-07-28-01
export MUKUROJI_APPLICATION_COMMIT_SHA="$(git rev-parse HEAD)"
export AWS_REGION=ap-northeast-1
export MUKUROJI_AI_BEDROCK_MODEL_ARN='arn:aws:bedrock:ap-northeast-1:<account-id>:inference-profile/jp.anthropic.claude-sonnet-4-6'
export MUKUROJI_AI_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD='<reviewed-input-price>'
export MUKUROJI_AI_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD='<reviewed-output-price>'
export MUKUROJI_AI_BEDROCK_DESTINATION_MODEL_ARNS='arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6,arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-6'
export MUKUROJI_API_ALLOWED_ORIGINS=https://app.example.com

bun --filter cdk cdk diff Mukuroji \
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
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters EdgeOriginSecret="$MUKUROJI_EDGE_ORIGIN_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters ApplicationCommitSha="$MUKUROJI_APPLICATION_COMMIT_SHA" \
  --parameters AiBedrockModelId="jp.anthropic.claude-sonnet-4-6" \
  --parameters AiBedrockModelArn="$MUKUROJI_AI_BEDROCK_MODEL_ARN" \
  --parameters AiBedrockInputPricePerMillionTokensUsd="$MUKUROJI_AI_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD" \
  --parameters AiBedrockOutputPricePerMillionTokensUsd="$MUKUROJI_AI_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD" \
  --parameters AiBedrockDestinationModelArns="$MUKUROJI_AI_BEDROCK_DESTINATION_MODEL_ARNS" \
  --parameters ApiAllowedOrigins="$MUKUROJI_API_ALLOWED_ORIGINS"

bun --filter cdk cdk deploy Mukuroji \
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
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters EdgeOriginSecret="$MUKUROJI_EDGE_ORIGIN_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters ApplicationCommitSha="$MUKUROJI_APPLICATION_COMMIT_SHA" \
  --parameters AiBedrockModelId="jp.anthropic.claude-sonnet-4-6" \
  --parameters AiBedrockModelArn="$MUKUROJI_AI_BEDROCK_MODEL_ARN" \
  --parameters AiBedrockInputPricePerMillionTokensUsd="$MUKUROJI_AI_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD" \
  --parameters AiBedrockOutputPricePerMillionTokensUsd="$MUKUROJI_AI_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD" \
  --parameters AiBedrockDestinationModelArns="$MUKUROJI_AI_BEDROCK_DESTINATION_MODEL_ARNS" \
  --parameters ApiAllowedOrigins="$MUKUROJI_API_ALLOWED_ORIGINS" \
  --outputs-file /tmp/mukuroji-cdk-outputs.json
```

`--outputs-file`はdeploy直後のoutput照合用スナップショットです。`/tmp`のファイルだけを
永続的な変更証跡とはせず、stack ID、deploy時刻、change set、API runtime revision、
application commit SHA、
outputファイルのSHA-256をアクセス制御されたchange recordへ保存します。
outputにはSecret ARNなどのresource metadataが含まれるため、access tokenやsecret値を追記せず、
照合後のローカルファイルは削除します。

`MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION`はAPIのcode、またはruntime configuration secretへ
入るparameter/resource値が変わるdeployごとに新しい値へ進め、`cdk diff`とdeployへ同じ値を渡します。
同じrevisionのsecret内容を更新するとimmutable rolloutの前提が崩れるため、revisionを再利用しません。
`MUKUROJI_APPLICATION_COMMIT_SHA`はreview済みcheckoutの`git rev-parse HEAD`と一致させ、deploy後に
`GET /api/health`が同じ`applicationCommitSha`を返すことをproduction-like evaluationで確認します。
Trafficの切替は`live` Aliasの更新で行われます。

Bootstrap は次を同一 `WorkspaceDirectoryId` partition に冪等投入します。

- `WORKSPACE#METADATA` / `workspace-metadata`
- `WORKSPACE_MEMBER#<lowercase email>` / `workspace-member` / `role=owner`
- `EMAIL_ALIAS#<lowercase email>` / `email-alias`

Workspace owner row 自体は既存 RBAC の global system-admin 判定には使いません。Team と Project は
投入しないので、owner が system-admin として最初の Team を画面から作ります。

#### Demo data

既定の deploy は demo data を投入しません。試用や開発用の環境で demo data が欲しい場合だけ、
CDK context で有効にします。

```sh
bun --filter cdk cdk deploy Mukuroji \
  -c mukuroji:demoData=true \
  ...
```

有効にすると、stack 作成時に次も投入します。

- demo member 5 人（`sato@example.com` など 4 人が `member`、`viewer@example.com` が `guest`、いずれも `active`）
- Team 2 件（`core-team`・`design-team`）と Project 4 件（`refero`・`product-roadmap`・`shared-launch`・`brand-refresh`）
- `refero` の Work Item 10 件
- demo Project 4 件の `PROJECT_MEMBER#<projectId>#<lowercase email>` / `role=manager`（owner を各 demo Project の manager にする）

owner の manager row は既存の role を上書きしません。`InitialOwnerEmail` には demo member の email
（`@example.com`）を使わないでください。同じ email だと owner は demo seed の role のままになり、
`MUKUROJI_DEMO_DATA=true` の validator が失敗します。

`SeedWorkspaceDemoMembers` は stack の作成時と更新時に書き込みます（既存の role と status は保持します）。
それ以外の demo data の custom resource は作成時だけ書き込みます。どれも削除時には何もしません。
demo data を有効にして作った stack で後から無効にしても、resource が消えるだけで投入済みの row は
残ります。

一度無効にした stack で demo data を再び有効にすることはできません。`SeedProjectDirectory` と
`SeedWorkItems` は既存 row があると書き込まない条件付きの transaction なので、残っている demo の
Team・Project・Work Item と衝突して custom resource の作成が失敗し、stack update は rollback されます。
衝突した transaction は何も書き込まないので、残っている Team・Project・Work Item は変わりません。
ただし、ほかの demo data の custom resource が失敗より先に書き込むことがあり、その書き込みは
rollback でも取り消されません。たとえば `SeedWorkspaceDemoMembers` は、削除済みの demo member を
作り直し、既存の demo member に欠けている属性を補います（既存の値は変えません）。
demo data が必要な環境では無効にせずに使い続けるか、demo data を有効にした新しい stack を作ります。

local の Floci 環境はこの設定と関係なく、`floci/` の初期化で従来どおり demo data を使います。

#### 既存環境から demo data を取り除く

demo data を投入した環境を、owner だけの空の Workspace に戻すには `demo-data:remove` を使います。
上の一覧の row（demo member・Team・Project・Work Item と、owner の demo Project manager row）だけを
key で特定して削除し、Workspace metadata・owner・email alias は残します。stack の demo data 設定は
先に無効（既定）にしておきます。有効のままだと、`SeedWorkspaceDemoMembers` が更新される deploy で
demo member が作り直されます。

```sh
export WORKSPACE_ACCESS_TABLE_NAME=...   # WorkspaceAccessTableName output
export PROJECT_DIRECTORY_TABLE_NAME=...  # ProjectDirectoryTableName output
export WORK_ITEMS_TABLE_NAME=...         # WorkItemsTableName output
export MUKUROJI_WORKSPACE_DIRECTORY_ID=... # WorkspaceDirectoryId parameter
export INITIAL_OWNER_EMAIL=...           # InitialOwnerEmail parameter
export AWS_REGION=...                    # stack の region（既定値なし）

bun run demo-data:remove          # 削除する row を表示するだけ
bun run demo-data:remove --apply  # 1 つの transaction ですべて削除する
```

実 data を壊さないよう、次のどれかがあると何も削除せずに終了し（exit code 1）、該当 row を表示します。

- demo Team・Project に、demo seed 以外の row がある（人が作った Work Item、追加した Project や Project member、
  demo Project に割り当てた他 Team の Work Item など）
- demo Work Item が編集されている（`revision` が 1 でない）
- demo member の role が `owner` になっている
- demo row の key に別の種類の row がある

その場合は、画面から demo Team・Project を archive するか、表示された row を先に整理してから再実行します。
削除は条件付きの 1 つの transaction なので、確認した demo row が確認後に変わると全体が失敗し、何も削除されません。
ただし確認後に demo Team・Project へ新しく追加された row は検出できないので、利用者の操作がない時間に実行します。
再実行しても、取り除き済みの row は「already gone」として数えるだけです。

この script が見るのは上の 3 table だけです。demo の Work Item に付いたコメント・添付・時間記録や、
検索 index に backfill 済みの demo の文書は削除しません。demo Team 以外の Work Item の担当者が demo member でも
検出しません。demo data を使い込んだ環境では archive を使います。
local の Floci では `AWS_ENDPOINT_URL=http://localhost:4566` と `AWS_REGION` を付けて同じように実行できます。

bootstrap update は同じ key・同じ owner なら再実行できます。既存の異なる種類の row と key が衝突した場合は上書きせず stack update を失敗させるため、row を調査してから再実行します。

#### Application 処理を有効にする（runtime control）

deploy した直後の runtime control は `disabled` なので、API は `/api/health` 以外に `503` を返し、
worker も処理を始めません。次の 1 コマンドで有効にします。

```sh
AWS_REGION=ap-northeast-1 bun run runtime-control:enable
```

`scripts/runtime-control.ts` は `aws` CLI で次を順に行い、どこかで失敗すると止まります。

1. stack output から AppConfig の ID 4 つと `WebUrl` を読む。
2. AppConfig environment で別の deployment が進行中でないこと、`RuntimeControlConfigurationFailureAlarm`
   が `OK` かつ actions 有効であることを確かめる（alarm の確認は有効化のときだけ）。
3. 最新の hosted version の `revision` に 1 を足した document を hosted version として作る。
   誰が（`sts get-caller-identity` の ARN）いつ切り替えたかを version と deployment の description に残す。
   その前に、Workspace の監査ログ（stack output `AuditEventsTableName`）へ `runtime-control.change-started` を書き、
   終わったら `runtime-control.change-completed` か `runtime-control.change-failed` を書く。実行する credential には
   この table への `dynamodb:PutItem` と、保持期間・legal hold を読む tenant administration table
   （`TenantAdministrationTableName`）への `dynamodb:GetItem` が要る（どちらも `WorkspaceDirectoryId` の partition だけに
   絞れる。GitHub Actions の deploy role は持っている）。開始を記録できないと `enable` と `read-only` は何も変えずに止まり、`disable` は警告を出して
   止める操作を続ける（[ADR 0044](../docs/adr/0044-runtime-control-switch-audit-events.md)）。
4. stack の canary strategy で deployment を始め、`COMPLETE` まで待つ（rollout 20 分 + bake 10 分で約 30 分）。
   `ROLLED_BACK` になったら失敗として止まる。
5. `WebUrl` の `/api/ready` が `200` を返し、`/api/maintenance` が `{"state":"none"}` を返すまで最大 3 分確認する。

止めるときは `bun run runtime-control:disable` を使います。`/api/ready` が `503`、`/api/maintenance` が
`stopped` になれば完了です。
incident commander が即時停止を決めたときだけ、`-- --all-at-once` を付けて `AppConfig.AllAtOnce` で
配布します（bake の 10 分は待ちます）。省いた理由は change record に残します。stack 名が `Mukuroji`
でない場合は `MUKUROJI_STACK_NAME` を指定します。local の Floci では `AWS_ENDPOINT_URL=http://localhost:4566`
を付けて同じように実行できます。change record に残す内容と、deployment 中に確認する
`runtime-control.evaluated` record は [operational readiness](../docs/operational-readiness.md#dynamic-runtime-control)
を参照してください。

migration など、閲覧は続けて変更だけを止めたいときは `bun run runtime-control:read-only` を使います。
API は `GET` / `HEAD` と、sign-in・token の更新・preview などの読み取り用 `POST` だけを通し、それ以外の変更を
`503`（problem の `code` は `maintenance_read_only`）で断ります。worker と WebSocket は `disabled` と同じく
止まります。`/api/ready` は `503`、`/api/maintenance` は `read-only` になれば完了です。alarm の確認はしません。
終わったら `bun run runtime-control:enable` で戻します。Web は「メンテナンス中」のバナーを出し、
`stopped` と `read-only` を障害（`unavailable`）と区別して表示します。sign-in の rate limit や監査 event など
付随する書き込みは残るので、書き込みを完全に止める必要がある作業は `disable` を使います
（[ADR 0034](../docs/adr/0034-read-only-maintenance-mode.md)）。local で表示を確かめるときは、API を
`MUKUROJI_LOCAL_RUNTIME_CONTROL_MODE=read-only`（または `disabled`）で起動します。

### 3. Bootstrap と API を検証する

Stack が user pool を作った場合、初期 owner は最初のサインインで password を変えるまで
`FORCE_CHANGE_PASSWORD` です。サインインを済ませ、`COGNITO_USER_POOL_ID` と
`COGNITO_USER_POOL_CLIENT_ID` に `UserPoolId` / `UserPoolClientId` output を入れてから検証します。

```sh
export PROJECT_DIRECTORY_TABLE_NAME="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='ProjectDirectoryTableName'].OutputValue | [0]" \
  --output text)"

bash scripts/validate-workspace-bootstrap.sh
```

`prepare-workspace-cognito.sh` は2つの client と external IdP contract を検証します。Bootstrap
validator は Cognito pool/password client、owner status/email、両 custom attribute、
Workspace metadata/owner/alias を consistent read で照合します。`-c mukuroji:demoData=true` で
deploy した stack では `MUKUROJI_DEMO_DATA=true` を付けて実行すると、demo Project 4 件の manager row
も照合します。

次に owner の新しい Cognito access token を用意し、CloudFront 経由と HTTP API 直接の経路がすべて `200` かつ同じ Workspace response を返すことを確認します。古い token は group / identity 更新前の session を表す可能性があるため再利用しません。

```sh
export WEB_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue | [0]" \
  --output text)"
export API_GATEWAY_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue | [0]" \
  --output text)"
export ACCESS_TOKEN=<fresh-owner-access-token>

curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${WEB_URL%/}/api/teams/projects"
curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${API_GATEWAY_URL%/}/teams/projects"
curl --fail-with-body -H "Authorization: Bearer $ACCESS_TOKEN" "${API_GATEWAY_URL%/}/api/teams/projects"
```

### 4. Web を配信する

```sh
AWS_REGION=ap-northeast-1 bun run web:deploy
```

`scripts/deploy-web.sh` は stack output から Web bucket と distribution を読み、`VITE_API_BASE_URL=/api` で
Web を build して upload し、CloudFront を invalidate します。content hash 付きの `assets/` は1年 cache し、
古い chunk も残すため、前の `index.html` を開いている browser も lazy chunk を読めます。`index.html`、
`sw.js` などそれ以外の file は `no-cache` で置き換えます。配信後に `WebUrl` を開き、login と Team/project
一覧の表示を確認します。local の Web から AWS の API を試す場合だけ、HTTP API を直接指定します。

CloudFront は Web と `/api/*` の両方に security header（HSTS、`X-Content-Type-Options`、`X-Frame-Options: DENY`、
`Referrer-Policy: no-referrer`、Content-Security-Policy）を付けます。Web の CSP は script・style・worker を同じ
origin に限り、接続先を同じ origin、realtime WebSocket API、file bucket に限ります。file bucket の CORS が
distribution の domain を参照するため、CloudFront の CSP は bucket 名を書けず、同じ region の S3 endpoint
（`https://*.s3.<region>.amazonaws.com`）を許可します。`scripts/deploy-web.sh` は `FileBucketName` と
`RealtimeWebSocketUrl` output から、接続先をこの stack の bucket と WebSocket API だけに絞る `<meta>` CSP を
`index.html` に加えます。browser は両方の policy を適用します。`/api/*` の CSP は `default-src 'none'` で、
API の応答が document として開かれても何も読み込みません。

```sh
VITE_API_BASE_URL="$API_GATEWAY_URL" bun run web:dev
```

`web:deploy` は commit していない変更があると止まります。build には `git rev-parse HEAD` の commit SHA を
埋め込み、Help 画面の「稼働中の Web build」に表示します。利用者から問題の報告を受けたら、この SHA で
どの release かを確認します。

#### Web の release を戻す

各 deploy は `assets/` 以外の file（`index.html`、`sw.js`、manifest など）を bucket の
`releases/<commit SHA>/` にも残します。残っている release が使う `assets/` は消さないため、残した release を bucket の直下へ
copy し直せば、再 build せずに前の release へ戻せます。

```sh
# 残っている release を新しい順に表示する
AWS_REGION=ap-northeast-1 bun run web:rollback
# 指定した commit の release に戻す（Help 画面に出る 40 文字の SHA）
AWS_REGION=ap-northeast-1 bun run web:rollback -- <commit SHA>
```

`scripts/rollback-web.sh` は `releases/<commit SHA>/` を bucket の直下へ copy し、直下にだけある file を
削除してから CloudFront を invalidate します。戻した後に `WebUrl` の Help 画面で SHA が切り替わったことを
確認します。この仕組みより前に deploy した release は残っていないため戻せません。

`releases/` と `release-assets.txt` は deploy と rollback の script が bucket を直接読むためだけに置いています。
CloudFront の viewer-request function がこれらの path に 404 を返すので、ブラウザからは開けません。

Web build の SHA と `/api/health` の `applicationCommitSha` が違うと、画面に再読み込みを促すお知らせが出ます。
deploy は API の後に Web を upload するため、その間に開いていた画面にも出ます。API だけ、または Web だけを
戻した場合は食い違いが続き、再読み込みしても「更新の途中の可能性があります」という旨のお知らせが出続けるので、
両方を同じ commit に揃えてください。

#### Web bucket の保存期間

Web bucket は versioning を有効にし、次の期間で古い file を消します。

- `releases/<commit SHA>/` は最後の upload から 180 日で lifecycle が削除します。戻せるのはこの期間内の
  release だけです。稼働中の release は bucket の直下にあるので、copy が消えても配信は続きます。
- 上書き・削除された file の旧 version は 30 日残り、その後 lifecycle が削除します。誤って消した file は
  この期間内なら `aws s3api list-object-versions` で探して戻せます。
- `assets/` は日数では消しません。稼働中の release の chunk は deploy しない限り upload し直されないため、
  日数で消すと配信中の画面が壊れるからです。代わりに各 release が使う `assets/` の一覧を
  `release-assets.txt` として残し、`web:deploy` が、残っている release、置き換える直前の release、
  今回の build のどれも使わない `assets/` を削除します。直近 24 時間に upload された file は、同時に走った
  別の deploy のものかもしれないので残します。一覧のない release（この仕組みより前の deploy）が
  残っている間は削除しません。

## Workspace partition migration

`WorkspaceDirectoryId` を変える操作は application deploy ではなく data migration です。CDK bootstrap は既存 task / issue / activity を新 partition へコピーしません。

安全な移行順序:

1. maintenance window を設定し、write を停止する。
2. source table 名、旧/new Workspace ID、item count、最新 timestamp を記録し、PITR / on-demand backup を確認する。
3. 同じ table 内の新 partition へ conditional put で copy する。Work Item / issue / event は全 row の payload `directoryId` を new Workspace ID に更新し、最低限、次の derived key を再構築する。
   - directory: team / project / project-member row の `directoryId=<workspace>`。通常の `entryKey` は維持する。
   - team issues: `directoryId=<workspace>`、`directoryTeamId=<workspace>#team#<teamId>`、存在する `directoryProjectId=<workspace>#project#<projectId>`
   - issue events: `directoryId=<workspace>`、`directoryTeamIssueId=<workspace>#team#<teamId>#issue#<issueId>`
   - `workspace-metadata`、`workspace-member`、`email-alias` の 3 種は旧 partition から copy しない。旧 `workspaceId` や owner key を残すと bootstrap condition と衝突するため、CDK deploy で new Workspace ID / owner parameter から再生成する。
4. source / destination の件数と代表 item を照合し、重複 key や未処理 write がないことを確認する。
5. new Workspace ID を parameter にして `cdk diff` / deploy を実行する。CDK が owner attributes と bootstrap row を new partition に揃える。
6. fresh token で CloudFront と HTTP API の両 endpoint を検証してから write を再開する。
7. rollback window 中は旧 partition を削除しない。

大量 data の migration を shell の `scan | put-item` で即時実行しないでください。この移行は key を変える copy なので、
下記「Data migration」の runner（同じ key の row の schema version を 1 つ上げるだけ）の対象外です。
[docs/data-migration.md](../docs/data-migration.md) のとおり ADR を伴う個別の変更として、pagination、retry、
conditional write、件数・内容の照合を備えた job を review・dry run してから実行します。

## Canonical Work Item deploy

CDK は canonical Work Item store として `WorkItemsTable` を作成し、table 名を `WorkItemsTableName` output で公開します。API Lambda には canonical Work Item / Issue resources の権限だけを付与します。

Demo data を有効にした場合、demo seed の custom resource は canonical `WorkItemsTable` だけに `creatorMemberKey`、`workflowSchemaVersion`、`workflowStatusId`、`statusCategory`、`customFieldValues`、空の `relationIds` を含む strict row を作成します。既存 row の upcast は行いません。

Deploy 時は `cdk diff` で canonical table の意図しない replacement/deletion がないことを確認します。Deploy 後は Team/project/Workspace list、任意の workflow status への detail update、stale revision の `409 WorkItemRevisionConflict` を CloudFront 経由と API Gateway 直接の両方で確認します。

保存済み row の schema を変える deploy では、row を削除して作り直さず、
[docs/data-migration.md](../docs/data-migration.md) の契約（dual-read の deploy → migration → `verify` の
`pass` → dual-read の終了）に従い、下記「Data migration」の手順で移行します。

## Data migration

保存済み row の schema version を上げる migration は、stack にある `DataMigrationFunction` を operator が起動して
実行します。migration の契約、dual-read の deploy 順、rollback、evidence は
[docs/data-migration.md](../docs/data-migration.md)、設計判断は
[ADR 0031](../docs/adr/0031-data-migration-lambda-and-operator-proof.md) にあります。

- `DataMigrationFunction` は schedule も event source も持たず、起動されたときだけ動きます（timeout 15 分、
  非同期起動の retry 0）。待機中の費用はかかりません。
- function の role は allowlist の table（今は `work-items` = `WorkItemsTable` と `project-directory` =
  `ProjectDirectoryTable`）に `Scan` / `GetItem` / `PutItem` / `ConditionCheckItem`（`derive` migration の元 row の確認、ADR 0038）、`DataMigrationCheckpointTable` に `Query` /
  `PutItem` だけを持ちます。別の table を移行する migration は、`cdk/lib/stacks/mukuroji-stack.ts` の
  `buildDataMigration` の `targets` に同じ PR で table を足します。
- `DataMigrationCheckpointTable` は `Retain`、PITR、deletion protection 付きです。checkpoint と run record
  （実行者の記録）を持つので、migration が終わっても削除しません。
- operator には table の権限を渡さず、`DataMigrationOperatorPolicyArn` の policy（この function の
  `lambda:InvokeFunction` だけ）を付けた principal で実行します。

```sh
export DATA_MIGRATION_FUNCTION="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name Mukuroji \
  --query "Stacks[0].Outputs[?OutputKey=='DataMigrationFunctionName'].OutputValue | [0]" \
  --output text)"

bun run data:migrate:aws list --function-name "$DATA_MIGRATION_FUNCTION"
bun run data:migrate:aws run --function-name "$DATA_MIGRATION_FUNCTION" --migration <id>
# 書き込みはユーザーの明示確認を取ってから
bun run data:migrate:aws run --function-name "$DATA_MIGRATION_FUNCTION" --migration <id> --apply
bun run data:migrate:aws verify --function-name "$DATA_MIGRATION_FUNCTION" --migration <id>
```

- 1 回の起動は、15 分の上限に 1 分と最後の page を書き切る時間を残して新しい page を読むのをやめ、`paused`（exit 3）で終わります。
  同じ command をもう一度実行すると checkpoint の続きから再開します。`verify` は毎回 table 全体を読み直します。
- `--apply` は operator の AWS credential で STS `GetCallerIdentity` の presigned URL を作り、この起動の
  parameter から作った digest を署名済み header に入れて送ります。function はその URL を自分の region の
  STS endpoint へ送り、STS が返した ARN を実行者として run record と log に残します。proof が無い、
  別の起動の proof、期限切れ、別 account のときは `OPERATOR_UNVERIFIED` で、row も checkpoint も書きません。
- 実行者の記録は checkpoint table の run record（`migrationId = RUN#<id>`）と、function の log group（1 年保持）
  の `data-migration.invocation` 行です。run record には実行者・物理 table 名・状態・counter が入り、
  row の key・内容と proof は入りません。log 行は `list` や断った起動も含めて起動ごとに 1 行で、論理 table 名
  だけを使い、物理 table 名・key・row の内容・proof は入りません。

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

## Capacity planning data

`CapacityPlanningTable` は `workspaceId` / `recordKey` を primary key とし、Team ごとの working schedule、holiday / time-off、resource request、resource assignment を一つの CAS 管理レコードへ保存します。API Lambda には `CAPACITY_PLANNING_TABLE_NAME` を設定し、capacity planning table への `GetItem` / 条件付き `PutItem` / `DescribeTable` だけを許可します。

Table は `PAY_PER_REQUEST`、`Retain`、PITR enabled で作成します。deploy 前後に `CapacityPlanningTableName` output と Lambda の `CAPACITY_PLANNING_TABLE_NAME` が同じ table を指すこと、table replacement がないこと、API role 以外へ workload の権限が付いていないことを確認してください。

## Analytics data and scheduled delivery

`AnalyticsTable` は `workspaceId` / `recordKey` をprimary keyとし、saved report、immutable
snapshot、scheduled delivery receiptをWorkspaceごとに保存します。Tableは
`PAY_PER_REQUEST`、`Retain`、PITR enabledです。Due reportは`ScheduleDueIndex`の
`scheduleShard` / `nextDeliveryAtRecordKey`で取得します。

Shared API Lambdaには`ANALYTICS_TABLE_NAME`と`ANALYTICS_SCHEDULE_INDEX_NAME`を設定し、
analytics tableへのread/writeだけをstack resourceへ限定して許可します。
Analytics scheduleは`ScheduledJobsFunction`の5分ごとのjobとして動き、同じreport occurrenceを
決定的なreceiptで重複排除します。Jobの権限は`AnalyticsScheduleJobPolicy`にまとまり、
AnalyticsTableへのread/writeに加えて、recipientのcurrent ACLとhistorical stateを評価するため、
`AuditEventsTable`、`ProjectDirectoryTable`、`WorkItemsTable`、`WorkspaceAccessTable`への
read-only権限だけを持ちます。Handler内で2回retryした後も失敗すると、invocationは14日保持の
encrypted `ScheduledJobsDlq`へ入り、visible messageが1件以上になるとCloudWatch alarmが
`ALARM`になります。

Schedule deliveryは現在のrecipient認可を確認できない場合に送信しないfail-closed contractです。
現行delivery boundaryはimmutable snapshotとin-app receiptの保存で、artifact rendererは外部
副作用を持ちません。SESや外部email providerの権限はAnalytics Lambdaへ付与しません。Emailを
追加する場合はtransactional outboxまたはdelivery state machine、provider adapter、secret、
bounce/retry運用を別変更として導入してください。またAnalyticsのために`AuditEventsTable` streamへ
3つ目のdirect event source mappingを追加しません。DynamoDB Streams は shard あたり 2 reader までを
推奨しており、`AuditEventsTable` の reader は `CollaborationProjectionFunction` と
`AutomationEventFunction` の 2 つです。テナントの監査ログ保持期間の反映のように、監査 event に反応する
処理を足すときは audit projection の fan-out に加えます。

Deploy前後に次を確認します。

1. `AnalyticsTableName` outputと両Lambdaの`ANALYTICS_TABLE_NAME`が同じtableを指す。
2. Table replacement/deletionがなく、PITRとRetainが維持される。
3. `ScheduleDueIndex`のkey schemaが変更されていない。
4. API roleと`AnalyticsScheduleJobPolicy`以外にanalytics table権限が付いていない。
5. `AnalyticsScheduleJobPolicy`のsource table権限がread-onlyで、write権限がAnalyticsTableだけに限定される。
6. `ScheduledJobsDlqUrl`の滞留とCloudWatch alarmを監視対象に追加する。

## Notification schedule

期限 schedule は1時間ごとに Work Items table の sparse GSI `WorkItemNotificationDueIndex`（partition `notificationScheduleShard` の16 shard、sort `notificationDueKey`）を query し、各 Work Item の canonical `schedule.calendarPolicy.timeZone` で due/overdue を評価して、同じ Work Item / due date / reason の event を決定的に重複排除します。index に載るのは archive されていない未完了の Work Item のうち、期限があるもの（sort key は期限日）と着手中のもの（sort key は `0000-00-00` で毎回読む）だけです。完了・archive・期限の削除で index から外れるため、読み取り量は Work Item の総数ではなく、期限が近い・超過した・着手中の Work Item の数に比例します。query 範囲は今日（UTC）+ 366 日までで、page 上限はありません。Customer 完了通知の marker は `WorkItemCustomerCompletionPreparationIndex`（KEYS_ONLY）から読みます。工数の督促は Project directory の Team 一覧を1日1回だけ読み、`NOTIFICATION_SCHEDULE_MAX_PAGES` は Planning の index と directory の読み取りにだけ使います。index 属性のない既存 row は次に更新されたときに index に入ります。既存 row への一括付与は #365 の migration 契約で行います。上限到達などで失敗した場合も例外として handler 内で retry され、最終失敗は `ScheduledJobsDlq` に保存されます。DLQ message の error message に失敗した job 名が入ります。DLQ の visible message が1件以上になると CloudWatch alarm が `ALARM` 状態になるため、alarm と DLQ message を調査して再実行してください。`CollaborationProjectionDlqUrl` と `ScheduledJobsDlqUrl` の滞留、Inbox の unread count も監視します。

## Scheduled jobs

定期実行の6つの job（Automation の recurring Work、Triage wake-up、Agent Run triage、Slack 通知、analytics、notification）は、`ScheduledJobsFunction` 1本と毎分の EventBridge rule 1つで動きます。Handler（`server/src/handlers/scheduled-jobs-handler.ts`）は event の予定時刻の分から due な job を選び、並行に実行します。

- 間隔は Automation、Triage、Agent Run triage、Slack が毎分、analytics が5分ごと、notification が毎時0分です。
- 各 job は自分の runtime-control scope で判定されます。Lambda の `MUKUROJI_RUNTIME_CONTROL_SCOPE` は全 scope をカンマ区切りで持ちます。
- Retry は handler 内で job ごとに行います（Slack は二重送信を避けるため1回、他は最大3回）。Lambda 自体の非同期 retry は0回で、1つでも job が失敗した invocation は `ScheduledJobsDlq` に入ります。
- 権限は job ごとの customer-managed policy（`<Job>JobPolicy`）に分けて同じ role へ付けます。Inline policy は role 全体で10,240文字までなので、job の権限は managed policy（各6,144文字）に置きます。Role は共有なので、job 間の権限分離は IAM の境界ではなくコードレビューで保ちます。
- DLQ message の error message には、失敗した job ごとに最後の error の名前と message が入ります。

## Rollback

code / infrastructure rollback は、原則として直前に成功したrevisionのcode/configurationを、
review済みの新しい`ApiRuntimeConfigurationRevision`とその他の同じ必須parameters
（request intake用の2 secretとalarm topic名を含む）でforward deployします。既にretainedされた
旧API configuration secretは自動では再接続されないため、同じ物理名を再作成する目的で旧revisionを
再利用しません。現行 stack に存在する retained resource を rollback template から削除しないでください。DynamoDB table は `Retain` で、PITR も有効ですが、stack から外れた resource は自動で再接続されません。Cognito custom schema は rollback しても残ります。

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

## Scheduled isolated restore drill

復元ドリルは任意の module で、既定では deploy しません。有効にすると Step Functions workflow、
KMS key 付きの scratch / evidence bucket などが増えます。evidence bucket は 400 日の Object Lock
COMPLIANCE を使うため、一度書いた evidence は保持期間が終わるまで誰も削除できません。
有効にするときは CDK context で指定し、`RestoreDrillCleanupApproverRoleArn` も渡します。

```sh
bun --filter cdk cdk deploy Mukuroji \
  -c mukuroji:restoreDrill=true \
  --parameters RestoreDrillCleanupApproverRoleArn='arn:aws:iam::<account-id>:role/<data-owner-role>' \
  ...
```

無効のときは drill の resource、output、parameter がなく、削除済み file version を読める principal も
ありません。以下はこの module を有効にした場合の動作です。

Incident recoveryとは別に、daily due scannerが直近の成功済みverificationから89日で同一regionの
隔離drillをadmitし、90日でoverdue alarmを発火します。Standard Step Functions workflowは
Work Items、Work Item Configuration、Project Directory、Workspace Access、Audit Events、
File Proofingの6表を共通PITR pointへ`mukuroji-restore-drill-` prefixの別名tableとして復元します。
API/workerのrole、runtime configuration、environment、traffic routeにはrestore tableやscratch
bucketを渡しません。

Exact content baselineは稼働中source tableのScanではなく、同じrestore pointの
`DYNAMODB_JSON` exportです。File Proofingが参照するsource S3 VersionIdはprivate/KMS/versioned
scratch bucketへexact copyします。Productionと共通の2 GiB上限まで、source/destination bodyを
exact VersionId付きの最大16 MiB S3 Rangeで独立streamし、range digestとresponse identityを照合した
authenticated chainをdurable CASします。`CopyObject`のSDK retry/応答消失で複数VersionIdが
作られた場合はpre-copy baselineとの差分を全件cleanup scopeへ永続化し、決定的に選んだ1件だけを
検証して隔離済みmetadataへ反映します。

Export data file、restore Scan page、completed File proof、cross-domain semantic row/claimはboundedな
単位でincrementalに処理します。上限超過はpartial successにせずfailed evidenceとalarm/remediationへ
進みますが、failure finalizerのcleanup inventoryは検証上限で切り捨てません。Descriptor gateは
attribute definitions、base key schema、GSI key/projection/ACTIVE、billing、SSE/KMS、source TTL contractと
restore TTL disabledだけを検証します。DynamoDB Streams、CloudWatch alarm、resource tag、
IAM/application binding、traffic routingはこのdata-verification gateの対象ではありません。
RPO 300秒、RTO 14,400秒、descriptor、item/partition count、content aggregate、S3
body/metadata/tag、cross-domain invariantのいずれかが未達ならrunはfailed evidenceをsealします。

Main workflowのWaitはhandlerが返すdynamic秒数を使います。Durable cursor/stateだけが進んだ場合は
0秒で再駆動し、AWS restore/export/delete/abortの収束またはcopy claim待ちだけをbounded pollします。
Eligibleなverification stageは1 Lambda invocationで最大50 logical stepをbatchし、8分のelapsed-time
guardでdurable checkpointへ戻ります。Semantic Scanは1 logical stepあたりraw row最大25件、
requirement/Audit reducerは最大100 durable recordです。Logical data上限は全最大値を1 runのRTO内に
処理できるというcapacity保証ではありません。1 normalized pageのclaim上限150,000は、DynamoDBの
物理1 MiB pageから算出した最大143,485件を切り上げた値です。Main-loop `pending`は0秒redriveも含めて
execution全体の1,200 poll-loop iteration fuseを共有し、なお継続が必要なら専用finalizerで非integrityの
`WORKFLOW_POLL_BUDGET_EXCEEDED`をsealします。Initial/poll task errorはdurable failure-finalizer loopへ
入り、main workflowの`FAILED`または270分`TIMED_OUT` statusは別のStandard finalizer workflowが同じ
seal処理を再開します。Failure finalizerは最大50 zero-wait stepまたは8分を1 invocationで処理します。
Generic Lambda/AWS/KMS/state-store failureは非integrityの`WORKFLOW_TASK_FAILED`としてsealし、
全sealed failureを`DrillFailureCount`へ加算します。明示的なdescriptor/aggregate/cross-domain/
File-copy mismatchだけを追加でintegrity metricへ加算します。
Step Functions status eventが欠落しても、
次のdaily scannerがdeadline超過runのrevisionとrunner execution ARNをCAS更新してownerを引き継ぎ、
stale executionを拒否したうえでfailure evidenceをsealします。

`RestoreDrillEvidenceBucketName`はKMS、versioning、Object Lock COMPLIANCE 400日、Retain、
access logを持つappend-only evidence先です。`RestoreDrillStateTableName`はlease/checkpoint、
exact resource locator、cleanup stateを保持するretained/PITR storeであり、外部へ公開する
secret-free evidenceとは分離します。Raw object locatorやresume cursorはこのrestricted stateだけに
保持し、semantic joinのdurable dataはopaque HMAC claimに変換します。Runner roleのwrite先は
`evidence/v1/runs/<drill-id>/result.json`、cleanup roleのwrite先は同runの`cleanup.json`に分離し、
相互のartifactを書き換えられないIAM境界にします。
State tableにはTTLやrun完了後のDeleteItemを設定していないため、resource cleanup後もper-run recordを
期限なく保持します。Capacity/costを監視し、将来のjanitor/retirementは別のreview済みlifecycle changeで
導入してください。

Pass/failどちらのrunも`awaiting-cleanup-approval`で停止します。Data ownerは短命sessionへ
`RestoreDrillCleanupApproverRoleArn`で指定した既存roleだけに
`RestoreDrillCleanupApprovalPolicyArn`を一時的にattachし、terminal evidence digest、exact isolated
resource vector、change locator、有効期限を束縛したreceiptをObject Lock配下へno-clobber保存してから
`RestoreDrillCleanupStateMachineArn`を開始します。Cleanup roleは記録済みrestore tableとscratch
File/export object VersionId、およびrun-owned DynamoDB export prefixesのincomplete multipart uploadだけを
削除・abortでき、source table/objectとevidence bucketへのdelete権限を持ちません。Multipart uploadも
approvalのresource digest/inventoryへ含め、cleanupは1 logical step最大25 targetを処理します。
1 invocationはRUNとpinned cleanup executionを各step前に再検証しながら最大50 zero-wait stepまたは
8分までbatchし、`RUNNING`かつ`redriveCount=0`でないexecutionを拒否します。external waitが必要なら
終了します。全resourceのabsence receiptと、run prefixに
multipart uploadが残っていないことを確認するまでcleanupを完了扱いにしないでください。
Cleanup targetはmutable run partitionとは別の`RESTORE_DRILL_LEDGER#<drill-id>`へappend-onlyで保存し、
count/revisionとscope sealを同じcondition boundaryで固定します。CopyObject intentはrunner停止後に
16分のquiet windowを挟んで2回全件reconcileし、digest/cursorが一致してからscopeをsealします。
Cleanup roleはledgerをGet/Queryだけで読み、mutable progressを`RESTORE_DRILL_CLEANUP#<drill-id>`へ
限定して書き、RUN/CADENCEはcleanup-owned属性だけをconditional Updateします。

Cleanup workflowには明示的なphysical nameを与え、approval policyの`StartExecution`/
`ListExecutions`とapproval/cleanup roleの`DescribeExecution`をその同じstate machine/execution ARNへ
限定します。Timeout finalizer workflowのidentityをcleanup approvalやreapprovalへ流用しません。
失敗・timeout・abortしたcleanupを再承認する場合は、pinned executionのterminal `stopDate`から
16分経過後に新しいreceiptと実行名を発行します。既存receiptや実行名を再利用しません。

詳細な判定・evidence・alarm responseは
[`docs/restore-drill.md`](../docs/restore-drill.md) と
[`docs/operational-readiness.md`](../docs/operational-readiness.md#pitr-restore-drill)を参照してください。

## Security and durability checks

- HTTP API の route auth は `NONE` ですが、Hono API が Cognito Bearer token の issuer / client / token use を検証します。
- 本番の Web は CloudFront の同じ origin から API を呼ぶため CORS を使いません。HTTP API と Hono の CORS は `ApiAllowedOrigins` にそろえ、本番で local default を使いません。
- Web bucket は public access をすべて block し、CloudFront の origin access control だけが読みます。
- Lambda IAM は stack table、`workspaces/` file object prefix、指定 user pool に限定します。API role に bucket-wide `ListBucket` は付与しません。
- Email ingestion Lambda は HTTP route を持たず、Request Intake table と failure DLQ 以外の data-plane 権限を持ちません。
- Enterprise SCIM group reconciliation は API Lambda と concurrency を共有しない専用 Lambda で実行します。
  Worker は60秒 timeout、reserved concurrency 5、batch size 1で既存DLQへ失敗を送り、API Lambda は
  Stream権限を持たず15秒 timeoutを維持します。Worker IAMはEnterprise Identity/Workspace Access/
  Planning/Audit/Project Directoryの必要なGet/Query/transaction操作と、指定Cognito user poolの
  enable/disable/global sign-outに限定します。
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
- API Lambda は `server/src/handlers/api.handler.ts`、SCIM group worker は
  `server/src/handlers/enterprise-scim-group-job-worker-handler.ts` を deploy 時に個別bundleします。

## Commands

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun --filter cdk cdk diff Mukuroji
```
