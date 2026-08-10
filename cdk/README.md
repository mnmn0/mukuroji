# mukuroji AWS deployment

この CDK stack は shared Hono handler を Node.js 22 Lambda に bundle し、Lambda Function URL と API Gateway HTTP API の両方へ接続します。DynamoDB table、request intake の email ingestion boundary、private file bucket、GuardDuty malware scan、CORS / IAM、外部 Cognito 設定、Workspace bootstrap も同じ stack で管理します。

コマンドは repository root から実行してください。AWS account を変更する `deploy`、Cognito 更新、data migration / recovery は、対象 account・region と `cdk diff` を確認してから実行します。

## Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `AlarmPrimaryTopicName` | yes | 全 CloudWatch alarm の primary action に使う、同一 account/region 内の既存 standard SNS topic 名。 |
| `AlarmSecondaryTopicName` | yes | 全 CloudWatch alarm の secondary action に使う、primary と異なる同一 account/region 内の既存 standard SNS topic 名。 |
| `CognitoUserPoolId` | yes | 既存 Cognito user pool ID。access token の issuer と IAM scope に使います。 |
| `CognitoUserPoolClientId` | yes | client secret なし、`ALLOW_USER_PASSWORD_AUTH` 有効の既存 password/API public app client ID。access token の `client_id` と照合します。 |
| `CognitoSsoUserPoolClientId` | yes | Password client とは異なる、Hosted UI authorization-code + PKCE 専用 public app client ID。 |
| `CognitoHostedUiDomain` | yes | Enterprise SSO authorization-code flow に使う Cognito managed login domain。 |
| `CognitoSsoRedirectUri` | yes | App client callback に完全一致で登録した HTTPS SPA callback URI。 |
| `CognitoEnterpriseIdpName` | yes | Cognito に接続した SAML/OIDC provider 名。 |
| `WorkspaceDirectoryId` | yes | Cognito の両 custom attribute と DynamoDB partition に使う canonical ID。例: `workspace#production`。 |
| `WorkspaceAuditPseudonymKey` | yes | Workspace/member/invitation の公開 audit ID を HMAC 化する、32-byte random値を表す64桁の小文字hex固定 key。`openssl rand -hex 32` などで生成し、`NoEcho` で Lambda に渡してbackfillにも同じ値を設定します。 |
| `RestoreDrillCleanupApproverRoleArn` | yes | Cleanup approval policyを一時attachできる唯一の既存data-owner IAM role ARN。別roleへpolicyをattachしてもapproval APIは許可されず、receipt内のSTS assumed-role sessionもこのroleへ帰属する必要があります。 |
| `ApiRuntimeConfigurationRevision` | yes | 1〜32文字のoperator管理revision。先頭はASCII英数字、以降はASCII英数字と `.` `_` `-` だけを使えます（例: `2026-07-28-01`）。API code、または4分割runtime configuration secretへ入るparameter/resource値を変更するdeployごとに増分し、同じrevisionを異なる内容へ再利用しません。 |
| `WorkspaceSearchWriterFenceMode` | yes | 初回bootstrap前の明示的な二段階rolloutでは`rollout-pending`、open row作成後の定常状態では`required`。既定値はなく、通常deployで`required`から戻しません。 |
| `InitialOwnerEmail` | yes | lowercase の初期 owner email。Workspace/member/alias key に使います。 |
| `InitialOwnerUsername` | yes | `AdminUpdateUserAttributes` に渡す Cognito username。email と異なる username も指定できます。 |
| `TaskApiAllowedOrigins` | production では必須 | 空白なしの comma-separated CORS origin。既定値は local development 用です。 |
| `SystemAdminGroups` | no | system-admin とみなす comma-separated Cognito group。既定値は `mukuroji-system-admins`。 |
| `ConnectorRuntimeConfiguration` | no | connector 用 Secrets Manager secret の初期 JSON。`NoEcho`、既定値 `{}`。本番 credential は parameter で渡さず、deploy 後に secret value を更新します。 |
| `RequestRateLimitPerHour` | no | public request capability ごとの1時間あたり submit 上限。既定値は 10、範囲は 1–10000 です。 |
| `RequestEmailWebhookSecret` | yes | email adapter から渡される envelope の署名検証に使う 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `RequestTokenHashSecret` | yes | public form / reply capability token を保存前に hash する 32–256 文字の secret。CloudFormation では `NoEcho` です。 |
| `EnterpriseIdentityTokenHashSecret` | yes | SCIM bearer token と service account credential の kind・Workspace・credential-ID domain-separated digest、および10分間の idempotency response recovery 用 token 導出に使う32–256文字の安定した secret。CloudFormation では `NoEcho` です。 |
| `EnterpriseSsoStateSecret` | yes | 短命な OAuth state を署名する専用の32–256文字 secret。CloudFormation では `NoEcho` です。 |
| `FileRetentionDays` | no | soft delete 後の metadata と S3 noncurrent version の保持日数。既定値は 30 日です。live current object の有効期限ではありません。 |
| `FileUploadUrlTtlSeconds` | no | direct upload URL の有効秒数。既定値 600、範囲 60–3600 秒です。bucket policy もこの上限より古い upload 署名を拒否します。 |
| `FileDownloadUrlTtlSeconds` | no | malware scan 済み file の download URL 有効秒数。既定値 300、範囲 60–3600 秒です。bucket policy もこの上限より古い download 署名を拒否します。 |

