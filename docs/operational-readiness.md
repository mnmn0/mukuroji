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
| Trace | CDK が管理する全18個の Node.js Lambda で X-Ray active tracing を有効にし、API log に runtime-controlled invocation ID と X-Ray root trace ID を記録する | Correlation ID 自体の X-Ray annotation は未実装 |
| Alarm | API、queue、DLQ、async destination、runtime control の24 metric alarmと1 composite alarmを定義し、同一account/regionの必須primary/secondary SNS topicへ全alarm actionを接続する。Fast-burn component 2件はnotification無効 | SNS subscription、Incident Manager、rosterは環境側の責務。Compositeを含む通知有効な23件のtest evidenceを確認するまで unattended production とみなさないこと |
| Release | PR/push workflow が Server test を含む全 source/build config の strict typecheck、static analysis、unit/integration、Web E2E、CDK test/nag/synth を実行し、main ruleset が6つの必須 check を強制する | Path-filtered local runtime と外部 reviewer は常時 required にせず、対象変更ごとの release evidence で結果または rate limit を確認すること |
| Web journey quality | Required Playwright gate が主要 Work Item 画面の keyboard/focus、390px viewport、screen-reader-facing ARIA tree、低速 API 中の status と復帰を検証する | Chromium と mock API による回帰 proxy であり、実 screen reader、visual regression、performance budget は未実装 |
| Runtime control / rollout | AWS AppConfig の schema 検証済み `enabled` / `disabled` document を API、WebSocket、worker の entrypoint で fail-closed に評価し、operator 用 canary strategy と configuration failure alarm を定義する。Backward-compatible CDK/Lambda update と CloudFormation rollback も利用できる | `read-only` mode、route/effect registry、Lambda alias、CodeDeploy による code canary は未実装。AppConfig の停止制御を code/schema rollout の互換性検証や writer fence の代用にしないこと |
| Migration | Production-safe migration contract と entry/verification/rollback evidence を定義する。Workspace Search migration 専用の retained/PITR state table、Object Lock COMPLIANCE の segmented journal、未接続の least-privilege operator policy、物理 table/PITR/journal identity と maintenance drain evidence の strict validator を持つ | 実行 CLI の fenced lease/checkpoint、source/target CAS、完全 verify、reverse rollback は未実装。既存 backfill と基盤 validator だけを production migration gate に使用しないこと |
| Data durability | Stateful DynamoDB table は `Retain` + PITR、file bucket は `Retain` + versioning を使う。Work Items には read-only の manifest/compare verifier がある | Restore、writer fence、定期実行、regional replication/failover、AWS Backup plan は未実装。verifier の導入だけで drill や regional DR を完了扱いにしないこと |

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
`AlarmSecondaryTopicName` に必須指定し、同一account/regionのARNへ変換して全25 alarmの
`AlarmActions`へ設定します。Stackはtopic、subscription、Incident Manager、rosterを所有しません。
Fast-burn component 2件は`ActionsEnabled=false`で、残る22 metric alarmと1 composite alarmの
遷移が両topicへ同時通知されます。Ack target未達時の段階escalationはsubscription先が管理します。
Topic policyは`cloudwatch.amazonaws.com`の`sns:Publish`を同一account/regionのalarm ARNと
SourceAccountで制限して許可します。SSEを使う場合はcustomer-managed KMS keyにも同principalの
`kms:GenerateDataKey*`/`kms:Decrypt`と同じconfused-deputy条件を設定します。Operatorによる直接
SNS publishだけをdelivery evidenceにせず、controlled CloudWatch alarmの実state transition、
alarm history、両subscription receipt、OK復帰まで確認します。
全25 alarmのARN、primary/secondary destination、subscription/roster revision、通知有効な23件の
test notificationとfast-burn両component/compositeのstate history、UTC timestamp、受信者を
environment evidenceに残すまで、上記ack targetは実効性を持ちません。

## Versioned migration

Production migration は、migration ID/version、configuration hash、durable checkpoint、
idempotent apply、verify、rollback/forward-fix のすべてを持つ必要があります。

現行の Workspace Search backfill は、この production migration contract を満たしません。
Checkpoint、resume、rollback、online writer fence、source/target completeness verification、
credential から実測した account/table identity、lossless preimage journal、排他 lease が未実装です。
したがって production migration gate には使用せず、これらを実装して non-production で中断・再開・
rollback evidence を取得するまでは dry-run と maintenance-window 内の再生成用途に限定します。

### Entry gate

1. STS と `DescribeTable` から実測した source/target account、region、table ARN/ID、作成時刻、
   対象 scope、migration version、実行 commit を固定し、configuration hash を保存する。
