# Operational readiness

この文書は Mukuroji の SLO、incident response、migration、release、restore drill
に関する運用契約です。コードに存在する仕組みと、環境側でまだ満たす必要がある gate を
分けて記載します。環境の担当者、通知先、実行日時、AWS account/region などの可変情報は
repository に固定せず、各実行の evidence record に残します。

## 現在の実装範囲

| 領域 | 現在の状態 | Production gate |
| --- | --- | --- |
| Request correlation | `/api/*` で client header を信頼せず server が correlation/request ID を生成し、内部 route、response、CORS exposed header へ渡す | 信頼済み service 間で parent correlation を継承する認証済み protocol は未実装 |
| API log / metric | Secret-safe な JSON completion/error log と CloudWatch EMF `Mukuroji/API` を出力する | Log retention、dashboard、30日 SLO 集計を environment owner が有効化すること |
| Health | `/api/health` の liveness と、current-enabled runtime controlを先に確認してからDynamoDBを検証する `/api/ready` を分離し、readiness responseを`no-store`にする | Trusted probe と edge-level throttle を設定し、readiness の `503` を rollout 停止へ接続すること |
| Trace | CDK が管理する全28個の Node.js Lambda で X-Ray active tracing を有効にし、API log に runtime-controlled invocation ID と X-Ray root trace ID を記録する | Correlation ID 自体の X-Ray annotation は未実装 |
| Alarm | API、queue、DLQ、async destination、runtime control、restore drill の41 metric alarmと1 composite alarmを定義し、同一account/regionの必須primary/secondary SNS topicへ全alarm actionを接続する。Fast-burn component 2件はnotification無効 | SNS subscription、Incident Manager、rosterは環境側の責務。Compositeを含む通知有効な40件のtest evidenceを確認するまで unattended production とみなさないこと |
| Release | PR/push workflow が Server test を含む全 source/build config の strict typecheck、static analysis、unit/integration、Web E2E、CDK test/nag/synth を実行し、main ruleset が6つの必須 check を強制する | Path-filtered local runtime と外部 reviewer は常時 required にせず、対象変更ごとの release evidence で結果または rate limit を確認すること |
| Web journey quality | Required Playwright gate が主要 Work Item 画面の keyboard/focus、390px viewport、screen-reader-facing ARIA tree、低速 API 中の status と復帰を検証する | Chromium と mock API による回帰 proxy であり、実 screen reader、visual regression、performance budget は未実装 |
| Runtime control / rollout | AWS AppConfig の schema 検証済み `enabled` / `disabled` document を API、WebSocket、worker の entrypoint で fail-closed に評価し、operator 用 canary strategy と configuration failure alarm を定義する。Shared API は revision-bound な Lambda Version と `live` Alias で code/configuration を揃えて切り替える | `read-only` mode、route/effect registry、weighted alias routing、CodeDeploy による code canary は未実装。AppConfig の停止制御を code/schema rollout の互換性検証や writer fence の代用にしないこと |
| Data durability | Stateful DynamoDB table は `Retain` + PITR、file bucket は `Retain` + versioning を使う。6表の同一時点PITR restore、同時点exportとのexact aggregate比較、exact S3 version copy、RPO/RTO測定、90日cadence、immutable evidence、承認付きcleanupを隔離workflowで自動化する | Regional replication/failover と AWS Backup plan は未実装。成功したsame-Region drillをregional DR完了扱いにしないこと |


この表の未実装項目を、手順書が存在することだけで実装済みとして扱ってはいけません。

## Ownership と incident record

各 production environment は deploy 前に次の role を、個人名ではなく管理された roster
または team へ割り当てます。

| Role | 責任 |
| --- | --- |
| Operations on-call | Alarm の acknowledge、初動、incident record の作成、必要な role の招集 |
| Incident commander | Severity、変更停止、緩和策、status update、終結条件の決定 |
| Application owner | Correlation/log/audit の追跡、application rollback、data invariant の確認 |
| Infrastructure owner | CloudWatch、Lambda、API Gateway、SQS、CloudFormation、PITR の操作 |
| Data owner | Migration、restore、件数/checksum、tenant 境界、修復方法の承認 |
| Security owner | Credential、tenant isolation、監査、漏えいが疑われる incident の指揮 |

Incident record には最低限、次を残します。

- Incident ID、開始/検知/acknowledge/mitigation/recovery の UTC timestamp
- Environment、AWS account、region、stack、alarm construct ID、alarm ARN
- Severity、incident commander、参加 role、roster revision、通知経路
- 影響する route/workflow、最初と最後の失敗時刻、推定 request/user/tenant 数
- Secret や本文を含まない `requestId`、`correlationId`、`eventId`、job/execution ID
- 直前の deploy commit、CloudFormation stack event、migration/checkpoint ID
- 実施した query/command、承認者、結果への link、緩和/rollback の判断
- SLI の bad/total、burn rate、消費済み/残 error budget
- Data integrity の before/after evidence と follow-up owner/due date

Access token、authorization header、email/body、DLQ message 全文、DynamoDB item 全文、
secret、署名値を incident record へ貼り付けません。必要な raw evidence は access-controlled
な保存先へ置き、record には locator と digest だけを残します。

## API SLI、SLO、error budget

### Eligible request

SLI の対象は customer traffic の `/api/*` request です。`/api/health`、`/api/ready`、
CORS preflight、operator が明示した load test は除外します。

- `RequestCount`: common middleware が completion まで到達した `/api/*` request の raw 件数
- `ServerErrorCount`: raw request のうち HTTP status が `500` 以上の件数
- `Latency`: common middleware が測定した end-to-end milliseconds
- `EligibleRequestCount`、`EligibleServerErrorCount`、`EligibleLatency`: raw completion から
  health、readiness、preflightを除いた同じ単位の SLI metric
- Good request: status が `500` 未満の eligible request。認証/認可/rate-limit を含む
  意図した `4xx` は server availability の失敗に数えない
- Bad request: `500` 以上、または throttle/transport failure により middleware completion
  record を作れなかった eligible request

Raw EMF は `Service` だけを dimension とし、health/readiness/preflight も含みます。
Eligible EMF も同じ dimension とし、common middleware が exact path と method から対象可否を
判定してからpathを破棄し、logにはboundedな`sliEligible`だけを残します。30日 SLI と
fast-burn alarm は eligible metric を使い、raw EMF の集計値をそのまま分母にしません。
Production load test を client-controlled header で
除外することは禁止します。承認済みwindowをoffline reportから除外する場合もraw/eligible
telemetryを保持し、fast-burn alarmは抑制しません。

Application completion record は Function URL と HTTP API の両経路を同じ形式で数えます。
一方、Lambda throttle や integration 前の API Gateway failure は EMF completion record を
持ちません。`AWS/Lambda` の Errors/Throttles と API Gateway の `5xx` を補助 evidence とし、
同じ request を二重加算しない集計 pipeline または外形 probe ができるまでは availability
report を **provisional** と表示します。`treatMissingData=notBreaching` や traffic 0 は
成功 evidence ではなく `no-data` です。

Hono が catch して `500` response に変換した request は Lambda `Errors` を増やさないため、
Function URL と HTTP API の両経路を数える EMF `ServerErrorCount` alarm で補完します。Eligible
completionには5分・1時間の multi-window fast-burn alertがあります。Middleware到達前failureを
同じSLIへ重複なく統合する外形probeは未実装です。

### Objectives

| Objective | Rolling window | Target |
| --- | --- | --- |
| API availability | 直近30日 | `good / total >= 99.9%` |
| API latency | 直近30日 | eligible request の p95 `< 12,000 ms` |

Availability の30日 error budget は次で計算します。

```text
allowed_bad = total_eligible_requests * (1 - 0.999)
remaining_budget = allowed_bad - observed_bad_requests
burn_rate = observed_bad_ratio / 0.001
```