`WorkspaceDirectoryId`、`WorkspaceAuditPseudonymKey`、owner email / username は data key と認可境界に使います。環境ごとに固定し、通常の application deploy で変更しないでください。pseudonym key を変更すると既存 resource の audit timeline が分裂するため、通常の rotation 対象にはしません。

### Workspace Search migration deployment target

Migration rehearsalのaccount、Region、environmentはCloudFormation parameterでは指定しません。
CDK contextの`workspaceSearchMigrationDeploymentTarget`は、
[`lib/config/workspace-search-migration-deployment-targets.ts`](lib/config/workspace-search-migration-deployment-targets.ts)
にreview済みcodeとして固定したtarget IDを選ぶだけです。未知のID、不完全なtarget、stackの
account/Regionとの不一致はsynth時に失敗します。現在のmapはrehearsal resourceを作成しない
`production-disabled`だけを含みます。

実non-production targetの追加は、具体的で互いに異なるdeployment accountとproduction-account digest、
固定Region、`rehearsalEnabled=true`を同じsource mapへ追加する独立したreview対象です。追加時はcloud assemblyと
`cdk diff`をreviewし、stack environmentとCloudFormation assertionがexact account/Regionへ固定されることを
確認します。Production account IDそのものはsource、template、tag、outputへ保存せず、private permit入力から
domain-separated SHA-256を計算してCDKのdigest tagと照合します。

## API observability

Application Lambda 25個は X-Ray active tracing を有効にし、各 execution role には X-Ray が要求する
trace/telemetry write action だけを追加します。API Lambda は readiness probe 用に
`AuditEventsTable`、`WorkItemsTable`、`WorkspaceAccessTable` への `dynamodb:DescribeTable` だけを
持つ独立 policy を使います。