2. PITR/backup、earliest/latest restorable time、source 件数、代表 key/checksum を保存する。
3. Dry-run の scanned/projected/deleted/skipped/invalid 件数を review する。
4. Online migration は writer fence/epoch または dual-write + high-watermark catch-up を有効化し、
   source scan と cutover の競合を閉じる。Maintenance migration は API、worker、connector など
   すべての writer を止め、実測で write が増えていないことを確認する。
5. Owner/run ID 付き lease と heartbeat を取得し、apply/verify/rollback の同時実行を拒否する。
6. Preimage journal は DynamoDB native value を lossless に保持できる暗号化された segmented store
   に置き、bounded memory/I/O、retention、access audit を確認する。
7. Verify と rollback の command、停止条件、最大実行時間、data/application owner を incident
   または change record に記載する。

Runtime control には対象の API/WebSocket/worker entrypoint を止める `disabled` mode が
ありますが、maintenance `read-only` mode と、mutation だけを網羅的に分類する route/effect
registry は未実装です。`disabled` の反映と実測上の writer 停止を確認できない production
migration は開始しません。

### Required verification and rollback semantics

- Apply は全 writer と共有する revision/content digest を compare-and-swap し、取得後に追加された
  unknown/optional field を無検知で上書きしない。
- Ambiguous transaction response は durable operation marker と target digest で reconcile し、
  commit 後の process loss を重複 mutation にしない。
- Verify は journal 内の item だけでなく source と target を再走査し、invalid row、欠落、stale target、
  件数、key/digest/checksum の completeness を検査する。
- Rollback は逆順かつ compare-and-swap で exact preimage を復元し、migration 後の live change を
  検出した場合は上書きせず停止する。
- Test は condition race、apply/rollback の commit 後 response loss、page cursor 保存前後の crash、
  source drift、lease expiry/takeover を real DynamoDB semantics または condition-aware harness で
  検証する。

Audit backfill v2 も durable source cursor、configuration hash、deterministic conditional write
により resume と重複防止を行いますが、preimage rollback journal を持ちません。したがって reversible
migration の代用にはせず、実行前 PITR と reviewed forward-fix/repair plan を必須にします。

Webhook authorization locator v3 は CloudFormation custom resource が compatibility writer の
drain、checkpointed page、cutover marker、legacy projection removal を行います。Stack rollback 時は
custom resource Delete が legacy projection を復元します。逆移行が失敗した stack で custom
resource を skip して `continue-update-rollback` しません。

### Migration evidence

- Migration ID/version/configuration hash、実測した account/table identity、journal の secret-free locator
- Source ごとの initial/final cursor、scanned/applied/skipped/invalid/rolled-back count
- PITR status、restore point、backup ARN、lease owner/heartbeat/fence epoch
- 各 operation marker/preimage journal の count と verification result
- Process interruption/resume の時刻、同じ operation が二重適用されなかった証拠
- Before/after key schema、GSI、TTL、item count、logical integrity checksum
- Writer stop/start、read smoke、DLQ/alarm、承認者、rollback window の終了時刻

## Deploy と rollback

### Pre-deploy gate

1. Deploy commit OID、build artifact digest、target account/region/stack/parameters を固定する。
2. GitHub の `static-analysis`、`strict-typecheck`、`application-unit-tests`、`web-e2e`、
   `cdk-security`、`dependency-review` と、repository review policy をすべて成功させる。
3. `cdk diff` / synth を保存し、stateful resource replacement/deletion、IAM拡大、PITR/Retain
   の解除がないことを確認する。
4. Schema/API は backward-compatible にし、migration は上記 entry gate と verify/rollback
   evidence を用意する。
5. Error budget が残り、active SEV1/SEV2 がなく、on-call と alarm destination の test が成功
   していることを確認する。
6. 直前の成功 revision と同じ必須 parameter を使う rollback command を review する。

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
`webhook-authorization-backfill-handler.ts` の `handler` と `isCompleteHandler` は
CloudFormation rollback/recovery の deadlock を避けるため対象外です。これら migration
function、runtime-control alarm readinessの2 function、CDK/CloudFormation Provider function、
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

Lambda alias/weighted routing/CodeDeploy による code canary はありません。AppConfig の
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
   rollback する。Webhook locator は custom resource の逆移行を完了させる。
4. Schema-compatible な code/infrastructure は直前の成功 revision を同じ必須 parameter で
   deploy する。Retained resource を template から外さない。
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

最低でも90日ごと、key schema/GSI/critical migration の変更後に、Work Items、Workspace Access、
Audit Events のいずれかを交代で restore します。現時点では定期実行 automation がないため、
environment owner が schedule、対象、evidence location を登録しなければなりません。

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

