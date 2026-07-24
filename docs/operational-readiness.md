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
| Health | `/api/health` の liveness と `/api/ready` の DynamoDB readiness を分離する | Trusted probe と edge-level throttle を設定し、readiness の `503` を rollout 停止へ接続すること |
| Trace | CDK が管理する全16個の Node.js Lambda で X-Ray active tracing を有効にし、API log に runtime-controlled invocation ID と X-Ray root trace ID を記録する | Correlation ID 自体の X-Ray annotation は未実装 |
| Alarm | API、queue、DLQ、async destination の21個の CloudWatch alarm を定義する | Alarm action、SNS / Incident Manager、roster は未実装。通知先を接続し test alarm を確認するまで unattended production とみなさないこと |
| Release | PR/push workflow が production source/build config の strict typecheck、static analysis、unit/integration、Web E2E、CDK test/nag/synth を実行する | Server の legacy test source 全体の strict 化と repository ruleset / branch protection は未完了 |
| Rollout | Backward-compatible CDK/Lambda update と CloudFormation rollback を利用できる | Lambda alias、CodeDeploy canary、一般的な feature flag / kill switch は未実装。段階 rollout が必要な変更は gate を満たさない |
| Migration | Production-safe migration contract と entry/verification/rollback evidence を定義する | Workspace Search backfill は online fence、lease、lossless journal、完全検証、rollback を未実装。production gate には使用しないこと |
| Data durability | Stateful DynamoDB table は `Retain` + PITR、file bucket は `Retain` + versioning を使う | 定期 restore、regional replication/failover、AWS Backup plan は未実装。drill と regional DR を別途有効化すること |

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
- Good request: status が `500` 未満の eligible request。認証/認可/rate-limit を含む
  意図した `4xx` は server availability の失敗に数えない
- Bad request: `500` 以上、または throttle/transport failure により middleware completion
  record を作れなかった eligible request

Raw EMF は `Service` だけを dimension とし、health/readiness/preflight も含みます。30日 SLI は
JSON completion log の `routeGroup` と `method` から除外対象を引いた eligible count を作り、
raw EMF の集計値をそのまま分母にしません。

Application completion record は Function URL と HTTP API の両経路を同じ形式で数えます。
一方、Lambda throttle や integration 前の API Gateway failure は EMF completion record を
持ちません。`AWS/Lambda` の Errors/Throttles と API Gateway の `5xx` を補助 evidence とし、
同じ request を二重加算しない集計 pipeline または外形 probe ができるまでは availability
report を **provisional** と表示します。`treatMissingData=notBreaching` や traffic 0 は
成功 evidence ではなく `no-data` です。

Hono が catch して `500` response に変換した request は Lambda `Errors` を増やさないため、
Function URL と HTTP API の両経路を数える EMF `ServerErrorCount` alarm で補完します。単一 failure
alarm はありますが multi-window burn alert と両 transport の外形 probe は未実装です。

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

現在の CDK alarm は単一 failure または12秒 p95 を検出する safety alarm であり、次の
multi-window burn alert 自体はまだ実装されていません。Environment owner は dashboard/alarm
へ実装し、通知経路を試験する必要があります。

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

`GET /api/ready` は Work Items、Workspace Access、Audit Events の3 table を
`DescribeTable` で検証します。各 call の timeout は1.5秒、結果 cache は30秒です。Table と
設定済み GSI がすべて `ACTIVE` である場合だけ成功とし、設定不足、non-active status、timeout、
AWS error のいずれも fail-closed で safe name だけを返します。

```json
{
  "ok": false,
  "status": "not-ready",
  "checks": [
    {"name":"work-items","ready":true},
    {"name":"workspace-access","ready":false},
    {"name":"audit-events","ready":true}
  ]
}
```

全 check が成功したときだけ `200`、それ以外は `503` です。Physical table name や AWS error
は response に出しません。Readiness `503` が2回連続した rollout は停止し、5分継続または
複数 AZ/client で再現した場合は SEV2、全 request が失敗する場合は SEV1 へ上げます。

30秒 cache と同一 runtime 内の request coalescing は DynamoDB control-plane call を抑えますが、
scale-out をまたぐ abuse 防止にはなりません。Production では API edge/WAF で `/api/ready` を
trusted monitor に制限するか専用 rate limit を設定し、その制御を確認するまで public traffic へ
無制限に公開しません。

## Correlation と structured evidence

Common middleware は `/api/*` に対し、client が送った `X-Correlation-Id` と
`X-Request-Id` を canonical identifier として採用しません。API boundary で UUID を2つ生成し、
server 内の downstream request header と response の `X-Correlation-Id` /
`X-Request-Id` に設定します。信頼済み service 間の parent correlation を将来導入する場合は、
client header と別 field にし、認証済み ingress だけから受け取ります。

Completion log `api.request.completed` は次を含みます。

- `correlationId`、`requestId`、bounded `method`
- ID/query を除いた `/api/<area>` 形式の `routeGroup`
- Lambda runtime が供給した `invocationId` と X-Ray `traceId`（利用可能な場合）
- `status`、`durationMs`
- EMF namespace `Mukuroji/API`、dimension `Service=mukuroji-api`
- `RequestCount`、`Latency`、`ServerErrorCount`

Unexpected error log `api.request.failed` は `errorType` までを含め、exception message と stack
trace を含めません。Request/response body、query value、authorization、entity ID はどちらの
log にも記録しません。

API incident の最初の query は対象 Lambda log group と alarm window を固定して実行します。