Stack は API Lambda の `Errors`、`Throttles`、p95 `Duration`（12秒）、HTTP API の 5xx、
application EMF の `ServerErrorCount` を CloudWatch alarm として作成します。Workspace Search
migration専用の6 alarmを含む45 metric alarmと
1 composite alarmの
`AlarmActions` は、必須parameterで指定した既存のprimary/secondary SNS topicへ接続します。
Stackはtopic、subscription、Incident Manager escalation planを作成・変更しません。Topic ownerは
同一account/regionのstandard topicを用意し、managed rosterへのsubscription、暗号化key policy、
test notificationの受信をdeploy前に確認してください。CloudWatchはalarm遷移時に両topicへ同時に
publishするため、ack target未達時の段階escalationはsubscription先のon-call systemで管理します。
非同期 worker の DLQ alarm に加え、Notification schedule は failure destination 自体への配信失敗を
`DestinationDeliveryFailures` で別に検出します。Audit projection、Automation event/schedule、
Analytics/Notification schedule、Enterprise SCIM group/identity maintenance の各 DLQ は14日保持し、
stack replacement/delete 時にも Retain します。

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
history、両subscriptionの受信時刻/message ID、`ALARM → OK`への復帰を保存します。全46 alarmの
`AlarmActions`がprimary/secondaryの2 ARNを含み、inventory済みの既存actionも保持していることを
templateとdeployed configurationの両方で照合します。

### Workspace Search migration alarms

`Mukuroji/WorkspaceSearchMigration` namespaceには、
`Service=mukuroji-workspace-search-migration`だけをdimensionとする次の6 alarmがあります。

- `WorkspaceSearchMigrationDescribeTableThrottleAlarm`
- `WorkspaceSearchMigrationDescribeTableBudgetStopAlarm`
- `WorkspaceSearchMigrationRateBudgetExhaustionAlarm`
- `WorkspaceSearchMigrationCheckpointStallAlarm`
- `WorkspaceSearchMigrationQuarantineAlarm`
- `WorkspaceSearchMigrationTerminalFailureAlarm`

すべて5分`Sum >= 1`、evaluation/datapoints 1/1、`TreatMissingData=notBreaching`です。
Run ID、table、tenant、operation、phase、outcome、correlationはdimensionにしません。既存のalarm routing
aspectがprimary/secondaryの両SNS actionを付与します。Stackは追加topicやmigration用
`PutMetricData`権限を作成しません。review済みtargetが`environment=non-production`かつ
`rehearsalEnabled=true`のときだけ、
6 alarmの`ALARM`通知を受けるprimary/secondary別のfilter済みSQS subscriptionと、未接続collector policyを
作成します。CLIのterminal EMFと即時live-stall EMFをmetric化する実行surfaceは、
そのstdout/stderrの両方をCloudWatch Logsへingestする必要があります。Alarm response、secret-free correlation、非本番の
real metricによる`OK → ALARM → OK`と両receiptの手順は
[`docs/operational-readiness.md`](../docs/operational-readiness.md)を参照してください。

## Outputs