v1 の非目標は、DynamoDB restoreの実行/自動化、writer fenceの実装、90日scheduleとRPO/RTOの
自動測定、Work Item Configuration/Relation Graph/Audit Eventsをまたぐ関係・設定・監査不変条件、
S3 object restore、regional DRです。特に下記手順はproduction writerを止めないため、手順中の
live source scanだけでは特定restore pointとの完全一致を証明できません。Exact comparisonには、
選択restore pointに対応し、外部fenceの証拠を伴うsource manifestを別途取得しておく必要があります。
Verifierが単独で成功しても、90日 PITR drillのRPO/RTO、cross-table invariants、cleanup evidenceが
揃わない限りdrill完了とはみなしません。

### Drill procedure

1. Change record と drill ID を作り、account/region/source table、responsible data/infrastructure
   owner、開始 UTC を記録する。Production writer は止めず、restore table を application traffic
   へ接続しない。
2. `describe-continuous-backups` で PITR status、earliest/latest restorable time を保存し、
   latest restorable time が開始時刻から5分以内であることを確認する。
3. Restore point を選び、その時点の key schema/GSI/TTL/encryption を保存する。Work Items の
   exact compare を行う場合は、restore point に対応する、外部 writer fence 証拠付きの
   `writer-fenced` source manifest を用意する。現在の writer 継続手順でその場から得られる
   `live-observation` manifest を exact baseline にしない。
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

5. 完了 UTC を記録し、descriptor を source/manifest と比較する。Restore 後に自動復元されない
   runtime setting がある前提で、TTL、PITR、stream、alarm、tags、IAM/application binding を
   個別に確認する。
6. Recovery table を隔離して追加書き込みを禁止し、Work Items integrity verifier で canonical
   row、exact item/logical partition count、key-set/content aggregate、descriptorを確認する。
   Sourceとのexact比較には手順3の`writer-fenced` manifestを使う。Relation Graph、configuration、
   auditのcross-table invariantは別のread-only検査で確認し、raw tenant dataをevidenceへ出さない。
7. `latest restorable time` と選択 point から RPO、開始から verified までの RTO を計算し、
   目標の pass/fail と差分を記録する。
8. Source table は削除/置換しない。実 incident の切替は reviewed conditional repair または
   CDK/resource import plan を別途承認する。Drill table は evidence retention の完了後、
   data owner 承認の cleanup change で削除する。

### Required evidence

- Drill ID、owner、account/region、source/recovery table ARN、開始/完了 UTC
- PITR status、earliest/latest restorable time、選択 restore point、measured RPO/RTO
- Source/recovery の key schema、GSI、TTL、encryption、item/partition count、HMAC aggregate、
  manifest MAC、source writer fence evidence
- Work Items verifierが対象外とするrelation/configuration/audit invariantの別検査による
  secret-free pass/fail
- CloudTrail/command output、approvals、cleanup ticket、gap と remediation due date

File bucket は versioning/Retain により object version を保持しますが、この DynamoDB drill だけでは
file restore を検証しません。S3 object/version、malware tag、metadata table の整合 restore を
別 drill に含めます。

Regional replication、cross-region backup copy、DNS/traffic failover、standby stack は未実装です。
Regional outage は SEV1 とし、現状は regional RTO/RPO を保証しません。Production で regional
DR を要件とする場合、secondary region、replication、secret/key、Cognito、bucket、restore/failback
を実装し、game day evidence を得るまで DR gate は未達です。

## Production readiness evidence checklist

- [ ] Role/roster、primary/secondary notification、通知有効な23 alarmのtest delivery、
  fast-burn両component/compositeのstate history
- [ ] 30日 availability/latency report、transport failure coverage、burn alert test
- [ ] External liveness/readiness probe と rollout stop の test
- [ ] Correlation ID を request → log → event → actor/tenant へ追える sample
- [ ] Required CI checks と repository ruleset / branch protection の確認
- [ ] Migration interruption/resume/verify/rollback の non-production evidence
- [ ] Deploy/rollback rehearsal と previous artifact/parameter inventory
- [ ] Runtime control の canary/emergency disable、fail-closed、re-enable、DLQ redrive の drill
- [ ] 90日以内の PITR restore drill、RPO/RTO、integrity evidence
- [ ] S3 restore と DynamoDB metadata 整合の drill
- [ ] Lambda code canary または同等の段階 rollout gate
- [ ] Regional DR の要否決定。必要なら replication/failover game day

関連する詳細手順は [Server backfills](../server/README.md#workspace-search-backfill) と
[CDK upgrade / rollback / PITR](../cdk/README.md#pitr-recovery) を参照してください。