Request 数が少ない場合も `allowed_bad` を切り上げません。fractional budget は report 上で
保持し、1件の失敗が budget を超える可能性をそのまま示します。Latency は p95 の達成/未達に
加えて、12秒以上の request 数と最大値を evidence に残します。

### Burn response

CDK は eligible completion の bad/total を0.1% error budgetで正規化し、5分と1時間の
component alarmがともに14.4倍以上のときだけ `ApiAvailabilityFastBurnAlarm` を発火します。
Component alarmは重複pageを避けるため`ActionsEnabled=false`で、no trafficは成功へ0埋めせず
`INSUFFICIENT_DATA`にします。Composite alarmだけがSEV1を
通知します。Environment ownerは実trafficとcontrolled failureで両windowと通知経路を試験する
必要があります。Medium/slow burnと30日budget dashboardは未実装です。

| 条件 | Severity | 対応 |
| --- | --- | --- |
| 5分と1時間の両方で burn rate `>= 14.4` | SEV1 | 即時 page、deploy/migration 停止、直前変更を rollback 候補にし、5分ごとに SLI を再計算 |
| 30分と6時間の両方で burn rate `>= 6` | SEV2 | 変更停止、30分以内に owner 招集、6時間内の mitigation/rollback を決定 |
| 6時間と3日の両方で burn rate `>= 1`、または残 budget `< 25%` | SEV3 | Risky release を停止し、次の business day までに是正計画と owner を決定 |
| 残 budget `<= 0` | 最低 SEV2 | Reliability 以外の production change を停止。Incident commander と service owner の明示承認なしに再開しない |

Fast burn 中は symptom を隠すために alarm threshold や SLO 分母を変更しません。Planned
maintenance を除外する場合も、開始前に承認された期間、理由、request 数を別記録し、raw SLI
を保持します。

## Liveness と readiness

`GET /api/health` は process liveness だけを示します。

```json
{"ok":true,"status":"alive"}
```

依存先を確認せず、traffic を受けられる証明には使いません。Process restart probe は
`/api/health`、rollout と traffic admission は `/api/ready` を使います。

`GET /api/ready` は同じ API-scoped runtime control が currentかつ`enabled`かを最初に確認します。
Control が disabled/stale/unavailable の場合は DynamoDB を呼ばず、`runtime-control` check だけを
返します。Control が ready の場合だけ Work Items、Workspace Access、Audit Events の3 tableを
`DescribeTable` で検証します。各 DynamoDB call の timeout は1.5秒、結果 cache は30秒です。
Table と設定済み GSI がすべて `ACTIVE` の場合だけ成功とし、設定不足、non-active status、
timeout、AWS error のいずれも fail-closed で safe name だけを返します。

```json
{
  "ok": false,
  "status": "not-ready",
  "checks": [
    {"name":"runtime-control","ready":false}
  ]
}
```

Control が ready で dependency が失敗した場合は3つのtable checkと
`{"name":"runtime-control","ready":true}`を返します。全 check が成功したときだけ `200`、
それ以外は `503` です。Physical table name や AWS error は response に出しません。
`200`/`503`のどちらにも`Cache-Control: private, no-store`と`Pragma: no-cache`を付与します。
Readiness `503` が2回連続した rollout は停止し、5分継続または複数 AZ/client で再現した場合は
SEV2、全 request が失敗する場合は SEV1 へ上げます。

DynamoDB probe の30秒 cache と同一 runtime 内の request coalescing は control-plane call を
抑えますが、scale-out をまたぐ abuse 防止にはなりません。Runtime control の
required-minimum/provider-directed poll と60秒のstaleness契約は後述します。Production では
API edge/WAF で `/api/ready` を trusted monitor に制限するか専用 rate limit を設定し、その
制御を確認するまで public traffic へ無制限に公開しません。

## Correlation と structured evidence

Common middleware は `/api/*` に対し、client が送った `X-Correlation-Id` と
`X-Request-Id` を canonical identifier として採用しません。API boundary で UUID を2つ生成し、
server 内の downstream request header と response の `X-Correlation-Id` /
`X-Request-Id` に設定します。信頼済み service 間の parent correlation を将来導入する場合は、
client header と別 field にし、認証済み ingress だけから受け取ります。

Completion log `api.request.completed` は次を含みます。

- `correlationId`、`requestId`、bounded `method`
- ID/query を除いた `/api/<area>` 形式の `routeGroup`
- exact pathを含まないboundedな`sliEligible`
- Lambda runtime が供給した `invocationId` と X-Ray `traceId`（利用可能な場合）
- `status`、`durationMs`
- EMF namespace `Mukuroji/API`、dimension `Service=mukuroji-api`
- `RequestCount`、`Latency`、`ServerErrorCount`
- eligible requestだけに `EligibleRequestCount`、`EligibleLatency`、
  `EligibleServerErrorCount`

Unexpected error log `api.request.failed` は `errorType` までを含め、exception message と stack
trace を含めません。Request/response body、query value、authorization、entity ID はどちらの
log にも記録しません。

Readiness dependency の予期しない失敗は `readiness.dependency.failed` として、同じ
server-generated `correlationId`、stable な `dependency` category、bounded `errorType` だけを
記録します。Physical table name、exception message、stack trace、client 指定 correlation ID は
記録しません。

API incident の最初の query は対象 Lambda log group と alarm window を固定して実行します。

```text
fields @timestamp, event, correlationId, requestId, invocationId, traceId,
       method, routeGroup, dependency, status, durationMs, errorType
| filter event = "api.request.completed"
      or event = "api.request.failed"
      or event = "readiness.dependency.failed"
| filter status >= 500
      or event = "api.request.failed"
      or event = "readiness.dependency.failed"
| sort @timestamp desc
```

取得した `correlationId` で、同じ許可済み log group と audit timeline を絞ります。Audit event
には `eventId`、`directoryId`、actor/entity/target、`correlationId`、source request ID が
保存されますが、correlation ID の GSI はありません。次の制約を守ります。

1. DLQ/worker event から `directoryId` と `eventId` が分かる場合は、その exact key または
   Workspace/actor/entity/target index を使う。
2. User/tenant が先に分かる場合は、認可済み audit API/timeline で時刻と correlation ID を
   照合する。
3. Correlation ID しかない場合、routine investigation で AuditEvents table を全 scan
   しない。Application owner が authorized tenant/entity locator を取得する。
4. Read-only request や integration 前 failure は audit event を作らないため、user/tenant を
   必ず解決できるとは限らない。この場合は「unknown」と記録する。

X-Ray は全 Lambda で active です。API log の `traceId` は sampled trace が保存されている場合の
exact lookup に使い、保存されていない場合は `invocationId` と UTC window から Lambda log を
起点に調査します。Correlation/request ID 自体を X-Ray annotation として登録していないため、
correlation ID だけで X-Ray trace を一意検索できるとは記載しません。

## Severity、acknowledge、escalation

| Severity | 例 | Ack target | Escalation / update |
| --- | --- | --- | --- |
| SEV1 | 全 API unavailable、fast burn、復元不能な data loss/tenant isolation/security、failure destination が失敗し event 喪失の可能性 | 5分 | 10分で incident commander/application/infrastructure owner、security/data 該当時は同時招集。15分ごとに update |
| SEV2 | 一部 route unavailable、readiness 継続失敗、DLQ 滞留、medium burn、queue age 15分超 | 15分 | 30分で application/infrastructure owner。30分ごとに update |
| SEV3 | Slow burn、単発 latency regression、冗長性を失ったが user impact 未確認 | 4 business hours | 次の business day までに owner/due date、daily update |

Ack は通知 UI のボタンだけでなく、incident record に on-call、時刻、調査開始 window を記録して
完了です。Target を超えた場合、通知先 roster の secondary、incident commander、service owner
の順に escalation します。Roster や secondary が設定されていない environment は production
gate を満たしません。ここでのsecondaryはsubscription先のack-aware on-call systemが管理する
escalation targetであり、CloudWatch `AlarmActions`の配列順ではありません。