- `ProjectTasksFunctionUrl`: Lambda Function URL
- `ProjectTasksApiGatewayUrl`: API Gateway HTTP API URL
- `ProjectTasksApiUrl`: Function URL の後方互換 output
- `ProjectTasksTableName`（legacy read-only compatibility）
- `WorkItemsTableName`（既存 `TeamIssuesTable` を昇格した canonical store）
- `TeamIssuesTableName`（`WorkItemsTableName` と同じ table を指す互換 output）
- `WorkItemConfigurationTableName`（workflow、custom field、relation graph の scope store）
- `PlanningTableName`（cycle、goal、milestone、roadmap、portfolio の計画 store）
- `DocumentsTableName`（document、whiteboard、share、comment の workspace store）
- `AnalyticsTableName`（report、immutable snapshot、scheduled delivery receipt の store）
- `RequestIntakeTableName`（form version、link capability、submission、queue、reply thread の scope store）
- `RequestEmailIngestionFunctionName`, `RequestEmailIngestionDlqUrl`
- `ProjectDirectoryTableName`, `TeamIssueEventsTableName`
- `FileProofingTableName`, `FileBucketName`, `FileMalwareProtectionPlanId`
- `FileBucketIncarnationMarkerKey`, `FileBucketIncarnationMarkerVersionId`, `FileBucketIncarnationMarkerChecksumSha256`, `FileBucketIncarnationMarkerSize`（同名 bucket 再作成を検出する固定 marker の exact S3 version、base64 SHA-256、byte size。cross-domain integrity operator の明示入力に使い、current version へ fallback しない）
- `CrossDomainIntegrityOperatorPolicyArn`（6表の `Scan` / `DescribeTable`、exact FileBucket の `GetBucketVersioning`、`workspaces/*` の exact-version read、出力された marker VersionId に条件固定した marker exact-key read だけを持つ未接続 read-only policy）
- `NotificationsTableName`, `CollaborationProjectionDlqUrl`, `NotificationScheduleDlqUrl`
- `AnalyticsScheduleDlqUrl`
- `AuditEventsTableName`, `ProcessedAuditEventsTableName`
- `EnterpriseIdentityMaintenanceDlqUrl`
- `EnterpriseScimGroupJobFunctionName`, `EnterpriseScimGroupJobDlqUrl`
- `EnterpriseIdentityTableName`（Workspace generation/`CONTROL` checkpoint、global domain claim、SSO/policy/role、SCIM projection、provisioning run の store。Enterprise Identity 専用 GSI は持ちません）
- `WorkItemCollaborationTableName`, `RealtimeSessionsTableName`, `RealtimeWebSocketUrl`
- `WorkspaceSearchTableName`（検索文書、saved/task view、ユーザー別 view preference、24 時間保持の task view mutation receipt。receipt のみ `expiresAt` TTL で失効）
- `WorkspaceSearchMigrationStateTableName`（lease、checkpoint、operation receipt 用の retained/PITR store）
- `WorkspaceSearchMigrationDeploymentTargetId`, `WorkspaceSearchMigrationDeploymentTrustVersion`, `WorkspaceSearchMigrationDeploymentEnvironment`, `WorkspaceSearchMigrationDeploymentAccount`, `WorkspaceSearchMigrationDeploymentRegion`, `WorkspaceSearchMigrationProductionAccountDigest`, `WorkspaceSearchMigrationDeploymentTrustRootDigest`（review済みsource mapから決まるcanonical deployment trust root。raw production account IDは含めない）
- `WorkspaceSearchMigrationJournalBucketName`, `WorkspaceSearchMigrationJournalKeyArn`（通常artifactは30–31日、`workspace-search/v1/rehearsal/evidence-*`だけ365–366日の Object Lock COMPLIANCE 付きlossless migration artifact store。Preimage journal segment は2 MiB以下、planning raw source/target artifact segment は16 MiB以下の単一 `PutObject` に限定し、multipart upload は許可しません。専用 access log bucket は current/noncurrent version を90日保持）
- `WorkspaceSearchMigrationOperatorPolicyArn`（承認済み operator principal へ明示的に attach する未接続 policy。通常journalの30–31日保持権限だけを持つ）
- `WorkspaceSearchMigrationRehearsalEvidencePolicyArn`（`non-production`だけに出力する未接続policy。Issue 167のimmutable evidenceを365–366日へ延長する実行時だけoperator policyと同じ短命roleへ追加する）
- `WorkspaceSearchMigrationAlarmEvidenceAlarmArns`, `WorkspaceSearchMigrationAlarmEvidencePrimaryQueueUrl`, `WorkspaceSearchMigrationAlarmEvidenceSecondaryQueueUrl`, `WorkspaceSearchMigrationAlarmEvidenceCollectorPolicyArn`（`non-production`だけに出力する6 alarmのcanonical vector、route別receipt queue、未接続collector policy）
- `WorkspaceSearchMigrationAlarmEvidenceSignalLogGroupName`, `WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamName`, `WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamArn`, `WorkspaceSearchMigrationAlarmEvidenceIngestionPolicyArn`（`non-production`だけに作成するretained 365日LogGroup、固定/precreated `alarm-signals-v1` stream、そのstreamへの`logs:PutLogEvents`だけを許す未接続ingestion policy。production operator policyには接続しない）
- `WorkspaceSearchMigrationAlarmEvidenceDeploymentTrustRootDigest`, `WorkspaceSearchMigrationAlarmEvidenceDeploymentTargetId`（条件付きalarm evidence sinkを同じdeployment trust rootへ束縛する値）
- `RestoreDrillStateMachineArn`, `RestoreDrillCleanupStateMachineArn`
- `RestoreDrillEvidenceBucketName`, `RestoreDrillScratchBucketName`, `RestoreDrillStateTableName`
- `RestoreDrillCleanupApprovalPolicyArn`, `RestoreDrillScheduleDlqUrl`
- `DeveloperPlatformTableName`, `DeveloperPlatformLookupIndexName`
- `WebhookDeliveryQueueUrl`, `WebhookDeliveryDlqUrl`
- `WorkItemImportBucketName`, `WorkItemImportQueueUrl`, `WorkItemImportDlqUrl`
- `ConnectorRuntimeSecretArn`, `ConnectorSyncQueueUrl`, `ConnectorSyncDlqUrl`, `ConnectorPollDlqUrl`
- `WorkspaceDirectoryId`