```text
fields @timestamp, event, correlationId, requestId, invocationId, traceId,
       method, routeGroup, status, durationMs, errorType
| filter event = "api.request.completed" or event = "api.request.failed"
| filter status >= 500 or event = "api.request.failed"
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
gate を満たしません。

## Alarm catalog と追跡開始点

Alarm 名は CloudFormation の physical name ではなく CDK construct ID です。全 alarm は
missing data を `notBreaching` とするため、`OK` と telemetry が存在することを別々に確認します。

| Alarm | 条件 | Default | 最初に保存する locator |
| --- | --- | --- | --- |
| `ApiFunctionErrorAlarm` | Lambda `Errors Sum >= 1` / 5分 | SEV2 | Lambda function、UTC window、invocation failure。Hono error log があれば request/correlation ID |
| `ApiFunctionThrottleAlarm` | Lambda `Throttles Sum >= 1` / 5分 | SEV2 | Function concurrency、UTC window、transport metric。Middleware 未到達 request は request/user/tenant が unknown |
| `ApiFunctionLatencyAlarm` | Lambda duration p95 `>= 12,000 ms`、5分 period の2/3 | SEV2 | `api.request.completed` の `durationMs`、request/correlation ID、route group |
| `ApiApplicationServerErrorAlarm` | `Mukuroji/API` `ServerErrorCount Sum >= 1` / 5分 | SEV2 | Function URL / HTTP API の completion log、trusted request/correlation ID、route group |
| `ApiGatewayServerErrorAlarm` | HTTP API `5xx Sum >= 1` / 5分 | SEV2 | Stage/integration、UTC window。Lambda 到達時は API log、到達前 failure は correlation が unknown |
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

Alarm action は CDK からまだ接続されていません。全21 alarm の ARN、primary/secondary
destination、test notification の UTC timestamp と受信者を environment evidence に残すまで、
上記 ack target は実効性を持ちません。

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

一般的な maintenance read-only mode / global kill switch は未実装です。Writer 停止を確認できない
production migration は開始しません。

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
   `cdk-security` と、repository review policy をすべて成功させる。
3. `cdk diff` / synth を保存し、stateful resource replacement/deletion、IAM拡大、PITR/Retain
   の解除がないことを確認する。
4. Schema/API は backward-compatible にし、migration は上記 entry gate と verify/rollback
   evidence を用意する。
5. Error budget が残り、active SEV1/SEV2 がなく、on-call と alarm destination の test が成功
   していることを確認する。
6. 直前の成功 revision と同じ必須 parameter を使う rollback command を review する。

Workflow が存在しても branch protection の required check 設定がなければ gate は自動強制
されません。Repository administrator が設定を確認します。

Lambda alias/weighted routing/CodeDeploy canary と一般的な kill switch はありません。このため
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

### Drill procedure

1. Change record と drill ID を作り、account/region/source table、responsible data/infrastructure
   owner、開始 UTC を記録する。Production writer は止めず、restore table を application traffic
   へ接続しない。
2. `describe-continuous-backups` で PITR status、earliest/latest restorable time を保存し、
   latest restorable time が開始時刻から5分以内であることを確認する。
3. Restore point を選び、その時点の key schema/GSI/TTL/encryption、logical partition count、
   representative key digest、監査済み aggregate/checksum manifest を保存する。
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
6. Recovery table を隔離した read-only verifier で exact key sample、logical partition count、
   relationship/invariant、aggregate/checksum を確認する。Raw tenant data を evidence へ出さない。
7. `latest restorable time` と選択 point から RPO、開始から verified までの RTO を計算し、
   目標の pass/fail と差分を記録する。
8. Source table は削除/置換しない。実 incident の切替は reviewed conditional repair または
   CDK/resource import plan を別途承認する。Drill table は evidence retention の完了後、
   data owner 承認の cleanup change で削除する。

### Required evidence

- Drill ID、owner、account/region、source/recovery table ARN、開始/完了 UTC
- PITR status、earliest/latest restorable time、選択 restore point、measured RPO/RTO
- Source/recovery の key schema、GSI、TTL、encryption、item/partition count、checksum
- Representative records と relation/audit invariant の secret-free pass/fail
- CloudTrail/command output、approvals、cleanup ticket、gap と remediation due date

File bucket は versioning/Retain により object version を保持しますが、この DynamoDB drill だけでは
file restore を検証しません。S3 object/version、malware tag、metadata table の整合 restore を
別 drill に含めます。

Regional replication、cross-region backup copy、DNS/traffic failover、standby stack は未実装です。
Regional outage は SEV1 とし、現状は regional RTO/RPO を保証しません。Production で regional
DR を要件とする場合、secondary region、replication、secret/key、Cognito、bucket、restore/failback
を実装し、game day evidence を得るまで DR gate は未達です。

## Production readiness evidence checklist

- [ ] Role/roster、primary/secondary notification、全21 alarm の test delivery
- [ ] 30日 availability/latency report、transport failure coverage、burn alert test
- [ ] External liveness/readiness probe と rollout stop の test
- [ ] Correlation ID を request → log → event → actor/tenant へ追える sample
- [ ] Required CI checks と repository ruleset / branch protection の確認
- [ ] Migration interruption/resume/verify/rollback の non-production evidence
- [ ] Deploy/rollback rehearsal と previous artifact/parameter inventory
- [ ] 90日以内の PITR restore drill、RPO/RTO、integrity evidence
- [ ] S3 restore と DynamoDB metadata 整合の drill
- [ ] Canary/kill switch または同等の段階 rollout gate
- [ ] Regional DR の要否決定。必要なら replication/failover game day

関連する詳細手順は [Server backfills](../server/README.md#workspace-search-backfill) と
[CDK upgrade / rollback / PITR](../cdk/README.md#pitr-recovery) を参照してください。