## Alarm catalog と追跡開始点

Alarm 名は CloudFormation の physical name ではなく CDK construct ID です。Fast-burn component
以外のalarmはmissing dataを`notBreaching`とし、componentは`missing`のまま扱います。いずれも
`OK`とtelemetryが存在することを別々に確認します。

| Alarm | 条件 | Default | 最初に保存する locator |
| --- | --- | --- | --- |
| `ApiFunctionErrorAlarm` | Lambda `Errors Sum >= 1` / 5分 | SEV2 | Lambda function、UTC window、invocation failure。Hono error log があれば request/correlation ID |
| `ApiFunctionThrottleAlarm` | Lambda `Throttles Sum >= 1` / 5分 | SEV2 | Function concurrency、UTC window、transport metric。Middleware 未到達 request は request/user/tenant が unknown |
| `ApiFunctionLatencyAlarm` | Lambda duration p95 `>= 12,000 ms`、5分 period の2/3 | SEV2 | `api.request.completed` の `durationMs`、request/correlation ID、route group |
| `ApiApplicationServerErrorAlarm` | `Mukuroji/API` `ServerErrorCount Sum >= 1` / 5分 | SEV2 | Function URL / HTTP API の completion log、trusted request/correlation ID、route group |
| `ApiAvailabilityFastBurnFiveMinuteAlarm` | eligible error ratio `>= 0.0144`（burn rate 14.4）/ 5分 | component、notification無効 | 5分windowのeligible bad/totalとcompletion log |
| `ApiAvailabilityFastBurnOneHourAlarm` | eligible error ratio `>= 0.0144`（burn rate 14.4）/ 1時間 | component、notification無効 | 1時間windowのeligible bad/totalとcompletion log |
| `ApiAvailabilityFastBurnAlarm` | 5分・1時間componentが同時に`ALARM` | SEV1 | 両componentのstate history、eligible bad/total、直前deploy/migration |
| `ApiGatewayServerErrorAlarm` | HTTP API `5xx Sum >= 1` / 5分 | SEV2 | Stage/integration、UTC window。Lambda 到達時は API log、到達前 failure は correlation が unknown |
| `RuntimeControlConfigurationFailureAlarm` | target固有`ControlId`の`ConfigurationFailureCount Sum >= 1` / 5分 | SEV2 | `runtime-control.evaluated` の ControlId、surface、status、revision、deployment number。Configuration 本文は記録しない |
| `CollaborationProjectionDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Audit stream record の directory/event ID、correlation、actor/entity/target |
| `AutomationEventDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Audit outbox stream record の directory/event ID と automation rule/execution locator |
| `AutomationScheduleDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Async destination envelope の invocation time、recurring definition/execution locator |
| `ConnectorSyncDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Queue body の installation/job/operation ID。Credential/body は記録しない |
| `ConnectorPollDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | EventBridge または Lambda destination envelope、installation/poll locator |
| `ConnectorSyncQueueAgeAlarm` | Oldest message `> 900 s` / 5分 | SEV2 | Oldest message sent timestamp、installation/job ID、queue depth |
| `EnterpriseScimGroupJobDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Enterprise stream record の workspace/control revision/group-job locator |
| `EnterpriseIdentityMaintenanceDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Enterprise `CONTROL` stream record の workspace/state generation/revision |
| `RequestEmailIngestionDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Async envelope の request/thread locator。Email address/body/signature は記録しない |
| `RequestEmailIngestionDestinationFailureAlarm` | `DestinationDeliveryFailures Sum >= 1` / 5分 | SEV1 | Lambda invocation/time/error。DLQ delivery 自体が失敗したため message が存在すると仮定しない |
| `AnalyticsScheduleDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Schedule occurrence、report/snapshot/delivery receipt locator |
| `AnalyticsScheduleDestinationFailureAlarm` | `DestinationDeliveryFailures Sum >= 1` / 5分 | SEV1 | Lambda invocation/time/error。失敗 event の durable copy を確認 |
| `NotificationScheduleDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Schedule occurrence と Work Item/notification event locator |
| `NotificationScheduleDestinationFailureAlarm` | `DestinationDeliveryFailures Sum >= 1` / 5分 | SEV1 | Lambda invocation/time/error。失敗 event の durable copy を確認 |
| `WebhookDeliveryDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Delivery/subscription/event ID と attempt。URL、header、secret は記録しない |
| `WorkItemImportDlqAlarm` | DLQ visible message `>= 1` / 5分 | SEV2 | Import job、source object version、row checkpoint/receipt locator |

DLQ alarm の共通初動は次です。

1. Queue ARN/URL、message ID、sent/receive timestamp、receive count を記録する。Message を
   delete/redrive しない。
2. Body は controlled viewer で確認し、上表の opaque locator だけを incident record へ転記する。
3. Stream record は `directoryId` / `eventId`、application queue は job/execution/delivery ID から
   system of record を read-only で確認する。
4. Audit event がある場合は correlation、source request、actor、entity/target を照合し、
   tenant/user impact を確定する。存在しない schedule/poll は実行時刻と対象 inventory を使う。
5. 原因を修正し idempotency/checkpoint を確認してから、data owner/application owner が
   redrive または新規 job を承認する。Terminal job を盲目的に再送しない。
6. Queue が空、system of record が期待状態、重複 side effect がないことを確認して閉じる。

CDK deploy は、異なる既存standard SNS topic名を `AlarmPrimaryTopicName` と
`AlarmSecondaryTopicName` に必須指定し、同一account/regionのARNへ変換して全42 alarmの
`AlarmActions`へ設定します。Stackはtopic、subscription、Incident Manager、rosterを所有しません。
Fast-burn component 2件は`ActionsEnabled=false`で、残る39 metric alarmと1 composite alarmの
遷移が両topicへ同時通知されます。Ack target未達時の段階escalationはsubscription先が管理します。
Topic policyは`cloudwatch.amazonaws.com`の`sns:Publish`を同一account/regionのalarm ARNと
SourceAccountで制限して許可します。SSEを使う場合はcustomer-managed KMS keyにも同principalの
`kms:GenerateDataKey*`/`kms:Decrypt`と同じconfused-deputy条件を設定します。Operatorによる直接
SNS publishだけをdelivery evidenceにせず、controlled CloudWatch alarmの実state transition、
alarm history、両subscription receipt、OK復帰まで確認します。
全42 alarmのARN、primary/secondary destination、subscription/roster revision、通知有効な40件の
test notificationとfast-burn両component/compositeのstate history、UTC timestamp、受信者を
environment evidenceに残すまで、上記ack targetは実効性を持ちません。

## Deploy と rollback

### Pre-deploy gate

1. Deploy commit OID、build artifact digest、target account/region/stack/parameters を固定する。
2. GitHub の `static-analysis`、`strict-typecheck`、`application-unit-tests`、`web-e2e`、
   `cdk-security`、`dependency-review` と、repository review policy をすべて成功させる。
3. `cdk diff` / synth を保存し、stateful resource replacement/deletion、IAM拡大、PITR/Retain
   の解除がないことを確認する。
4. `ApiRuntimeConfigurationRevision`はAPI code、または4分割runtime configuration secretへ
   入るparameter/resource値を変更するdeployごとに新しい値へ進め、diffとdeployで同じ値を使う。
   同じrevisionを異なる内容へ再利用しない。
5. Schema/API は backward-compatible にする。
6. Error budget が残り、active SEV1/SEV2 がなく、on-call と alarm destination の test が成功
   していることを確認する。
7. 直前の成功code/configurationを新しい`ApiRuntimeConfigurationRevision`でforward deployする
   rollback commandと、Function URL consumerの切替手順をreviewする。
8. Webhook locator bridgeを削除するdeployでは、対象account/region/table identityを固定して
   旧workerが動作している間に`CollaborationProjectionFunction`のDynamoDB stream event-source mapping
   UUIDをchange recordへ固定して、そのmappingだけをdisabledにする。AppConfigでproducerとconsumerを同時に
   止めず、現行`WebhookDeliveryFunction`のSQS mappingはenabledのままproducer invocationの完了を待ち、
   `WebhookDeliveryQueueUrl`をdrainする。Main queueと`WebhookDeliveryDlqUrl`の全message payloadを対象に
   cursor version/phaseを検査し、v1 `primary` / `legacy` cursorを含むmessageを1件でも検出した場合は
   rolloutを停止する。Consumerのdrain完了後はvisible、in-flight、delayed messageがすべて0で、oldest ageも
   解消したことを連続確認し、queue/DLQごとの検査件数、v1検出件数、0-stateの時刻とmetricをchange recordへ
   保存する。Raw payloadやcursor自体はevidenceへ複製せず、検出itemはrestricted locatorとkeyed digestで
   追跡する。Developer Platformのdurable projection receiptである全`webhook-projection-state` rowも検査し、
   `nextCursor`をcanonical Base64url JSONとして復号した値がv1 `primary` / `legacy` phaseであるrowが1件でも
   残る場合はrolloutを停止する。Receiptの検査件数、v1検出件数、table identity、完了時刻を同じchange
   recordへ保存する。新workerはv1 cursorを`DeveloperCursorInvalid`として拒否し、後続subscription pageを
   配信できない。このdeployはqueue messageやprojection receiptを変換しないため、残存時は別のreview済み
   drain/repairまたは環境再作成後に再検査する。
   Deployとcurrent cursor smokeの成功後に同じproducer mappingをDynamoDB Streams retention内で再開し、
   iterator age、projection DLQ、Webhook queue/DLQが通常値へ戻ることを確認する。
   Developer Platformの全`webhook-subscription` rowを検査し、retiredな`lookupKey` / `lookupSortKey`、
   `WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3` / `STATE`、またはWebhook active-locator rollback
   checkpointが1件でも残る場合はrolloutを停止する。Project Directoryの全active `team` / `project` /
   `project-member` source rowも検査し、expectedな`webhookAuthorizationKey` /
   `webhookAuthorizationSortKey`、またはactive Team/Project/member関係に対応するcanonical
   `webhook-team-grant` rowと`webhook-team-grant-cleanup` locatorが1件でも不足する場合はrolloutを停止する。
   残存rowがあるとsubscription更新、secret rotation、active subscription取得が
   `DeveloperPlatformDataInvalid` (503) でfail-closedになる。不足したauthorization projection/grantは
   authorizationをdenyし、該当resourceのWebhook deliveryを抑止する。このbridge削除deployはone-time
   cleanupを実行せず、Project Directory authorization backfillも実行しないため、残存dataや不足projectionは
   別のreview済みcleanup計画で解消してから再検査する。

`main quality gates` ruleset は上記6 context を strict mode で required にします。Workflow の
job/context 名を変更する場合は ruleset も同じ release で更新し、対象 branch の effective rules
を確認します。Path-filtered `local-runtime` と外部 CodeRabbit review は常時実行されないため
branch-wide required context にはせず、対象変更ごとの release evidence に結果または rate limit
を記録します。

### Dynamic runtime control

CDK は retained な AWS AppConfig application、production environment、hosted configuration
profile、JSON Schema validator、configuration failure alarm、alarm monitor role/policy、
operator 用 canary deployment strategy を作成します。初回stack作成ではread-only custom resourceが
`DescribeAlarms`だけを使い、alarmが自然に`OK`へ評価され`ActionsEnabled=true`になるまで
AppConfig environment作成を待ちます。`SetAlarmState`で初期状態を偽装しません。Stack output の
`RuntimeControlApplicationId`、`RuntimeControlEnvironmentId`、
`RuntimeControlConfigurationProfileId`、
`RuntimeControlCanaryDeploymentStrategyId` は stack/account/region と結び付けて change
evidence に保存し、別 stack や手入力の名前から ID を推測しません。Configuration は secret を
含まない次の strict schema だけを受け付けます。

Retained hosted configurationのCDK管理baselineはversion labelを付けない
`mode=disabled`、`revision=1`です。Rollback後の再deployでもretained version labelと衝突しません。
Controlled Lambda 21個はこのall-at-once deploymentの完了へ依存し、初回作成では
application処理をfail-closedに保ちます。Stack deployだけでbaselineは自動で`enabled`へ戻りません。
Application処理の再開は、operatorが監査sequenceを増やした新しい`enabled` hosted versionを
review済みcanary strategyでdeployする別操作です。

Shared APIのruntime configurationは4つのSecrets Manager secretへ分割し、Lambda environmentには
そのARNだけを設定します。Secret名には必須parameter `ApiRuntimeConfigurationRevision`を含め、
各groupはtransform-freeなv2 line envelopeとしてfixed group identity、同一revision、canonical Base64の
direct valueまたはnested Secret ARNを保持します。NoEcho parameterの4値はprocessed templateへ展開せず、
revision-boundな個別retained secretの`SecretString`へ直接`Ref`します。既存のDocument public-share
secretを含む5つのnested secretもAPI roleへ限定して読みます。Cold start loaderは4 groupのidentityと
revision一致、全canonical key、nested ARN/valueを完全検証した後だけ環境へ原子的に反映します。
API code、またはsecretへ入るparameter/resource値を変えるdeployではrevisionを必ず進めます。旧secretは`Retain`されますが、CloudFormation rollbackが
自動で再接続・削除するものではないため、evidence inventoryと明示的なretirement判断を必要とします。

初回導入では物理Lambdaを末尾`-api-v2`へ一度だけ置換します。Lambda Function URLと後方互換outputは
変わるためconsumer cutoverをchange planに含めます。HTTP API endpointは維持され、default routeが
新しい`live` Aliasへ切り替わります。以後はconfiguration secretとLambda Versionを準備してから
Aliasを更新し、HTTP API trafficをcode/configurationの揃ったversionへ切り替えます。
Function URLもAliasに紐づきますが、初回の物理function置換によるURL変更はAliasでは吸収できません。

```json
{
  "schemaVersion": 1,
  "mode": "disabled",
  "revision": 2
}
```

`schemaVersion` は `1`、`mode` は `enabled` または `disabled`、`revision` は1以上の整数です。
追加 property は validator が拒否します。Revision はoperator evidenceの監査sequenceであり、
runtimeのdurable fenceではありません。通常変更ではdeploymentごとに増加させ、同じrevisionの
異なる内容を再利用しませんが、AppConfigが配布したvalidなrollback documentはrevisionの大小に
かかわらずauthoritativeです。現行 document は global control であり、surfaceごとの mode、
maintenance `read-only`、mutation を列挙する route/effect registry は未実装です。

Control は API Lambda、WebSocket Lambda と、Audit projection の outer fan-out、Automation
event/schedule、Connector sync/poll、Enterprise SCIM group/identity maintenance、
Analytics/Notification schedule、Request Intake email、Webhook delivery、Work Item import の
entrypoint で domain operation / side effect より前に評価します。Audit fan-out の composition
自体も outer guard の後まで遅延し、内部の Connector projection は同じ判断を重複させません。
Runtime-control alarm readinessの2 function、CDK/CloudFormation Provider function、
repository の operator script は、`disabled` でも停止しません。

`/api/health` と CORS preflight は control-plane 障害時にも liveness/transport を観測できるよう
guard を通しません。`/api/ready` は通常 API より厳しく、bounded-stale な `enabled` snapshot
でも `503 not-ready` とし、controlがreadyでなければDynamoDB probeを開始しません。
Readiness responseは常に`private, no-store`です。それ以外の `/api/*` は current または60秒以内の
stale `enabled` だけを許可し、blocked 時は authentication、rejection audit、route処理より前に
secret-free な `503 application/problem+json` と `Retry-After: 15` を返します。Worker は同じ
状態で固定された `RuntimeControlBlockedError` をthrowし、各event sourceの既存retry契約へ
戻します。WebSocket Lambdaもintegration failureを返しますが、API GatewayはLambda invocationを
durable retryしません。既存connectionは強制切断されず、blocked中の`$disconnect` cleanupは
実行されない場合があるため、logical expiryとDynamoDB TTLに委ねます。

通常の operator update は次の順序で行います。

1. Change/incident record に stack、account、region、4つの output、現在の document/revision、
   変更理由、owner、想定時間、re-enable 条件、worker replay owner を保存する。
2. 上記 schema の JSON を access-controlled な作業領域に作り、revision と mode を別の reviewer
   が確認する。Document に credential、tenant ID、URL、自由記述の incident detail を入れない。
3. Stackが所有する`RuntimeControlConfigurationFailureAlarm`のphysical nameを取得し、
   `describe-alarms`の結果がexact 1件、`StateValue=OK`かつ`ActionsEnabled=true`であることを
   deployment直前に確認する。Missing dataを`notBreaching`として得た`OK`だけではruntimeが
   candidateを取得した証拠にならないため、stateとtelemetryを別々に保存する。

   ```sh
   aws cloudwatch describe-alarms \
     --alarm-names 'PHYSICAL_ALARM_NAME_FROM_TARGET_STACK'
   ```

   初回stack作成ではalarm readiness custom resourceが同じ条件を最大15分待ちます。
   `INSUFFICIENT_DATA`から自然な`OK`へのstate history、actions有効、custom resource成功を
   bootstrap evidenceとして保存します。
4. Hosted configuration version を作成し、返された `VersionNumber` を記録する。

   ```sh
   aws appconfig create-hosted-configuration-version \
     --application-id 'APPLICATION_ID_FROM_STACK_OUTPUT' \
     --configuration-profile-id 'PROFILE_ID_FROM_STACK_OUTPUT' \
     --content-type 'application/json' \
     --content 'fileb://runtime-control.json'
   ```

5. 通常変更は stack output の canary strategy で deployment を開始し、返された
   `DeploymentNumber` を記録する。

   ```sh
   aws appconfig start-deployment \
     --application-id 'APPLICATION_ID_FROM_STACK_OUTPUT' \
     --environment-id 'ENVIRONMENT_ID_FROM_STACK_OUTPUT' \
     --configuration-profile-id 'PROFILE_ID_FROM_STACK_OUTPUT' \
     --configuration-version 'HOSTED_VERSION_NUMBER' \
     --deployment-strategy-id 'CANARY_STRATEGY_ID_FROM_STACK_OUTPUT'
   ```

6. 20分のexponential rolloutと10分のbakeの各phaseでtrusted `/api/ready`と承認済みの
   representative trafficを発生させ、対象revisionとtarget由来`ControlId`を持つfresh
   `runtime-control.evaluated` recordをcritical surfaceごとに確認する。`get-deployment`で
   `COMPLETE`/`ROLLED_BACK`、alarm state、開始/終了UTCも保存する。Alarmが`OK`でも対象revisionの
   fresh recordがない、`ActionsEnabled=false`、deploymentが`BAKING`から進まない、または
   想定外のsurfaceだけが動く場合は成功扱いにしない。
7. Incident commander が即時停止を必要と判断した場合だけ、canary strategy の代わりに
   `AppConfig.AllAtOnce` を明示して emergency deployment を行う。段階配布を省略した理由と
   blast radius を record に残し、同じ post-check を省略しない。
8. Recoveryは監査上、通常は`mode: "enabled"`とさらに大きいrevisionの新規hosted versionを
   作成してdeployする。ただしruntimeはrevision fenceを持たず、AppConfigが配布したvalidな
   既存versionへのrollbackもauthoritativeとして受理する。Trafficとworkerを一度に戻せない場合、
   このglobal controlで段階化できると仮定せず、event source/rule側の明示的な制御計画を用意する。

各 runtime は有効な snapshot を cache し、AppConfig session に15秒を required minimum として
要求します。実際の次回確認は `GetLatestConfiguration` が返す `NextPollInterval` と15秒の
遅い方で行い、provider 指示を無視して早く token を再利用しません。最後に取得した `enabled`
snapshot は取得時刻から最大60秒だけ last-known-good として利用でき、それを超えてAppConfigを
更新できない新規 invocation は fail-closed です。Cold start の設定不足、scope不一致、
schema不正、取得失敗にも同じく domain operation / side effect を開始せず、固定された安全な
失敗を返します。新しいsessionの開始と最初のpollは各3秒、warm sessionのpollは各1.5秒で
client timeoutし、失敗時はone-use tokenを再利用せず次回に新しいsessionを開始します。
Valid な `disabled` version が runtime へ配布された後は次の
provider-approved poll で新規処理を拒否します。ただし canary deployment の20分 rollout と
10分 bake はこの runtime-side interval の前段にあります。したがって absolute propagation
bound は deployment strategy、provider が返した interval、最大60秒のstalenessをすべて含め、
deployment 開始から全 runtime 停止までが15秒とは記録しません。

各 blocked/stale/invalid/unavailable 評価は secret-free な `runtime-control.evaluated` EMF
record として必ず記録します。Current-enabled の allowed 評価はwarm runtime・surface・revision
ごとに最大60秒間隔のheartbeatとして記録し、定常trafficに比例したlog取り込みを避けます。
Recordはbounded な `surface`、`outcome`、`mode`、`status`、revision/ageを持ちます。
`ControlId`はruntimeがpollするのと同じ
AppConfig application IDとconfiguration profile IDから決定的に構成し、alarmも同じdimension
だけを監視します。これにより別stackや同名stack再作成の直近metricを混在させません。
`BlockedCount`、`DisabledCount`、`StaleCount`、`ProviderFailureCount`は停止とprovider劣化の
調査に使い、`ConfigurationFailureCount`はruntime parserが拒否したinvalid documentだけを
数えます。Revisionはrecordへ残す監査metadataであり、valid provider payloadの採用可否を
process-local比較で決めません。Document本文やprovider error messageはlog、metric、alarm
evidenceに含めません。Hosted profileのJSON Schemaは通常invalid versionをdeployment前に
拒否するため、このalarmはdefense-in-depthです。Missing metricを`OK`扱いするalarmだけで
candidate取得成功を証明せず、前述のfresh evaluation evidenceを必須にします。

Guard はすでに開始した invocation を中断しません。したがって最後の `enabled` admission 後に
side effect が継続する時間は handler の残り実行時間で決まり、構成上の hard upper bound は
Lambda timeout の最大15分です。停止確認では deployment state だけでなく、少なくとも
「最後の version 配布 + provider 指示の poll interval + 60秒 + 対象 Lambda の timeout」を
越えた観測 window で mutation、queue drain、stream checkpoint、outbound delivery が
増えていないことを確認します。

`disabled` は EventBridge rule、DynamoDB stream mapping、SQS mapping、API Gateway 自体を
無効化しません。拒否されたworker invocationはsourceごとの既存policyに従ってretryされ、
SQS workerは最大receive count到達後、stream workerはretry/bisect exhaustion後、
asynchronous schedule/emailは2回のretry後にfailure destination/DLQへ移ります。WebSocket
integrationにはこのdurable retry契約がなく、client reconnectとsession expiryを別に確認します。
長時間の停止ではretry budgetとsource retentionを先に評価し、DLQ alarmを抑制しません。

SQS event source の現在の停止budgetは次のとおりです。値は連続して失敗し、各receive後に
visibility timeoutを使い切る場合の`maxReceiveCount × visibility timeout`であり、無期限の
kill switchを安全に吸収する保証ではありません。想定停止がbudgetへ近づく場合は、先に
DLQ流入とredrive計画をincident recordへ固定します。

| Surface | maxReceiveCount | Visibility timeout | Nominal budget | DLQ alarm |
| --- | ---: | ---: | ---: | --- |
| `webhook-delivery` | 5 | 3分 | 15分 | `WebhookDeliveryDlqAlarm` |
| `connector-sync` | 5 | 30分 | 2時間30分 | `ConnectorSyncDlqAlarm` |
| `work-item-import` | 5 | 90分 | 7時間30分 | `WorkItemImportDlqAlarm` |

Re-enable後はsystem of record、idempotency key、checkpoint、partial-batch semanticsを確認し、
上記「DLQ alarm の共通初動」に従ってowner承認後にredriveします。停止中のmessageを一括
deleteしたり、terminal jobを盲目的にredriveしたりしません。

### Public API contract trust root

Public API compatibility gate は、権限を持たない `pull_request` signal の完了後に default
branch の `.github/workflows/public-api-contract.yml` を `workflow_run` で実行します。Signal
workflow、trusted workflow、comparator の3ファイルを trust root とし、候補側の blob OID が
base と一致しない変更は専用 rotation 以外では拒否します。Pull request 側の checkout は
OpenAPI source、canonical snapshot、3つの trust-root file を data として読むだけにし、依存
install、artifact/cache download、候補側 code の実行を行いません。
初回導入は comparator/workflows だけを先に merge します。次に default branch の trusted
`workflow_run` だけが利用できる `public-api-contract-publisher` protected environment と専用
check publisher GitHub App を設定し、その後の pull request で canonical snapshot を
bootstrap します。Environment は `main` だけを許可し、deployment object を作らず、App には
対象 repository の Checks write だけを付与します。実 workflow が候補 commit で専用 App check
を成功させたことを確認してから、ruleset は同名の GitHub Actions job ではなく、専用 App の
integration ID に固定した `public-api-compatibility` check を strict required check として
要求します。Bootstrap、publisher、environment、ruleset 更新がすべて終わるまでは Public API
compatibility gate を有効化済みと記録しません。

Trust root の candidate OID は base と一致しない限り失敗します。Comparator または workflow
を更新するときは、通常の feature/API 変更と同じ pull request に含めず、次の管理者手順を
使います。

1. Merge を一時停止し、OpenAPI source と canonical snapshot の blob OID が変わらない
   trust-root 専用 pull request を作る。
2. Base/merge-base/head OID、comparator test、workflow simulation、多観点 review の evidence
   を固定し、他の required checks をすべて成功させる。
3. Ruleset と protected environment の before JSON を保存し、専用 App に固定した Public API
   context だけを一時的に required list から外す。Bypass actor と別 publisher は追加しない。
4. 専用 pull request だけを merge し、新しい main を base にした trust-root probe pull
   request で更新後 workflow の成功と候補 commit SHA を確認する。
5. 同じ context を専用 App の integration ID 固定で直ちに required list へ戻し、effective
   rules、protected environment、after JSON を保存してから merge 停止を解除する。失敗時は
   旧 trust root へ戻し、context を外した状態で通常変更を merge しない。

Shared APIには`live` Aliasによるversion単位のatomic cutoverがありますが、weighted routing/
CodeDeployによるcode canaryはありません。AppConfig の
global `enabled` / `disabled` control は code/schema compatibility の段階 rollout ではないため、
production では先に別 environment で同一 artifact を検証し、変更 window 中に一つの stack を
更新して以下の post-deploy check を行います。安全に段階化できない高リスク変更は deploy しません。

### Post-deploy check

1. CloudFormation が `UPDATE_COMPLETE` で、unexpected replacement がない。
2. `/api/health` が `200 alive`、`/api/ready` が全 check `ready` を返す。
3. Function URL と HTTP API の認証済み read、代表 mutation/read-after-write が成功する。
4. Response の request/correlation ID と JSON completion log が一致し、EMF metric が到着する。
5. API alarm、DLQ、queue age、destination failure が `OK` で、telemetry に no-data がない。
6. Migration marker/checkpoint/integrity check が成功し、新旧 client の contract test が通る。

### Rollback trigger と手順

Fast burn、全体 readiness failure、tenant/data invariant failure、migration verify failure、
failure destination error、security regression のいずれかは自動継続せず rollback/forward-fix
判断を要求します。

1. Incident を宣言し、新しい deploy/migration/write を停止する。
2. 直前 commit、stack event、alarm、request/event locator、data evidence を固定する。
3. Data migration がある場合は、その migration contract に従って writer を止めたまま
   rollback する。Webhook locator bridge削除にはcustom resourceによる逆移行がない。残存v1 cursor、
   retired locator/state、不足authorization projection/grant/cleanup locatorなどのdata residueを検出した
   場合はone-time cleanupやcode-only forward-fixを行わず、producer/writeを停止したまま別のreview済み
   repairまたは環境再作成後にpre-deploy gateを再実行する。Retired locator/stateでは503 fail-closed、
   不足authorization dataではdelivery suppressionがrepair完了まで継続する。Pre-deploy gateが成功し、
   canonical dataにresidueがないことを固定済みのcode/infrastructure failureだけを、dataを変更しない
   review済みcode forward-fixの対象とする。
4. Schema-compatible な code/infrastructure は直前の成功code/configurationを、新しい
   `ApiRuntimeConfigurationRevision`とその他の同じ必須parameterでforward deployする。
   Retained secretの物理名を再作成するために旧revisionを再利用せず、retained resourceを
   templateから外さない。
5. 新 resource/schema を旧 revision が理解しない場合は、resource を保持した forward-fix で
   application code だけを戻す。Stack delete で復旧しない。
6. CloudFormation `UPDATE_ROLLBACK_FAILED` は resource/data conflict を調査し、custom resource
   を skip せずに復旧する。
7. Health/readiness、両 transport、data integrity、DLQ、SLI を再検証してから traffic/write を
   再開する。

Commit、parameter、stack event、開始/終了時刻、RTO、post-check、残差 data の reconciliation を
rollback evidence に残します。

## PITR restore drill

同一 region の DynamoDB について、目標は `RPO <= 5分`、incident declaration から検証済み
recovery table まで `RTO <= 4時間` です。これは運用目標であり、drill evidence がなければ
達成済みとみなしません。

DynamoDB、Configuration、Relation Graph、Audit、Workspace Access、File Proofing metadata、
exact S3 version の横断検査契約と非対象は
[Cross-domain data integrity](./data-integrity.md) を参照してください。Standalone checkerはsource/
restore共通のfull-result contractを持ちます。自動drillは同じnormalizer/invariantをdurable opaque-claim
adapter経由で隔離restoreへ適用し、sourceとのexact row比較は同時点export aggregateで行います。
Incomplete/fail statusはrestore、migration、deployのterminal successとして受理しません。

通常runは [Isolated restore drill](./restore-drill.md) の契約に従います。Daily due scannerは直近の
成功済みverificationから89日で次runをadmitし、90日でoverdue alarmを発火します。1回のrunで
Work Items、Work Item Configuration、Project Directory、Workspace Access、Audit Events、
File Proofingの6表を同じrestore pointへ復元し、同時点のDynamoDB exportをexact baselineにします。
稼働中sourceのlive Scanをhistorical restoreとの完全比較に使いません。Active runが4時間の
deadlineを超えた場合は、Step Functions status eventが欠落していても次のdaily scannerがrun revisionと
runner execution ARNをCAS更新してownerを引き継ぎ、stale executionを拒否してfailure evidenceを
sealします。

File Proofing snapshotが参照するexact S3 versionはapplicationから見えないKMS暗号化済みscratch
bucketへcopyします。Copy retry/応答消失で生じた全destination VersionIdをcleanup scopeへ記録し、
決定的に選んだ1件だけを検証して隔離済みFile Proofing rowへ反映します。Production upload policyと
同じ2 GiBまで、source/destinationをexact VersionId付きの最大16 MiB Rangeで独立streamし、range
SHA-256、Content-Range/Length/total、ordered HMAC chainをinvocationごとに検証・checkpointします。

Export data file、restore Scan page、File proof page/range、cross-domain normalized page/opaque semantic
claimをincrementalに処理します。Current verifier limitsは1表あたりexport-object listing 10 page/
10,000 object、export data file 256、1 export file 100,000 rowかつuncompressed 1 GiB、
1表1,000,000 rowか10,000 restore page、File version 10,000です。
Semantic stageはAudit pseudonym Secretのexact VersionIdを先にpinし、6表全体でraw page 10,000、
retained opaque unit 1,000,000、1 normalized pageあたりclaim 150,000を上限にします。このclaim上限は
DynamoDBの物理1 MiB page、canonical pending File versionの最小95 item byte、1 versionあたり最大13 claim、
pageあたり最大4件のstable external File failureから得る最大143,485件を切り上げた値です。1 logical Scan stepは
raw rowを最大25件、requirement/Audit reducerは1 logical stepあたりdurable recordを最大100件処理し、
Audit current-resource判定はScan page順に依存せず最新eventをreduceします。Eligibleなpage-like stageは
1 Lambda invocationで最大50 logical stepをbatchしますが、8分のelapsed-time guardでもbatchを終了して
durable checkpointから再駆動します。
上限到達や追加page/claimの存在を成功に切り詰めず、failed evidence、alarm、remediationへ進めます。
Failure finalizerはこれらのverification limitとは独立して全created resourceをinventoryし、cleanup
approval scopeを部分集合にしません。

これらの件数/page上限はfail-closedなlogical ceilingであり、全上限を同時に満たすdatasetが1 runで
RTO内に完了することを保証しません。Main loopの`pending`は0秒のlocal-state redriveも含めてexecution
全体で数え、1,200 poll-loop iterationのfuse到達後も継続が必要ならpartial successにはせずfailure
finalizerへ移ります。専用finalizerは非integrityのstable code
`WORKFLOW_POLL_BUDGET_EXCEEDED`を記録します。Failure finalizerは1 invocationあたり最大50件の
zero-wait logical stepまたは8分までRUN ownerを各step前に再検証し、全created resourceをinventoryして
failed evidenceをsealし、
last-successful cadenceを更新せず`awaiting-cleanup-approval`へ進めます。全sealed failureを示す
`DrillFailureCount`、Workflow failure、RTO/timeout alarmをremediation対象として扱います。

自動descriptor gateが比較するのはattribute definitions、base key schema、GSI key/projection/ACTIVE、
billing、SSE/KMS、source TTL contractで、restore TTLはdisabledを要求します。DynamoDB Streams、
CloudWatch alarm、resource tag、IAM/application binding、traffic routingは自動data verifierの対象では
ありません。これらは別のIaC drift/recovery-plan evidenceで確認します。

通常runはStandard Step Functions、retained/PITR state table、Object Lock COMPLIANCE evidence bucketを
使用します。Raw exact locator/cursorはrestricted operational stateだけに保持し、immutable evidenceや
Step Functions logへ出しません。Semantic join stateはraw tenant IDではなくopaque HMAC claimです。
State tableはTTL/DeleteItemによるper-run retirementを実装しておらず、cleanup後も期限なく保持するため、
capacity/costを監視し、将来janitorを導入する場合は独立したdata-lifecycle reviewを必須にします。
Durable local progressはdynamic wait 0秒で再駆動し、AWS収束/copy claimだけを待機します。Main task
errorとworkflowの`FAILED`/270分`TIMED_OUT` statusは、`awaiting-cleanup-approval`へ到達するまで
durable failure-finalizer loopでevidence sealingを再開します。Pass/failのどちらもcleanupを
自動実行せずdata-owner承認待ちで停止します。
Generic Lambda/AWS/KMS/state-store failureは非integrityの`WORKFLOW_TASK_FAILED`として記録し、
全sealed failureを`DrillFailureCount`へ加算します。明示的なdescriptor/aggregate/cross-domain/
File-copy mismatchだけを追加でintegrity alarmへ加算します。
Result/cleanup artifactはObject Lock write前にcanonical bytesとordered effectをdurable CASでpinし、
response loss、別finalizer、daily takeover、replacement approvalも同じbytesとeffect progressを再生します。
Cleanup完了時刻とその時点のapproval-bound artifact snapshotは同じprogress CASで固定し、既にpin済みの
artifactをreplacement executionが再生してもRUNの`updatedAt`を過去へ戻しません。

### Work Items integrity verifier v1

Work Items table には、source または隔離済み restore table を read-only で走査して署名済み
manifest を作り、2つの manifest を AWS access なしで比較する operator CLI があります。
実行時には account、region、物理 table 名、AWS profile、専用 digest key file、output をすべて
明示し、ambient credential、既定 table、環境変数からの暗黙選択に依存しません。
例の`--silent`はBunによる引数echoを抑止し、CLIのstandalone JSONだけをstdout/stderrへ残します。
AWS SDK clientはenvironment/shared configのendpoint overrideを無視し、明示regionのAWS endpoint
以外へのredirectを許可しません。

Digest key file は暗号学的に安全な乱数から生成した専用の32-byte keyを64桁の小文字hexで保持し、
repository外で owner-only に管理します。Source writer を外部で停止または fence し、その状態が
走査全体を覆う場合は`writer-fenced`を指定します。

```sh
umask 077
openssl rand -hex 32 > work-items-integrity-key.hex
chmod 600 work-items-integrity-key.hex

bun run --silent work-items:integrity -- manifest \
  --role source \
  --account <12-digit-aws-account> \
  --region <region> \
  --table <source-work-items-table> \
  --profile <read-only-profile> \
  --digest-key-file work-items-integrity-key.hex \
  --output <source-manifest-path> \
  --source-consistency writer-fenced
```

Writer を止めず、ある時点の観測結果だけを記録する場合は
`--source-consistency live-observation` を使います。この manifest は drift 調査には使えますが、
exact restore 比較を `PASS` にできません。Restore manifest は application traffic と writer
から隔離し、復元完了後に追加書き込みがない table から作ります。

```sh
bun run --silent work-items:integrity -- manifest \
  --role restore \
  --account <12-digit-aws-account> \
  --region <region> \
  --table <restore-work-items-table> \
  --profile <read-only-profile> \
  --digest-key-file <work-items-integrity-key-file> \
  --output <restore-manifest-path>

bun run --silent work-items:integrity -- compare \
  --source-manifest <source-manifest-path> \
  --restore-manifest <restore-manifest-path> \
  --digest-key-file <work-items-integrity-key-file>
```

`manifest` が使う AWS action は次の allowlist に限ります。Operator role へ DynamoDB mutation、
restore、delete、application write の権限を付与しません。

- `sts:GetCallerIdentity`
- `dynamodb:DescribeTable`
- `dynamodb:DescribeContinuousBackups`
- `dynamodb:DescribeTimeToLive`
- `dynamodb:Scan`

CLI は STS account と table ARN/account/region を明示値に照合してから base table を全走査します。
`Scan` は `ConsistentRead=true` ですが、strong consistency は各 item の read に対するものであり、
複数 page にまたがる table-wide snapshot isolation ではありません。Manifest はこの性質を
`snapshotIsolation=false` として固定します。そのため `writer-fenced` は CLI が実現または証明
する機能ではなく、data owner が外部の writer fence とその時刻を evidence record に残した場合
だけ選択できます。

Manifest は raw row や tenant/Workspace/Team/Work Item ID、title、description、custom value、
scan cursor、per-item digest を含みません。同一専用 key を使った order-independent な
HMAC-SHA-256 の key-set/content aggregate、key fingerprint、manifest MACだけを保存します。
Output は atomic に作られ、owner-onlyの mode `0600` になります。Manifestにはaccount、region、
table ARN/profileなどの infrastructure-sensitive metadataが含まれるため、access-controlledな
evidence storeで管理し、digest keyとは別に保管します。
既存outputは上書きせず失敗するため、drillごとに一意なevidence pathを指定します。
`OUTPUT_FILE_PUBLISHED_CLEANUP_FAILED` または `OUTPUT_FILE_PUBLISHED_SYNC_FAILED` の場合は
最終outputが既に存在します。同じpathで再実行せず、前者は残った `.tmp-*` hard link を
owner-onlyのまま隔離してcleanupし、後者はfilesystem/directory durabilityを確認してから、
既存manifestを検証対象として扱うか新しい一意なpathで再取得するかをchange recordへ残します。

v1 は aggregate を primary-key digest 順にsortするため、走査中に最大
`1,000,000` item分の固定長digestをメモリに保持します。上限を超えた場合は部分結果を出さず
fail-closedで停止します。これは大規模table向けexternal sortを未実装とする明示的な制限です。

このstandalone CLI v1 の非目標は、DynamoDB restoreの実行/自動化、writer fenceの実装、
90日scheduleとRPO/RTOの
自動測定、Work Item Configuration/Relation Graph/Audit Eventsをまたぐ関係・設定・監査不変条件、
S3 object restore、regional DRです。特に下記手順はproduction writerを止めないため、手順中の
live source scanだけでは特定restore pointとの完全一致を証明できません。Exact comparisonには、
選択restore pointに対応し、外部fenceの証拠を伴うsource manifestを別途取得しておく必要があります。
Verifierが単独で成功しても、90日 PITR drillのRPO/RTO、cross-table invariants、cleanup evidenceが
揃わない限りdrill完了とはみなしません。

### Manual recovery / diagnostic procedure

通常の定期drillにはこの手順を使わず、自動workflowとimmutable evidenceを確認します。以下は
incident時のmanual recovery、または自動runの失敗箇所を診断するためのbreak-glass手順です。

1. Change record と drill ID を作り、account/region/source table、responsible data/infrastructure
   owner、開始 UTC を記録する。Production writer は止めず、restore table を application traffic
   へ接続しない。
2. `describe-continuous-backups` で PITR status、earliest/latest restorable time を保存し、
   latest restorable time が開始時刻から5分以内であることを確認する。
3. Restore point を選び、その時点の key schema/GSI/TTL/encryption を保存する。Exact compare
   には同じpointのDynamoDB export、またはそのpointに対応する外部writer fence証拠付きの
   `writer-fenced` source manifestを用意する。現在のwriter継続手順でその場から得られる
   `live-observation` manifestをexact baselineにしない。
4. Source と異なる一意な recovery table 名へ restore し、table exists/active まで待つ。

```sh
aws dynamodb restore-table-to-point-in-time \
  --region <region> \
  --source-table-name <source-table> \
  --target-table-name <source-table>-recovery-<drill-id> \
  --restore-date-time <ISO-8601-timestamp>

aws dynamodb wait table-exists \
  --region <region> \
  --table-name <source-table>-recovery-<drill-id>
```

5. 完了 UTC を記録し、descriptor を source/manifest と比較する。自動drillのdescriptor gateは
   attribute definitions、base key、GSI、billing、SSE/KMS、TTLだけに限定されるため、PITR、stream、
   alarm、resource tag、IAM/application binding、routingは自動検証済みとみなさず、このmanual手順の
   外部IaC/運用evidenceで個別に確認する。
6. Recovery table を隔離して追加書き込みを禁止し、Work Items integrity verifier で canonical
   row、exact item/logical partition count、key-set/content aggregate、descriptorを確認する。
   Sourceとのexact比較には手順3のexportまたは`writer-fenced` manifestを使う。Relation Graph、
   configuration、audit、Workspace Access、File Proofingとexact S3 copyのcross-domain invariantを
   read-only検査で確認し、raw tenant dataをevidenceへ出さない。
7. `latest restorable time` と選択 point から RPO、開始から verified までの RTO を計算し、
   目標の pass/fail と差分を記録する。
8. Source table は削除/置換しない。実 incident の切替は reviewed conditional repair または
   CDK/resource import plan を別途承認する。Drill table は evidence retention の完了後、
   data owner 承認の cleanup change で削除する。

### Required evidence

- Drill ID、owner、account/region、source/recovery table ARN、開始/完了 UTC
- PITR status、earliest/latest restorable time、選択 restore point、measured RPO/RTO
- Source export/recovery のattribute definitions、base key schema、GSI key/projection/ACTIVE、billing、
  SSE/KMS、source TTL contract/restore TTL disabled、item/partition count、HMAC aggregate、manifest MAC、
  同一restore pointへのbinding。Immutable resultはraw ARN/nameや設定値ではなくkeyed identity/
  descriptor digestとstable pass/failを保持する
- Relation/configuration/audit/access/file invariant、S3 body/metadata/tag copy、malware tagの
  secret-free pass/fail
- CloudTrail/command output、approvals、cleanup ticket、gap と remediation due date

Terminal evidenceはrunnerが`evidence/v1/runs/<drill-id>/result.json`へ、cleanup evidenceは別IAM roleが
同runの`cleanup.json`へ書き、writer権限を分離します。Cleanup approvalはterminal result/evidence
digest、隔離resource vector、DynamoDB export prefixes配下のincomplete multipart upload、approver、
change locator、有効期限をresource digestへ束縛します。Cleanupは1 logical stepあたり最大25 targetを処理し、
1 invocationで最大50件のzero-wait stepまたは8分までRUNとpinned cleanup execution identityを各step前に
再検証してbatchし、executionが`RUNNING`かつ`redriveCount=0`でなければ拒否します。external waitが
必要ならその時点でinvocationを終了します。
各restore table、scratch object VersionId、multipart uploadのidentity-bound absence receiptと最終prefix
不在確認まで保存します。Source table、source object、evidence objectはcleanup対象に含めません。

全cleanup targetはmutable run stateと別の`RESTORE_DRILL_LEDGER#<drill-id>`へappend-onlyで記録し、
atomic count/revisionとscope sealで固定します。CopyObject versionsはrunner停止後、16分のquiet windowを
挟む2 complete passのdigest/cursor一致を要求してからsealします。Cleanup roleはsealed ledgerを
read-onlyで参照し、progressは`RESTORE_DRILL_CLEANUP#<drill-id>`、RUN/CADENCEはcleanup-owned属性だけを
conditional updateします。Cleanup Standard workflowの明示physical identityはapproval policyの
Start/List/Describe permissionとcleanup roleのDescribe permissionで共通に固定し、timeout finalizerとは
分離します。

Regional replication、cross-region backup copy、DNS/traffic failover、standby stack は未実装です。
Regional outage は SEV1 とし、現状は regional RTO/RPO を保証しません。Production で regional
DR を要件とする場合、secondary region、replication、secret/key、Cognito、bucket、restore/failback
を実装し、game day evidence を得るまで DR gate は未達です。

## Production readiness evidence checklist

- [ ] Role/roster、primary/secondary notification、通知有効な40 alarmのtest delivery、
  fast-burn両component/compositeのstate history
- [ ] 30日 availability/latency report、transport failure coverage、burn alert test
- [ ] External liveness/readiness probe と rollout stop の test
- [ ] Correlation ID を request → log → event → actor/tenant へ追える sample
- [ ] Required CI checks と repository ruleset / branch protection の確認
- [ ] Deploy/rollback rehearsal と previous artifact/parameter inventory
- [ ] Runtime control の canary/emergency disable、fail-closed、re-enable、DLQ redrive の drill
- [ ] 90日以内の PITR restore drill、RPO/RTO、integrity evidence
- [ ] S3 restore と DynamoDB metadata 整合の drill
- [ ] Lambda code canary または同等の段階 rollout gate
- [ ] Regional DR の要否決定。必要なら replication/failover game day

関連する詳細手順は [Server backfills](../server/README.md#workspace-search-backfill) と
[CDK upgrade / rollback / PITR](../cdk/README.md#pitr-recovery) を参照してください。