Function URL と API Gateway は同じ Lambda を呼びます。いずれも `<base>/teams/projects` と `<base>/api/teams/projects` を同じ canonical `/api` route へ正規化します。

Shared APIのproduction runtime configurationは4つのSecrets Manager secretへ分割し、Lambda
environmentにはそのARNだけを渡します。各secret名は`ApiRuntimeConfigurationRevision`を含み、
replacement時の旧secretは`Retain`されます。Retained secretはrollback/recovery evidenceであり、
CloudFormationが旧resourceへ自動で再接続したり不要secretを削除したりはしません。
各groupはCloudFormation transformを使わないv2 line envelopeで、固定group identity、同一revision、
canonical Base64 valueまたはnested Secret ARNを保持します。NoEcho parameterの4値はprocessed
templateへ展開させず、revision-boundな個別retained secretの`SecretString`へ直接`Ref`します。
Document public-share secretを含む5つのnested secretはAPI roleだけが読みます。Loaderは4 groupの
identity/revision、全canonical key、nested secretを検証し終えてから環境へ原子的に反映します。

この仕組みを初めてdeployすると、既存の自動命名Lambdaから明示名末尾`-api-v2`のLambdaへ一度だけ
置換されます。したがって`ProjectTasksFunctionUrl`と、その後方互換output
`ProjectTasksApiUrl`は変わるため、Function URL consumerは新しいoutputへ計画的に切り替えてください。
`ProjectTasksApiGatewayUrl`は同じHTTP API endpointを維持し、default routeだけを`live` Aliasへ
切り替えます。以後は、新しいconfiguration secretとLambda Versionの準備完了後にAliasが新Versionへ
切り替わるため、HTTP API trafficはcode/configurationが揃ったversion単位で切り替わります。

## Connector runtime configuration

Stack は provider 設定と signing secret 用の Secrets Manager secret を `{}` で作成し、専用の rotation-enabled KMS key で暗号化します。Secret の read 権限は OAuth callback を扱う API Lambda と provider 呼び出しを行う connector queue worker に限定します。Audit stream projection と scheduled poller は secret を読まず、secret-free な sync job ID だけを SQS へ送ります。

Production credential を CloudFormation parameter、Lambda environment、repository、`cdk diff`、shell history に含めないでください。初回 deploy 後に `ConnectorRuntimeSecretArn` output を取得し、権限を限定した作業端末から reviewed JSON file を新しい secret version として保存します。

```sh
export CONNECTOR_RUNTIME_SECRET_ARN="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name CdkStack \
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

export STACK_NAME=CdkStack
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

`RequestEmailIngestionFunction` は public HTTP URL、API Gateway route、SES receipt rule をこの stack では持ちません。Email provider / SES adapter は署名付きの正規化 envelope を作り、明示的に `lambda:InvokeFunction` を許可された principal からこの Lambda を非同期 invoke してください。Lambda は `RequestEmailWebhookSecret` で envelope を検証し、`RequestTokenHashSecret` で reply capability を解決します。Execution role は `RequestIntakeTable` への direct `GetItem` と、`dynamodb:EnclosingOperation=TransactWriteItems` 条件付き `PutItem`、failure destination の `GetQueueAttributes` / `GetQueueUrl` / `SendMessage` だけを持ちます。非同期 retry を2回使い、最終失敗は14日保持・stack rollback 時 Retain の encrypted DLQへ送られます。Visible message と `DestinationDeliveryFailures` は別々の alarm で検出し、stack共通のprimary/secondary SNS actionへ通知します。

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
export MUKUROJI_ALARM_PRIMARY_TOPIC_NAME=<primary-standard-sns-topic-name>
export MUKUROJI_ALARM_SECONDARY_TOPIC_NAME=<secondary-standard-sns-topic-name>

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

# 初回writer-fence bootstrap前だけ rollout-pending。bootstrap後は required。
export MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION=2026-07-28-01
export MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=rollout-pending
export MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN=arn:aws:iam::<account-id>:role/<data-owner-role>

bun --filter cdk cdk diff CdkStack \
  --parameters CognitoUserPoolId="$COGNITO_USER_POOL_ID" \
  --parameters CognitoUserPoolClientId="$COGNITO_USER_POOL_CLIENT_ID" \
  --parameters CognitoSsoUserPoolClientId="$COGNITO_SSO_USER_POOL_CLIENT_ID" \
  --parameters CognitoHostedUiDomain="$COGNITO_HOSTED_UI_DOMAIN" \
  --parameters CognitoSsoRedirectUri="$COGNITO_SSO_REDIRECT_URI" \
  --parameters CognitoEnterpriseIdpName="$COGNITO_ENTERPRISE_IDP_NAME" \
  --parameters WorkspaceDirectoryId="$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  --parameters WorkspaceAuditPseudonymKey="$MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY" \
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters WorkspaceSearchWriterFenceMode="$MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE" \
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
  --parameters RestoreDrillCleanupApproverRoleArn="$MUKUROJI_RESTORE_DRILL_CLEANUP_APPROVER_ROLE_ARN" \
  --parameters EnterpriseIdentityTokenHashSecret="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
  --parameters EnterpriseSsoStateSecret="$ENTERPRISE_SSO_STATE_SECRET" \
  --parameters InitialOwnerEmail="$MUKUROJI_INITIAL_OWNER_EMAIL" \
  --parameters InitialOwnerUsername="$MUKUROJI_INITIAL_OWNER_USERNAME" \
  --parameters RequestEmailWebhookSecret="$MUKUROJI_REQUEST_EMAIL_WEBHOOK_SECRET" \
  --parameters RequestTokenHashSecret="$MUKUROJI_REQUEST_TOKEN_HASH_SECRET" \
  --parameters AlarmPrimaryTopicName="$MUKUROJI_ALARM_PRIMARY_TOPIC_NAME" \
  --parameters AlarmSecondaryTopicName="$MUKUROJI_ALARM_SECONDARY_TOPIC_NAME" \
  --parameters ApiRuntimeConfigurationRevision="$MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION" \
  --parameters WorkspaceSearchWriterFenceMode="$MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE" \
  --parameters TaskApiAllowedOrigins=https://app.example.com \
  --outputs-file /tmp/mukuroji-cdk-outputs.json
```

`--outputs-file`はdeploy直後のoutput照合用スナップショットです。`/tmp`のファイルだけを
永続的な変更証跡とはせず、stack ID、deploy時刻、change set、API runtime revision、
writer-fence mode、outputファイルのSHA-256をアクセス制御されたchange recordへ保存します。
outputにはSecret ARNなどのresource metadataが含まれるため、access tokenやsecret値を追記せず、
照合後のローカルファイルは削除します。

初回配線を`rollout-pending`でdeployすると、AppConfigの初期baselineは`disabled`でall-at-once
deployされ、controlled Lambdaはその完了に依存します。Webhook authorization backfill custom
resourceも両handler Lambdaの更新完了に依存し、event propertyとLambda環境のmodeが一致しない場合は
I/O前に停止します。pending中のCreate/Updateはtable access前に短絡します。Deleteはv3 markerと
checkpointを強整合readし、stateが空ならwriteなしで完了し、既存stateがあればpending barrierを
bypassせずdurable open-row guard付きtransactionでrollbackを完了するまで削除を成功させません。全writerの
drainを確認してfresh authorityに束縛したopen rowをbootstrapし、続けて値を`required`へ変更します。
Application clientもpending中はfenced mutationをnetwork I/O前に拒否し、AppConfig admissionの
誤再開だけではunguarded writeへ戻りません。
Guarded backfillの完了とwriter clientを構築する全12 Lambdaへの反映を確認した後、新しい
AppConfig `enabled` revisionをdeployしてwriterを再開します。CloudFormation更新中の
pending/required混在を許容してwriterを再開したり、通常rollbackとして`required`から
`rollout-pending`へ戻したりしないでください。

`MUKUROJI_API_RUNTIME_CONFIGURATION_REVISION`はAPIのcode、またはruntime configuration secretへ
入るparameter/resource値が変わるdeployごとに新しい値へ進め、`cdk diff`とdeployへ同じ値を渡します。
同じrevisionのsecret内容を更新するとimmutable rolloutの前提が崩れるため、revisionを再利用しません。
初回`-api-v2`置換時はFunction URL outputの切替計画をchange recordに含めます。HTTP API endpointは
維持され、以後のtraffic切替は`live` Alias更新で行われます。

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

Alarm routingを初めて追加するupgradeでは、同一account/regionに異なる2つのstandard SNS topicを
先に作成し、上記policy、KMS、subscription、controlled alarm testの契約を満たします。既存環境で
monitoring stack、custom resource、または手動操作が`AlarmActions`を管理している場合は、全46 alarmの
現行actionとownerをinventory化し、必要なdestinationを新topic側へ移行してから旧reconcilerを停止します。
複数ownerが同じalarm propertyを更新する状態でdeployしません。`cdk diff`では
2つの必須parameter、相異rule、既存alarmの`AlarmActions`以外にalarm resourceの置換や
SNS resourceの新設がないことを確認し、そのtopic名を以後の通常deployでも固定して渡します。

bootstrap update は同じ key・同じ owner なら再実行できます。既存の異なる種類の row と key が衝突した場合は上書きせず stack update を失敗させるため、row を調査してから再実行します。

Webhook ACL v2 upgrade は新しい transaction writer の更新後に開始し、checkpoint に記録した30秒の drain window が終わるまで retained row の scan を開始しません。これにより、更新前に開始した API invocation が cleanup locator なしの grant を backfill cursor 通過後に書き込むことを防ぎます。

Webhook active locator v3 upgrade は API、projection、delivery の
dual-read / dual-write 対応を先に更新します。Custom resource は60秒 drain後に
primary locator を全件整合し、primary-only 境界を永続 marker で確定します。
さらに compatibility writer を60秒 drainしてから legacy GSI projection を
全件除去します。Stack update が rollback する場合は、Custom resource の
Delete が marker を rollback 状態へfenceし、active subscription のlegacy
projectionを全件復元してから旧 Lambda への依存逆順rollbackを許可します。
この逆移行に失敗した stack で custom resource をskipして
`continue-update-rollback`しないでください。

通知 upgrade では `NotificationsTable` に `RecipientStatusIndex` が追加されます。deploy 前に GSI backfill の所要時間と table throttling を確認し、deploy 後は `CollaborationProjectionDlqUrl` と `NotificationScheduleDlqUrl` の滞留、Inbox の unread count を監視してください。期限 schedule は1時間ごとに走査し、各 Work Item の canonical `schedule.calendarPolicy.timeZone` で due/overdue を評価して、同じ Work Item / due date / reason の event を決定的に重複排除します。走査が `NOTIFICATION_SCHEDULE_MAX_PAGES` の上限に達した場合も例外として非同期 retry され、最終失敗は schedule DLQ に保存されます。DLQ の visible message が1件以上になると CloudWatch alarm が `ALARM` 状態になるため、alarm と DLQ message を調査し、再実行または due-date GSI への移行を判断してください。

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
`AnalyticsScheduleFunction`は5分ごとのEventBridge ruleで起動し、同じreport occurrenceを
決定的なreceiptで重複排除します。Schedule roleはAnalyticsTableへのread/writeに加えて、
recipientのcurrent ACLとhistorical stateを評価するため、`AuditEventsTable`、
`ProjectDirectoryTable`、`WorkItemsTable`、`WorkspaceAccessTable`へのread-only権限だけを
持ちます。非同期retryを2回行った後の失敗は14日保持のencrypted
`AnalyticsScheduleDlq`へ入り、visible messageが1件以上になるとCloudWatch alarmが
`ALARM`になります。

Schedule deliveryは現在のrecipient認可を確認できない場合に送信しないfail-closed contractです。
現行delivery boundaryはimmutable snapshotとin-app receiptの保存で、artifact rendererは外部
副作用を持ちません。SESや外部email providerの権限はAnalytics Lambdaへ付与しません。Emailを
追加する場合はtransactional outboxまたはdelivery state machine、provider adapter、secret、
bounce/retry運用を別変更として導入してください。またAnalyticsのために`AuditEventsTable` streamへ
3つ目のdirect event source mappingを追加しません。

Deploy前後に次を確認します。

1. `AnalyticsTableName` outputと両Lambdaの`ANALYTICS_TABLE_NAME`が同じtableを指す。
2. Table replacement/deletionがなく、PITRとRetainが維持される。
3. `ScheduleDueIndex`のkey schemaが変更されていない。
4. API/schedule role以外にanalytics table権限が付いていない。
5. Schedule roleのsource table権限がread-onlyで、write権限がAnalyticsTableだけに限定される。
6. `AnalyticsScheduleDlqUrl`の滞留とCloudWatch alarmを監視対象に追加する。

## Rollback

code / infrastructure rollback は、原則として直前に成功したrevisionのcode/configurationを、
review済みの新しい`ApiRuntimeConfigurationRevision`とその他の同じ必須parameters
（request intake用の2 secretとalarm topic名を含む）でforward deployします。既にretainedされた
旧API configuration secretは自動では再接続されないため、同じ物理名を再作成する目的で旧revisionを
再利用しません。現行 stack に存在する retained resource を rollback template から削除しないでください。DynamoDB table は `Retain` で、PITR も有効ですが、stack から外れた resource は自動で再接続されません。Cognito custom schema は rollback しても残ります。Alarm routing導入前のtemplateへ戻すと全alarm actionが外れるため、active incident中は使用せず、applicationだけを戻すforward-fixを優先します。

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

## Scheduled isolated restore drill

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

- Function URL の edge auth は `NONE` ですが、Hono API が Cognito Bearer token の issuer / client / token use を検証します。
- Function URL、HTTP API、Hono CORS は同じ `TaskApiAllowedOrigins` に揃えます。本番で local default を使いません。
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
  `server/src/handlers/enterprise-scim-group-job-worker-handler.ts` を deploy 時に個別bundleします。旧 inline
  Lambda copy はありません。

## Commands

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun --filter cdk cdk diff CdkStack
```
