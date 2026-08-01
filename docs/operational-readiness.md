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
| Trace | CDK が管理する全20個の Node.js Lambda で X-Ray active tracing を有効にし、API log に runtime-controlled invocation ID と X-Ray root trace ID を記録する | Correlation ID 自体の X-Ray annotation は未実装 |
| Alarm | API、queue、DLQ、async destination、runtime control、restore drill、Workspace Search migration の43 metric alarmと1 composite alarmを定義し、同一account/regionの必須primary/secondary SNS topicへ全alarm actionを接続する。Fast-burn component 2件はnotification無効 | SNS subscription、Incident Manager、rosterは環境側の責務。Compositeを含む通知有効な42件のtest evidenceを確認するまで unattended production とみなさないこと |
| Release | PR/push workflow が Server test を含む全 source/build config の strict typecheck、static analysis、unit/integration、Web E2E、CDK test/nag/synth を実行し、main ruleset が6つの必須 check を強制する | Path-filtered local runtime と外部 reviewer は常時 required にせず、対象変更ごとの release evidence で結果または rate limit を確認すること |
| Web journey quality | Required Playwright gate が主要 Work Item 画面の keyboard/focus、390px viewport、screen-reader-facing ARIA tree、低速 API 中の status と復帰を検証する | Chromium と mock API による回帰 proxy であり、実 screen reader、visual regression、performance budget は未実装 |
| Runtime control / rollout | AWS AppConfig の schema 検証済み `enabled` / `disabled` document を API、WebSocket、worker の entrypoint で fail-closed に評価し、operator 用 canary strategy と configuration failure alarm を定義する。Shared API は revision-bound な Lambda Version と `live` Alias で code/configuration を揃えて切り替える | `read-only` mode、route/effect registry、weighted alias routing、CodeDeploy による code canary は未実装。AppConfig の停止制御を code/schema rollout の互換性検証や writer fence の代用にしないこと |
| Migration | Production-safe migration contract と entry/verification/rollback evidence を定義する。Workspace Search migration 専用の retained/PITR state table、Object Lock COMPLIANCE の segmented journal、transaction 限定 operator policy、物理 table/PITR/journal identity と maintenance drain evidence の strict validator、sealed plan/lease/fence/OCC/checkpoint/apply/verify/部分 apply からの reverse rollback を検証する永続 state-machine kernel を持つ。同じ measured AWS session に identity-bound な source Scan 1 page と exact digest/checkpoint reducer を持ち、複数 page の row evidence と累積 checkpoint を conditional transaction で保存して、commit 後の response loss から再開できる。Migration-state table には全 run/configuration で競合する global lease/heartbeat と、fresh maintenance evidence の immutable receipt/current pointer を永続化する。Source-evidence schema は S3 を使わない `dry-run` v1、read-only legacy planning v2、lossless artifact reference を必須にする planning v3 を分離する。Planning v3 は同じ measured AWS session の concrete S3 adapter で全 raw item を strict/lossless な DynamoDB AttributeValue segment（最大16 MiB）として Object Lock COMPLIANCE bucket へ保存し、順序付きの exact `{objectKey, versionId, contentDigest}` を lease/fence/current receipt と固定5 item transaction に結合する。Target raw page にも lossless codec と measured configuration-bound S3 adapter があり、exact object version を再読検証できる。Concrete managed AWS session は planning-only target evidence v1 を composition し、1 page ごとに raw target Scan を1回だけ行って lossless target artifact を upload する。Commit 前には target、続いて migration-state table の incarnation を再検証する。Exact-version artifact replay を可能にする順序付き reference、累積 checkpoint、authority の3 condition check、immutable page、predecessor-CAS head を固定5 item transaction に結合し、response loss を strict に照合できる。Pure planning join は planning v3 の4 source と target evidence v1 の raw page material を exact replayし、per-chain terminal identity/bounds、同一 run で実現可能な単調 authority 履歴と canonical provenance digest、target preimage、expected/observed/orphan set、candidate、target projected/deleted を決定的に構築する。Managed composition は同じ measured generation で state/source/target incarnation を前後検証し、5 head を強整合で固定して remaining budget 内の exact-version material を順次取得し、pure join 後に5 head を再確認する。同じ session は planning-artifact gateway も同一の pinned S3 client、measured configuration、generation 上へ composition し、caller は `runId` だけを指定する。Manifest-aware sealed authority v2 は、plan seal、plan/provenance manifest head、compact authority provenance、全6 TableId、5 terminal head、fresh current authority を結合し、authority 3条件、source 4 head、target head、未作成rootを固定9 item transactionで原子的に公開する。応答消失時は同一canonical rootの強整合再読だけを成功として回収する。Complete-plan apply sealはterminal 5 checkpoint、execution admission/state digest chain、journal/marker aggregate、全6 TableIdをexact-version Object Lock artifactとimmutable applied rootへ束縛し、rollback-start sentinelのabsenceを含む固定10 item transactionと強整合reconciliationで`applied` phaseを公開する。Application writer-fence v1 は全6 TableId と migration-state incarnation に束縛した strict canonical row、単調 epoch/revision、強整合 read、exact predecessor CAS、current authority 3条件付きinitial bootstrap、response-loss reconciliation、measured session quarantine を持つ。Execution-boundary AWS portはwriter-fence closeとrevision 1 boundary、post-close planning admissionとrevision 2 boundaryを、current authorityと未作成planning headへ束縛した固定10 item transactionとしてcommitする。Production API、worker、connector、backfill の fenced-table mutation は invocation-stable な open-row ConditionCheck 付き transaction へ統合し、TTL-managed support row と mapped migration row の disjointness を fail-closed に検証する。Terminal-outcome releaseはv1 closed row、revision 2 boundary、sealed authority、execution admission、verifiedまたは完全rolled-back rootを固定5 item transactionでexact CASし、全6 TableIdとterminal digestを保持するversion 2 open epoch/revisionへ進める。Resource measurement、writer-fence status、初回open-row bootstrapを行うcontrol CLIとsingle-flight heartbeat supervisorを持つ。Close、15分以上のpost-close drain、同一runでの4 source＋target再取得、plan/provenance保存、fresh authority付きsealed root publicationをdurable headから再開するplanning supervisorを持つ。Explicit coordinatorはclose/replan、apply、verify、partial/complete rollback、terminal releaseを別commandとして接続し、各stageでreview済みhash、run/owner、fresh evidence、exact approvalを再要求する。Production compositionはaccount/region単位のdurable `DescribeTable` rate ledgerと182-attempt page reservationを適用し、Service-only EMF、checkpoint/rate/quarantine/terminal telemetry、5 migration alarmを持つ | Restore/failover/DR drill、承認済みnon-production実行・alarm delivery evidenceは未完了。Legacy planning v2 は digest-only のまま append/promote できない。これらのenvironment evidenceをreviewするまでProduction migration gateは閉じたままにすること |
| Data durability | Stateful DynamoDB table は `Retain` + PITR、file bucket は `Retain` + versioning を使う。6表の同一時点PITR restore、同時点exportとのexact aggregate比較、exact S3 version copy、RPO/RTO測定、90日cadence、immutable evidence、承認付きcleanupを隔離workflowで自動化する | Regional replication/failover と AWS Backup plan は未実装。成功したsame-Region drillをregional DR完了扱いにしないこと |

Migration 行の「同一canonical root」には、同じtransaction attemptのbyte-identicalなrootに加え、
同じstable caller inputを既存root自身の`sealedAt`で再構築してcanonical bytesが一致するdurable retryを
含みます。Managed post-transaction incarnation guard failureはこの自動回収の対象外です。

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
| `WorkspaceSearchMigrationDescribeTableThrottleAlarm` | `Mukuroji/WorkspaceSearchMigration` `DescribeTableThrottleCount Sum >= 1` / 5分 | SEV2 | Alarm UTC window、secret-free telemetryの`correlationId`/`evidenceLocator`/configuration binding/hash/policy version、read-only execution statusまたはunbound再測定 |
| `WorkspaceSearchMigrationRateBudgetExhaustionAlarm` | `DescribeTableBudgetExhaustionCount Sum >= 1` / 5分 | SEV2 | Rate phase、fixed budget-stop reason、identifier-free rate aggregate、review済みpolicy、configuration binding |
| `WorkspaceSearchMigrationCheckpointStallAlarm` | `CheckpointStallCount Sum >= 1` / 5分 | SEV2 | 5分watchdogのphase、last progress、correlation/evidence locator、heartbeat/lease status |
| `WorkspaceSearchMigrationQuarantineAlarm` | `QuarantineCount Sum >= 1` / 5分 | SEV1 | Fixed quarantine reason、直前のpre/post-send guard、durable execution status。自動retryしない |
| `WorkspaceSearchMigrationTerminalFailureAlarm` | `TerminalFailureCount Sum >= 1` / 5分 | SEV1 | Fixed terminal reason、operation/phase/outcome、durable terminal/status root、verify/rollback decision |
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
`AlarmSecondaryTopicName` に必須指定し、同一account/regionのARNへ変換して全44 alarmの
`AlarmActions`へ設定します。Stackはtopic、subscription、Incident Manager、rosterを所有しません。
Fast-burn component 2件は`ActionsEnabled=false`で、残る41 metric alarmと1 composite alarmの
遷移が両topicへ同時通知されます。Ack target未達時の段階escalationはsubscription先が管理します。
Topic policyは`cloudwatch.amazonaws.com`の`sns:Publish`を同一account/regionのalarm ARNと
SourceAccountで制限して許可します。SSEを使う場合はcustomer-managed KMS keyにも同principalの
`kms:GenerateDataKey*`/`kms:Decrypt`と同じconfused-deputy条件を設定します。Operatorによる直接
SNS publishだけをdelivery evidenceにせず、controlled CloudWatch alarmの実state transition、
alarm history、両subscription receipt、OK復帰まで確認します。
全44 alarmのARN、primary/secondary destination、subscription/roster revision、通知有効な42件の
test notificationとfast-burn両component/compositeのstate history、UTC timestamp、受信者を
environment evidenceに残すまで、上記ack targetは実効性を持ちません。

### Workspace Search migration alarm response

Migration metricは`Mukuroji/WorkspaceSearchMigration` namespaceと
`Service=mukuroji-workspace-search-migration`だけをdimensionに使います。`operation`、`phase`、
`outcome`、configuration hash、policy version、process生成の`correlationId`、digest由来の
`evidenceLocator`はsecret-free log属性でありdimensionではありません。Run/owner ID、table名/ARN、
account、profile、tenant、cursor、evidence path/bytes、raw AWS error、message、stackは出力しません。
Recorder failureやlog sink failureはmigration結果を変更しません。Control CLIはterminal result/errorの
EMFを同じ1行へ結合し、live checkpoint stallだけはoperationがhungしたままでも検知できるよう
`event=workspace-search-migration.checkpoint-stall`の独立したsecret-free EMF行を即時出力します。
stdout/stderrの両方をCloudWatch Logsへingestしない端末で実行した場合、JSONLにEMFがあっても
CloudWatch metricにはなりません。

Alarmを受信したら、次の順で調査します。

1. Alarm construct/physical name、`StateUpdatedTimestamp`、5分periodを含むUTC window、metric名、
   primary/secondary receiptをincident recordへ固定し、migrationの新規stageを停止する。
2. Log-ingested execution surfaceで同じUTC windowと`Service`を使い、
   `event=workspace-search-migration.finalized`または
   `event=workspace-search-migration.checkpoint-stall`を検索する。Alarm metricの値が1以上のrecordから
   `correlationId`、`evidenceLocator`、operation/phase/outcome、configuration binding/hash、policy
   version、fixed reasonだけを保存する。Live stallではoperation終了前のためfinalized recordがないことを
   正常とし、即時stall recordを相関の起点にする。
3. Access-controlled change recordで`evidenceLocator`を承認済みaccount/region/commitと実行artifactへ
   結合する。初回`measure`がidentity確定前に失敗したrecordは`configurationBinding=unbound`であり、
   configuration hashを捏造しない。Policy version、correlation、unbound evidence locator、明示した
   private resource inventoryを使って再測定へescalateする。Restrictedなrun IDやresource identityを
   汎用logへ逆コピーしない。
4. Non-`measure` recordの`configurationBinding=bound`は、I/O前にreview済みexpected hashへcorrelationと
   evidence locatorを束縛したことを表し、fresh measurement成功やruntime configuration一致の証明ではない。
   Bound recordでは同じ明示resource、review済みconfiguration hash、rate policyを使ってread-only
   `execution-status`を再実行し、durable phase/next action、writer fence、rate aggregateを照合する。
   Alarm単独をmigration stateの正本にしない。
5. Throttle/budget exhaustionはpolicyとcharged attemptをreviewし、checkpoint stallは
   `WORKSPACE_SEARCH_MIGRATION_CHECKPOINT_STALL_THRESHOLD_MILLISECONDS=300000`のlive-operation
   watchdog、heartbeat、最後のdurable progressを確認する。意図的な15分drainではwatchdogをarmしない。
   Quarantine/terminal failureは自動retry、takeover、rollback、releaseを行わず、data ownerがexact
   durable stateから明示commandを承認する。

### Non-production migration alarm delivery rehearsal

各環境のproduction gateを開く前に、承認済みnon-production accountのCloudWatch Logsへingestされる
隔離runner、またはmigration operatorとは別の一時的なtest identityを使います。後者の
`cloudwatch:PutMetricData`は`cloudwatch:namespace=Mukuroji/WorkspaceSearchMigration`へ制限し、
rehearsal後に失効させます。Production migration operator policyへこの権限を追加しません。

CloudWatch Logsへstdoutを1行単位で取り込む隔離runnerでは、対象alarmに対応する`--signal`を
`describe-table-throttle`、`rate-budget-exhaustion`、`checkpoint-stall`、`quarantine`、
`terminal-failure`から選び、次のstrict commandを実行します。Configuration hashとpolicy versionは
review済みのlowercase SHA-256 digestだけを指定します。このcommand自身はAWS APIを呼びません。

```sh
bun run --silent search:migration:telemetry-rehearsal -- \
  --approval acknowledge-non-production-alarm-delivery-rehearsal \
  --signal describe-table-throttle \
  --configuration-hash "$MIGRATION_CONFIGURATION_HASH" \
  --policy-version "$MIGRATION_RATE_POLICY_VERSION"
```

対象alarmのALARM evidence取得後、次の5分periodで同じdigest bindingの`--signal recovery`を実行し、
全5 alarm metricが明示0のrecordを取り込みます。各実行のstdoutはexactly one EMF JSON lineです。

1. 対象5 alarmが自然評価で`OK`、`ActionsEnabled=true`、exact `AlarmActions`がprimary/secondaryの
   2 ARNであることを保存する。
2. 実telemetry contractから対象metricを1にするcontrolled secret-free recordを1件だけingestする。
   `SetAlarmState`やSNSへの直接`Publish`は使わない。Correlation/evidence locator、configuration hash、
   policy version、実行commit、UTC ingest windowをchange recordへ保存する。
3. `OK → ALARM`のalarm history、両subscriptionのmessage ID/受信UTC/対象alarm ARNを取得する。
   片方でも未着なら成功にしない。
4. 次の5分periodに同contractの成功record（対象alarm metricは明示0）をingestし、または送信を止めて
   `notBreaching`評価を待つ。`ALARM → OK`のhistoryを保存する。OK通知はstack契約に含まれないため、
   recovery receiptはalarm historyで証明する。
5. 5種類すべてについてmetric datapoint、secret-free log、read-only status、両ALARM receipt、
   `OK → ALARM → OK` historyを一つのimmutable evidence indexへ結合する。Unit testや
   `SetAlarmState`だけの結果をdelivery evidenceとして受理しない。

## Versioned migration

Production migration は、migration ID/version、configuration hash、durable checkpoint、
idempotent apply、verify、rollback/forward-fix のすべてを持つ必要があります。

現行の Workspace Search backfill は、この production migration contract を満たしません。
専用 migration v1 には credential から実測する account/table identity、lossless preimage journal、
fresh maintenance evidence、sealed plan と排他 lease/fence/OCC、checkpoint、独立 verify、部分 apply
からも開始できる reverse rollback の永続 state-machine kernel があります。Source については、
同じ measured identity/pinned credential/DynamoDB client を使う、strongly consistent、
unfiltered/full-item/non-segmented な1 page Scan と exact digest/checkpoint reducer まで実装済みです。
各 page は Scan の前後で table ID/ARN/作成時刻を再確認し、継続 cursor を返却された最終 item の
full primary key に結合します。一時的な throttling/transport 障害は安全に再試行できる固定 code で
停止し、table incarnation の変化や cursor の不整合は fail-closed で拒否します。
複数 page の走査では、`dry-run` と `planning` を分離し、各 page の digest-only row evidence と
累積 checkpoint を、run、configuration、source/state table identity、直前 checkpoint と evidence
head に条件付けた同じ transaction で保存します。Transaction の commit 後に response が失われた
場合は、永続化済みの evidence/checkpoint tuple が期待した successor と完全一致するときだけ成功を
回収し、それ以外は直前の durable checkpoint から停止または再開して page を飛ばしません。

Source-evidence schema の世代は次のように分離します。

- `dry-run` v1 は従来どおり authority と source artifact reference を持たず、S3 upload を行わない
  digest-only evidence です。
- Legacy planning v2 は authority-bound ですが raw item を持たない digest-only evidence です。
  Historical chain の strict parse/replay だけを許し、v2 head への page append、v3 reference の後付け、
  v3 chain への promotion を許しません。v2/v3 page を同じ planning chain へ混在させません。
- Planning v3 は authority に加え、各 raw source page を完全に覆う順序付きの exact
  `{objectKey, versionId, contentDigest}` reference を必須にします。`objectKey` は segment の
  `contentDigest` から決まる secret-free namespace に限定し、空の `versionId` と重複 key を
  拒否します。Reference の順序も canonical page bytes/digest に結合し、追加、欠落、並べ替え、
  version substitution は exact successor と restart 時の full-page 比較に一致しません。新規 head
  は complete chain の `chainEvidenceVersion` を保存し、後続 CAS でも exact predecessor として
  固定します。Discriminator のない historical planning head は read/replay だけを許可し、latest
  page が v3 に見える場合も append しません。

Planning v3 の artifact codec は、同じ measured Scan page の全 raw item を DynamoDB
AttributeValue の型、number spelling、binary、set、list/map の入れ子まで lossless に保持します。
Canonical segment は item 境界だけで分割し、1 segment を最大16 MiBに制限します。合法な400 KiB
item が最悪ケースの JSON escape で2 MiBを超えても item 自体は分割しません。各 segment は
run/configuration/source と source/state table incarnation、page/predecessor、planning authority、
segment/item の index/count を結合し、extra/missing/non-canonical/oversized な値を拒否します。
Artifact に cursor を含めません。

具体的な gateway は、pinned AWS identity session で実測した migration journal bucket だけを使い、
各 canonical segment を `If-None-Match: *`、exact owner、SHA-256 checksum、customer-managed
SSE-KMS key、Bucket Key 付きの単一 `PutObject` で保存します。Put 後、412、response loss のいずれも
exact/current `HeadObject` で VersionId、checksum、content length/type、metadata、SSE-KMS key、
Bucket Key と、実測 default retention 日数以上の Object Lock `COMPLIANCE` retention を検証した
場合だけ reference を返します。再開時の `GetObject` は exact VersionId と同じ属性を再検証し、
本文全体を16 MiB上限かつ10秒 deadlineで読み、停止した stream は best-effort で cancel します。
必要な `s3:GetObjectRetention` も migration operator の journal prefix限定権限へ含めます。

Resume に必要な checkpoint cursor は raw DynamoDB key を含み、tenant identifier を含み得るため、
retained migration-state table の checkpoint のみに保存します。ログ、S3 segment、外部 evidence
export へ出力せず、同 table の read 権限も migration operator に限定します。Planning v3 の restart
verification は、committed page に列挙された exact `objectKey` と exact `versionId` だけから全
segment を読み、bytes と `contentDigest`、identity、順序を検証します。非終端 page だけは restricted
checkpoint の cursor を `LastEvaluatedKey` として再構成し、直前 checkpoint から同じ reducer を
再実行して、row evidence、aggregate、successor checkpoint、authority、artifact reference を含む
canonical v3 page 全体が一致した場合だけ採用します。S3 `List`、current/latest version、prefix の
推測、cursor の artifact からの推測を再開判断に使いません。
Pre-plan authority は同じ measured AWS session と migration-state table に永続化します。物理
state-table incarnation ごとに1つの global lease を使い、configuration/run が異なっても active
lease と競合します。Lease は60秒、heartbeat は同じ run/owner/fence の未失効 lease だけを延長し、
expiry ちょうどからの takeover は fence を単調増加させます。Configuration が変わった場合も
期限切れ predecessor を exact CAS して同じ global fence chain を引き継ぎます。
Strict に検証した maintenance evidence は raw bytes を table へ保存せず、exact byte digest、
secret-free locator、観測時刻、runtime revision、run/fence を immutable receipt に保存します。
Receipt と current pointer は1 transactionで commit し、lease の残り時間と receipt freshness を
同じ adapter-owned commit clock の command 構築直前に検証します。Transaction の ConditionCheck は
active lease の identity と10秒を超える headroom を再確認しますが、receipt freshness 自体は
DynamoDB condition ではなく process 内で再検証します。
Heartbeat は receipt を fresh にせず、receipt renewal も lease を延長しません。Strong read、
deterministic idempotency token、
exact successor reread によって response loss を回収し、receipt/pointer の torn state や別の
successor は成功として採用しません。同じfenceでreceiptをrenewする場合は、callerが直前に読んだ
pointer revision/digestをexact predecessorとして要求し、古いfresh evidenceによる上書きを
拒否します。Table ID/ARN/作成時刻が変化した session も fail-closed です。
Planning source-evidence page の commit は、global lease の ConditionCheck、current
maintenance-evidence pointer の ConditionCheck、immutable receipt の ConditionCheck、
immutable page の Put、successor head の CAS Put の順に並ぶ固定5 item transaction です。
Planning v3 では gateway による全 S3 segment upload がこの最終 DynamoDB transaction より先です。
Page の canonical bytes は `ownerId`、`fenceToken`、pointer revision、receipt digest と、順序付きの
exact artifact reference を結合します。
Command 構築時の commit clock で receipt freshness を process 内で再検証し、transaction では
active lease identity/headroom と、読んだ exact current pointer/receipt が変わっていないこと、
pointer と receipt に保存した validity deadline が同じ10秒超の commit window を保つことを
再確認します。Upload 後に authority race、conditional failure、ambiguous/unresolved failure が
起きた場合、固定5 item transaction に reference が commit されなかった S3 version は
non-authoritative です。Object Lock COMPLIANCE retention 中は削除や上書きで回収せず、retained
orphan として費用/件数を観測します。後続実行が `List` や latest version から orphan を採用することも
禁止し、committed v3 page の exact reference だけを authority とします。`dry-run` v1 の page commit
は S3 upload と authority ConditionCheck を持たない固定2 item transaction のままで、planning chain
へ昇格できません。

Lossless source/target artifact の codec と measured S3 adapter、source planning v3 の
evidence/verification contract に加え、target table を同じ measured AWS session から強整合・
無加工・100件上限で読み、Scan 前後の table incarnation と cursor を検証し、checkpoint を
measured configuration hash に結合する read-only page primitive があります。Concrete managed
AWS session は、この primitive、target artifact S3 adapter、planning-only target evidence v1 の
durable adapter を同じ measured identity、pinned credential、generation に composition します。
未完了 head から次の page を進める各 `commitNextPage` は raw target page の Scan を1回だけ
実行し、その同一 page の全 raw item を lossless segment として upload して、digest/checkpoint と順序付きの exact
`{objectKey, versionId, contentDigest}` を作ります。Committed evidence の read/reconciliation は
記録済みの exact object key/version だけを再読し、artifact bytes、identity、順序、reducer と
canonical evidence を再検証します。Upload 後、commit clock の取得前には target table、続いて
migration-state table の incarnation を順に再検証し、authority の3 condition check、immutable
page、exact predecessor-CAS head からなる固定5 item transaction で target evidence と checkpoint
を進めます。Terminal head の再呼び出しは Scan、artifact I/O、clock、transaction を行わず、
同じ progress を返します。Upload 後に incarnation drift が判明した artifact version は未 commit の
non-authoritative orphan であり、再開時に採用しません。

Planning-only target evidence v1 の canonical chain/replay contract は、各 page の target row
evidence、累積 checkpoint、owner/fence/current receipt、順序付き exact artifact reference を
結合し、page 間の physical key 重複と aggregate/binding 不整合を拒否します。Transaction response
loss は exact successor なら intended page の全 artifact segment、head-ahead なら exact committed
prefix の全 page/artifact replay が期待状態に完全一致するときだけ回収します。Durable page は
強整合 `GetItem` を最大25件ずつ順序付きで先読みします。上限10,000 page の worst case は
10,000 request / 最大400回の DynamoDB read wave に加えて、
依存する progress を順番に進める最大10,000回の exact-version S3 artifact 検証となるため、
運用 timeout は `400 × DynamoDB p95 + 10,000 × S3/reducer p95 + retry budget` を基準に
見積もります。ただし、この composition は1 page の target capture/evidence 永続化を閉じるものです。
Pure planning join は planning v3 の4 source chain と target evidence v1 chain が参照する raw page
material を pure reducer/replay で exact に再検証し、全5 chain の terminal identity と bounds の
一致を要求します。各 page の authority binding は、chain 内の fence/pointer 非減少、同じ fence の
owner 固定、全 chain で同じ pointer revision の tuple 一致、receipt digest の revision 間再利用禁止を
検証します。5 terminal evidence/checkpoint root、chain/page ごとの authority trace、revision 順の
transition を canonical provenance digest に結合します。検証済み target preimage と
expected/observed/orphan target-key set から source/target candidate と target の projected/deleted を
決定的に構築し、不完全な chain、invalid row、重複 ownership、aggregate/binding/authority drift を
fail-closed で拒否します。
Managed AWS composition は public input を run/configuration/hash/limits に限定し、同じ measured
generation で migration-state、4 source、target table の incarnation を前後検証します。Artifact
GET より前に5つの terminal/nonempty head を強整合で固定し、invalid row、row/operation lower bound、
chain/全体 page 数を検査します。Source 固定順、target の順に remaining row/canonical-byte budget を
渡して committed exact object version だけを再構成し、pure join 後に同じ5 head の progress digest を
強整合で再確認します。Managed ceiling は total 100,000 rows、256 MiB canonical item bytes、
100,000 operations、全 chain 合計 `10_000` evidence pages です。Full ignored-page raw material は session
外へ返しませんが、join result の candidate は後続 plan に必要な source condition/target preimage を
含みます。

この head 再確認は sealed snapshot や writer fence ではありません。最終 head read の直後にも writer
または別 operator が状態を変え得るため、result は provisional な read-only evidence です。Historical
receipt を plan publish 前に検証するため、immutable receipt payload だけでなく owner、configuration
hash、migration-state TableId を保持する historical binding read を提供します。既存 plan seal v2 の
canonical schema は変更せず、その外側に sealed planning authority v1 を定義します。この compact root
は全6 TableId、plan seal/operation manifest/provenance artifact の exact version reference、
plan root/count、5 terminal progress digest、historical receipt binding digest/count、publish 時の
current authority tuple と adapter-owned time を結合します。Full provenance artifact は全 transition を
対応する historical receipt の owner/run/fence/digest/configuration/state binding に照合し、期限切れの
historical receipt は当時の証跡として保持しつつ canonical evidence window は検証します。Current
authority は fixed 60秒 lease と evidence window に加え、sealed time から atomic commit まで最低10秒の
headroom を要求します。
Provenance artifact は、raw item ではなく source planning v3 / target planning v1 evidence page の
canonical bytes を Base64 witness として保持します。作成時と parse 時の両方で全5 chain を zero head
から replay し、全 page の predecessor digest、checkpoint、authority tuple、terminal root を
provenance trace へ再導出します。同じ witness の digest-only row/binding から planning snapshot digest
と source/orphan operation count も再構成し、plan seal と照合します。これにより、terminal root だけを
残して中間 trace/receipt を再署名することや、別 capture の plan seal を混在させることを拒否します。
Artifact は64 MiBで fail-closed とし、evidence page に resume key（Binary key を含む）が入り得るため
raw artifact と同等に暗号化・最小権限・access audit の対象にします。この restricted immutable
provenance object は、recursive page proof のために migration-state 外へ cursor を保持する唯一の
許可された例外です。Standalone cursor、log、汎用 S3 evidence、外部 export には複製せず、object の
exact version 全体を一単位として取得・監査します。この ceiling を超える正当なrunをraw witness/receipt
から直接segment化し、complete manifestを実storageへ固定する経路は、後述のdirect staged builderと
planning専用storage gatewayで提供します。

Bounded planning-artifact foundation は、planned operation を完全な operation 境界で最大16 MiBの
content-addressed segment に決定的に分割し、最大256 referenceの manifest page predecessor chain と
compact head で0件から100,000件までを表現します。Provenance も evidence page witness と対応する
authority trace、historical receipt と対応する transition を完全な entry 境界で最大16 MiBに分割し、
exact-version predecessor chain の bounded manifest page と terminal page reference を持つ compact
head から元の semantic artifact を再構成します。Head の terminal reference だけを起点に `List` や
latest version lookup を使わず全 page reference を逆順に発見し、正順へ戻して検証できます。Plan側はrun、
configuration hash、plan root/count、plan seal digestを、provenance側はrun、configuration hash、
全6 TableId、snapshot/provenance/receipt digest/countを、それぞれ同種artifact内の全layerに結合します。
各graphはObject Lock期限を含む exact
`{objectKey, versionId, contentDigest, byteLength, retainUntil}` を保持し、同じgraph内のmissing、reorder、
gap、別role key、version差替え、byte/digest差替えを fail-closed にします。Planとprovenance相互、および
sealed authorityとのcross-artifact bindingはこのfoundationには含めません。

Codec-agnostic な single-object S3 core は、role-separated key、`If-None-Match: *`、exact owner、
full-object SHA-256、customer-managed SSE-KMS/Bucket Key、caller-fixed Object Lock COMPLIANCE期限を
Put後のversion-pinned Headとexact-version Getの両方で検証します。412とresponse lossはHeadの完全一致
だけを成功として回復し、ambiguous writeでabsenceを確認した場合だけconditional Putを1回再試行します。
個別retention headerに必要な `s3:PutObjectRetention` はCOMPLIANCE modeかつ30日以上31日以下に限定し、
bucket policyも範囲外のretentionを明示的に拒否します。S3の`LastModified`から実際のversion作成時点の
保持日数を再計算し、Put遅延後も同じ30日から31日の範囲に入ることをHead/Getで検証します。下限ちょうどの
deadlineがnetwork遅延で30日未満にならないよう、各conditional Put直前に30日とrequest timeoutの合計以上の
headroomを要求し、timeout時はtransportへ渡したAbortSignalで元のS3 Putも中止します。Ambiguous write後に
headroomが尽きた場合は入力不正へ戻さず、未解決のambiguous operationとして停止します。

この foundation は、既存のstrict validatorを通過した64 MiB以下のfull provenance artifactを受ける
compatibility builderに加え、raw canonical evidence pageとdurable historical receipt bindingから
legacy full-artifact envelopeを作らずに同じversion 1 segment bytesを生成するdirect staged builderを
持ちます。Direct pathは全5 chainをzero headからreplayし、全TableId、authority transition、receipt binding、
snapshot/countを再導出してから、segmentごとの16 MiBと総256 MiBをstorage I/O前にpreflightします。
Planning専用storage gatewayは、measured sessionから注入されるcodec非依存のimmutable object portだけを使い、
plan seal、全segment、predecessor-linked manifest page、compact headの依存順でuploadします。Plan replayは
sealとmanifest headのexact version referenceの組をrootとし、provenance replayはmanifest headのexact
version referenceだけをrootとして、`List`やlatest lookupなしで全page/segmentをversion-pinned GETします。
Caller-fixed retentionをgraph全体で共有し、write時の上限違反ではupload I/Oを開始せず、replay時も
全segment referenceを検証してからsegment GETを開始します。

このgatewayはAWS SDKに依存せず、clientやruntime entrypointを生成しません。Concrete managed AWS
sessionが同じpinned S3 client、measured configuration、generation上へgatewayをcompositionし、公開factoryは
`runId`だけを受け取ります。`close()`または再measurementでstaleになったgatewayは、top-level operationと
各`Put` / `Head` / `Get`の境界でfail-closedに停止し、消費中の`GetObject` bodyも直ちにcancelします。
ただしS3へ到達済みのCOMPLIANCE objectは削除せず、
non-authoritativeなretained orphanとして残る場合があります。`List`、latest version lookup、deleteは使わず、
artifact/rootだけではplanning/apply authorityになりません。

Direct writeはraw inputを最初のawaitより前にsnapshotするため、upload中のcaller mutationを採用しません。
Legacy replay APIはsegment graphからfull semantic artifactを再materializeしますが、direct builderは
64 MiBのlegacy envelopeを作らず、検証済みraw witnessからdetachedなcompact authority provenanceを
manifest headと同時に返します。Manifest-aware sealed planning authority v2は、既存v1を
read-compatibleなlegacy schemaとして凍結したまま、plan sealとplan/provenance manifest headのrichな
exact `{objectKey, versionId, contentDigest, byteLength, retainUntil}`、compact authority provenance、
plan/snapshot/count、全6 TableId、historical receipt binding、5 terminal head、publish時のcurrent authorityを
一つのcanonical rootへcross-bindします。3つのroot referenceは同じretention deadlineを持ち、role、
prefix、canonical bytes、digest、lengthを相互検証します。

Concrete managed AWS sessionは成功したmeasurementのdetached configurationと同じpinned DynamoDB transport上へ
v2 publication portをcompositionします。Publish直前にmigration-state、source 4 table、target tableの
incarnationを順に再検証し、lease/current pointer/current receiptの3 ConditionCheck、source 4 head、
target head、未作成immutable rootのPutを固定9 item transactionで実行します。Root keyとidempotency tokenは
それぞれrun/configuration/state bindingとexact canonical rootから決定的に作り、root itemにはstrict parserで
再検証できるcanonical bytesを保存します。新しいcommit timestampを採番する前にexact root keyを強整合で再読し、
既存root自身の`sealedAt`でstable caller inputを再構築したcanonical bytesが一致するときだけdurable retryの
成功として回収します。Pre-read直後の競合やraw transactionの応答消失でも再読時に同じ照合を行い、同じlogical
publicationを別attempt timestampから回収できます。Foreign/malformed root、stable input不一致、
state incarnation drift、condition位置ごとのauthority/head競合を区別してfail-closedにし、caller-owned
inputは最初のawaitより前にaccessor/Proxy/cycle/非canonical valueを拒否してsnapshotします。S3 graphは
このroot transactionが成功するまでnon-authoritativeであり、失敗時に到達済みのCOMPLIANCE objectが
retained orphanとして残っても再開authorityには採用しません。

Managed transportがtransaction後の6 table incarnation guardで
`SOURCE_DRIFT`、`TARGET_DRIFT`、`CONFIGURATION_DRIFT`、`INVALID_STATE`、またはtransient guard由来の
`AMBIGUOUS_OPERATION_UNRESOLVED`を返した場合、transactionはcommit-unknownです。この経路はdurable rootが
存在しても自動reconcileせず、同じinputをblindに再publishしません。Operatorは`close()`や再measurementより
前に、同じ旧measured portの`read(runId)`で旧bindingのrootを確認します。Rootが存在しても全6 table identityを
独立に再確立するまではquarantined/non-applyとして扱います。State driftやlifecycle invalidationで旧rootを
読めない場合は停止してescalateします。Root keyはconfiguration hashに束縛されるため、新しいmeasurementの
portから旧bindingのrootを参照できるとは限りません。

Application writer-fence v1 の durable foundation は、現行のexact physical bindingごとに
migration-state table上の1つのglobal control rowを持ちます。旧incarnationのrowは別keyに残ります。
Row keyとcanonical payloadはmigration-state tableの名前、TableId、ARN、作成時刻、account/regionから
導出したincarnation digestと、4 source、Workspace Search target、migration-stateの全6 TableIdへ
束縛します。Rowは`open`/`closed`と単調な`writerEpoch`/`controlRevision`を持ち、欠落、余分な属性、
非canonical payload、digest不一致、別table incarnationをfail-closedにします。Application側の
guard materialは、強整合で取得したexact open rowのcanonical bytesとdigestを同じDynamoDB transactionの
先頭でConditionCheckするためのものです。1 invocation内では同じguard tokenを固定し、失敗後に新しい
epochを取り直して同じmutationを継続してはいけません。Guard 1 itemを予約するため、application transaction
が使用できる残りの上限は99 itemです。

Application側のwriter guardは、設定された6つのexact table nameを最初の対象mutation時に独立して
`DescribeTable`し、同一account/region、`ACTIVE`、TableId、ARN、作成時刻を検証した後、migration-stateの
exact rowを強整合で取得します。取得はinvocation-local scopeで最初のPromiseを成功・失敗とも固定し、
並行mutationやretryが別epochを取り直すことを禁止し、異なるsourceが同じinvocationへ混在した場合も
再取得せずfail-closedにします。Guard materialはmigration-stateの完全な実測identityを持ち、
table name、TableId、incarnation digestを再検証します。Low-level `AttributeValue`のguard materialは
strict boundaryでnative DocumentClient valueへ変換し、guardをindex 0へ追加してから送信します。
Application itemの`NumberValue`、set、binaryはmarshalling semanticsを保ってdetachし、未対応classは
transport前に拒否します。Guard取得失敗はraw AWS errorやrow/table valueを記録せず、
`validation`/`authorization`/`upstream`と安全なcorrelation IDだけを内部診断へ出します。
`CancellationReasons[0]`のcondition failureはdomain conflict、idempotency reconciliation、retryより先に
terminalなwriter-blocked failureへ分類します。Application側の既存cancellation reasonはguard分のindexを
除いてdomain classifierへ渡し、guard outcomeが欠落または曖昧なtransaction failureはfail-closedにします。

Production Lambdaにはcanonicalなsource 4 table、Workspace Search target、migration-state tableの6環境変数と
明示必須のCloudFormation parameter `WorkspaceSearchWriterFenceMode`を設定します。初回open row bootstrap前の
二段階deployだけは`rollout-pending`を選び、bootstrap後の定常状態は`required`とします。対象writer roleだけが6 tableの
`DescribeTable`、state rowの`GetItem`、`TransactWriteItems`内のstate row `ConditionCheckItem`を持ち、
state rowのwrite権限は持ちません。Combined adapterを構築するread-only Lambdaにも同じstrict configurationを
渡しますがstate IAMは付与せず、将来誤ってfenced mutationへ到達した場合はguard取得前にfail-closedにします。
API、runtime-control worker、connector sync、SCIM group、webhook delivery/
authorization backfill、Work Item importはruntime admission後にinvocation scopeを開始し、Project Directory、
Work Items、Collaboration、Documents、Workspace SearchへのPut/Update/Deleteを含む全transactionへguardを
先頭追加します。単独mutationはtransactionへ変換し、application側の上限を99 itemに固定します。

Local Flociだけは、local HTTP endpoint、`MUKUROJI_LOCAL_AWS_RUNTIME=floci`、non-productionの3条件と
`local-floci-bypass` modeをすべて満たす場合にguard readを省略します。一般のremote endpointやproductionで
bypassは選べません。例外となる`rollout-pending`は、AWS Lambda markerが揃い、testでなく、endpoint overrideと
local markerがない実AWS形状でだけ選べます。このmodeでもSDK middlewareがProject Directory、Work Items、
Collaboration、Documents、Workspace Searchへのmutationをnetwork I/O前に拒否し、AppConfigが誤って
`enabled`へ戻ってもpre-fence writeへ退行しません。これは
AppConfig `disabled`と全writer drainを外部で証明した初回bootstrap window専用であり、guard済み状態、
migration実行可能状態、または#39の完了状態には数えません。Legacy Workspace Search backfillのwrite modeも同じinvocation guardを使用し、
local seed shellはlocal endpointとFloci markerがない場合に停止します。

このConditionCheckはlive TableIdをDynamoDB transaction内で問い合わせません。全6 TableId bindingは
guard token作成前の独立measurementとstrict row parseでrestore/replacement driftを検出しますが、
measurement後からtransactionまでの同名table差替えとはatomicではありません。Restore/replacementは
AppConfig `disabled`、writer drain、旧invocationの終了、全table再measurement、新incarnationの明示的
bootstrapを1つのsupervised changeとして実行します。このsupervisorが未実装の間はtable差替えと
guarded mutationを並行させず、TableId bindingだけでrestore raceを解決済みと扱いません。

Operator側のmanaged writer-fence portは、missing rowをepoch/revision 1へ進める一回限りの
`bootstrapOpen`、read、terminal-bound `release`を提供します。Bootstrapはfresh
lease/current pointer/current receiptの3条件とwriter-fence Putを固定4 item
transactionでcommitします。Closeはこのportへ公開せず、execution-boundary portが同じ3条件、exact open
writer-fence CAS、4 source + 1 target planning headのabsence、revision 1 boundaryのabsenceを固定10 item
transactionで同時commitします。Planning admissionも同じ3条件、exact closed fence、同じ5 head absence、
revision 1から2へのexact boundary CASを固定10 item transactionでcommitします。応答消失時はboundaryと
writer-fenceの強整合stable pairが同じlogical successorを証明した場合だけ成功として回収します。
同じmeasured AWS sessionはstate、4 source、targetのincarnationを各read前後、transition直前、
transaction後に固定順で再検証し、post-commit driftがあればそのmeasurementを隔離します。
Managed fence/boundary readとtransitionは1回の操作で複数の`DescribeTable`を実行します。
`TRANSIENT_INFRASTRUCTURE_FAILURE`からoperator操作を再試行するときはtight loopにせず、
AWSのthrottlingが解消する十分な間隔を空けてからfresh measurementとauthorityを取り直します。
既存の同一open/closed rowを返すread-only retryはdurable identityだけを証明し、その呼出時点のauthority
freshnessを再証明しません。Freshnessを必要とする次の操作ではcurrent authorityを改めて評価します。
Lease expiryやprocess crashでは自動openしません。`release`はv1 closed row、revision 2 boundary、
sealed authority、execution admission、verified rootまたは完全rolled-back rootを固定5 item
transactionで条件付け、全6 TableIdとterminal digestを持つversion 2のepoch/revision 3 open rowへ
exact CASします。並行呼出し、response loss、restartは同じpredecessorとlogical releaseだけを強整合
再読で回収します。Managed portは全6 tableの送信前後guardとgeneration quarantineを適用しますが、
operator CLIはterminal graphをfresh measurementと同一generationの強整合再読で確認し、明示的な
`release` approvalがある場合だけこのrelease primitiveを呼びます。自動releaseは実装せず、statusから
破壊的分岐を選択しません。

`bootstrapOpen`は初回guarded-code rollout専用であり、AppConfig `disabled`とfresh drain evidenceを
確認した状態でだけ実行します。State-table restore/replacementも同じmissing rowに見えるため、
current authorityがあることだけでrestore recoveryを自動承認してはいけません。新しいstate incarnationを
openにするにはdata/application ownerの明示的なrecovery判断を必要とし、supervisor実装までは手動gateです。
Deployは(1)明示的`rollout-pending`で配線/IAMと`disabled` AppConfig baselineを先行し、
(2)全entrypointの反映とdrainを確認し、(3)fresh authorityで`bootstrapOpen`し、
(4)parameterを`required`へ更新してguarded backfillと12個のstrict compositionすべての反映を確認し、
(5)新しい`enabled` revisionで再開する二段階とします。Webhook authorization backfill custom
resourceは両handler Lambdaへ明示依存し、event propertyとLambda環境のmode不一致をI/O前に拒否します。
Pending中のCreate/Updateはtable access前に短絡し、requiredへのproperty更新で初めてguarded
migrationを開始します。Deleteはv3 markerと両checkpointを強整合readし、stateが空ならwriteなしで
完了します。既存stateがあればdedicated rollback clientも通常のdurable open-row guardを要求し、
marker遷移、checkpoint、locator復元をguard付きtransactionで完了するまでresource削除を成功させません。
CloudFormation更新中はpending/required Lambdaが混在し得るため、
Step 2からStep 5までwriterを再開しません。`required`から`rollout-pending`へのdowngradeは通常rollback
として扱わず、state-table recoveryを含むowner承認の新しいmaintenance changeを必要とします。

CDKのProject Directory/Work Items初期seed custom resourceはstack作成時だけ実行するpre-fence bootstrap
boundaryです。Stack updateでは再実行せず、既存Workspaceのmaintenance writerとして使用しません。Runtimeで
継続するProject Directory、Work Items、Collaboration、Documents、Workspace Searchのmutation、
backfill、projection workerは同じConditionCheck付きtransactionへ統合し、bare Put/Delete経路を
廃止またはlocal-onlyに制限しています。新しい初期seedを追加する場合も、create-onlyであることをsemantic
CDK testに固定するか、通常のguarded writer pathを使用します。

Fence closeより先にlinearizeしたwriteを後続scanへ含め、closeより後のwriteをcondition failureにするには、
close後にsource/target evidenceとsealed planning rootを新しいrunとして取り直す必要があります。
Close前に取得したscan/head/rootをpromoteしてはいけません。またDynamoDB TTL service deleteはapplication
guardを通りません。Migration mapperはCollaborationの`expiresAt`とDocumentsの`expiresAtEpoch`を持つmapped
candidateをinvalidとしてfail-closedにし、既知のpresence/version/snapshot/delta/receipt/share support row
だけをmigration対象外として無視します。Project Directory、Work Items、Workspace Searchではmigration
identityにTTL無効を要求します。このdisjointnessはmapped rowの論理migration isolationを閉じますが、
物理tableのTTL support rowまで含むsnapshot isolationを主張するものではありません。

Resource identityの`measure`、writer-fenceのread-only `status`、初回だけの`bootstrap-open`を行う
control CLIと、single-flight heartbeat supervisorは実装済みです。Atomic close/planning admissionの
execution-boundary AWS portとmanaged-session capability gateに加え、exact revision 2 boundary、closed
writer-fence、sealed authority v2、fresh current authorityからrevision 1 `applying` stateを作る
execution-run contractと、同じmeasured sessionでそのstateをstrong read/createするadmission portも
実装済みです。Revision 1 admissionはimmutableなrootとして残し、各operation後の状態はその
`executionRunDigest`へ束縛した別のmutable execution-state rowへ保存します。このrowはexact canonical
bytes、revision、run-state digest、self digestを相互検証し、最初のoperationではabsence、以後は強整合で
取得したexact predecessorをCASして、admission自体を上書きしません。

Apply journal gatewayは、losslessなnative `AttributeValue` preimageをrun/configuration namespaceへ
immutable uploadし、`objectKey`、exact `versionId`、`contentDigest`、`byteLength`、`retainUntil`、
chain `headDigest`を持つrich referenceを返します。Readはlatest lookupを使わず同じexact versionを取得し、
canonical bytes、長さ、digest、retention、run/configuration/sequenceを再検証します。Mutationのjournalは
target transactionより前に保存しますが、そのobjectはoperation markerへ原子的に参照されるまでは
authoritativeなcommitted journalには数えません。

Apply progress AWS portは、lease/current pointer/receipt、closed writer fence、revision 2 boundary、
sealed authority v2、immutable revision 1 admission、rollback-start sentinelのabsence、mutable execution
state、source、target、operation-id markerを固定順で扱います。No-opはtarget ConditionCheckだけを行う
12 item transaction、mutationは同じ位置でconditional Put/Deleteし、さらにjournal-sequence indexを
追加する13 item transactionです。Sourceとtargetはjournal upload前にそれぞれ強整合Getし、planned snapshotのexact key、
canonical digest、全observed top-level `AttributeValue`を再検証します。Mutation journalのupload後は
all-six table incarnationを再検証してからfinal commit clockとtransactionを組み立てます。Conditionは
observed属性のequalityとschema-knownだが不在だった属性の`attribute_not_exists`を併用します。No-op/mutationの両方で
operation ID keyed markerをabsence Putし、mutationはsequence keyed indexも同じtransactionでabsence
Putします。応答消失または再起動後はmarkerを先に強整合readし、mutationではsequence index、mutable
successor、journal exact versionも相互検証して、同じcommitだけを成功として回収します。異なる内容で同じ
operation IDまたはsequenceを再利用した場合はfail-closedにします。

Apply checkpointを開始できるのは、sealed planの全operation markerがdurableになった後だけです。
Mutable execution-state v2はv1をread-compatibleに保ったまま、4 sourceとtargetのlosslessな
`LastEvaluatedKey`、累積counter/digest state、page countを保持します。Revisionはadmission、
operation count、全5地点のdurable page countから再導出し、1 transitionでexactly 1 pageだけ進むことを
検証します。Sourceは既存のmeasured strong Scan reducerを、targetは既存のowned/ignored/invalid
classificationをapply用のmapped/projected/ignored/invalid checkpointへstrictに変換して再利用します。

各checkpoint commitはcurrent authorityの3 ConditionCheck、closed writer fence、revision 2 execution
boundary、sealed authority v2、immutable execution admission、rollback-start sentinelのabsence、
mutable execution-stateのabsent/exact-predecessor CAS、immutable checkpoint receiptを固定10 item
transactionへ結合します。
Receipt keyはrun/configuration/state TableId/execution admission/location/expected revisionから決定し、
predecessor/successor state digest、successor run-state digest、canonical checkpoint、commit timeを
自己digest付きで保存します。応答消失またはprocess再起動後はreceiptとmutable stateを強整合readし、
exact successor、またはv2 revision arithmeticと単調checkpointが証明する後続stateだけを採用します。
Completed locationへの再呼出しは追加Scan/transactionを行いません。

Complete-plan apply sealは、immutable revision 1 admission、sealed planning authority v2、全6 TableId、
plan root/count、全operation marker aggregate、journal chain、terminal mutable execution-state v2の
revision/self digest/run-state digest、4 sourceとtargetのcursor-free terminal checkpointをcanonical
artifactへ固定します。Artifactはrun/configuration namespaceのObject Lock COMPLIANCE objectとして保存し、
`objectKey`、exact `versionId`、`contentDigest`、`byteLength`、`retainUntil`を持つrich referenceを
返します。SealのObject Lock期限はplan/provenance graphと同じshared retention horizonへ固定し、
Journalを持つrunでは最短journal期限がそのhorizonより早い状態を受理しません。Terminal target
checkpointのowned/projected件数はsealed source projected件数と一致しなければならず、exact
key/content一致は後続のfull verificationで判定します。

Apply完了transitionはmutable execution-stateを上書きせず、そのterminal v2 rowをexact predecessorとして
固定したimmutable applied rootを公開します。Transactionはcurrent authorityの3 ConditionCheck、closed
writer fence、revision 2 execution boundary、sealed authority v2、immutable execution admission、
rollback-start sentinelのabsence、terminal execution-stateのexact ConditionCheck、未作成applied rootの
Putを固定10 itemで結合します。
Applied rootはproduction sealとrich exact-version reference、predecessor digests、commit authority、
`applied` successor state、minimum journal retention、self digestを保持します。応答消失またはprocess
再起動後はdeterministic root keyを強整合readし、embedded sealとexact S3 version、terminal predecessorを
相互検証できる場合だけ成功として回収します。

Pure full-verification kernelはexact replay済みplanから、present sourceの
`{source key, source item, target key, put/delete}` pair、orphanのabsent source key、present targetの
`{target key, target item}` pair、delete後のabsent target keyを導出します。独立した4 sourceとtargetの
全5地点rescanは、page分割に依存しないpair accumulatorとterminal checkpointを保持し、計画上absentなkeyを
mapped/invalid classificationより先に拒否します。Unrelatedなrecognized support rowやTTL-managed rowの
apply後の増減は許容しますが、invalid row、pairの欠落・余剰・入替、stale targetは許容しません。Progressは
verification-plan digestへ固定し、completionはsource/orphan/total operation count、plan-seal rich reference、
complete apply seal、sealed planning authorityを相互検証します。このkernel result単体はimmutable applied
rootへまだ束縛されておらず、authoritativeな`verified` publicationではありません。Concrete AWS
state/evidence adapterはexact-version planを一度だけ再生し、applied rootを強整合readして、独立した
source/target rescanの完全progressをmutable stateとimmutable page receiptへ固定10 item transactionで
保存します。Stateはapplied rootからterminal revisionまでpredecessor state/command digestで連結し、
再起動後のpublic readでも全receipt chainを再検証します。Terminal publicationはcomplete apply sealと
semantic verification-result envelopeをexact versionで再読し、`{appliedRootDigest,
verificationResultDigest}`、terminal state/receipt、sealed authority、current authorityをimmutable
verified rootへcross-bindする固定10 item transactionです。両transactionはrollback-start sentinelの
absenceも条件検査します。応答消失時はstate/receiptまたはroot/result artifactの完全一致だけを
成功として回収します。

Partial-prefix rollback用のpure apply sealは、operationをまだcommitしていないimmutable
execution admission、mutable execution-state v1、checkpoint traversalを含むv2のいずれもstrictに受理し、
admission/state digest、marker accumulator、journal chain、planと全TableIdへ`committed-prefix` scopeを
固定します。専用AWS gatewayはcanonical bytesをcontent-addressedなObject Lock COMPLIANCE objectへ
保存し、run/configuration-boundな`objectKey`、exact `versionId`、`contentDigest`、`byteLength`と
seal作成時刻に固定したretention deadlineを相互検証します。Planが古くてもseal自身には新しい保持期間を
与え、同じsealの応答消失retryは同じdeadlineとexact versionへ収束しますが、rollback startと各reverse
stepでは元journal exact versionの残存期限を別途検証します。Immutable uploadがDynamoDB transactionへ
参照される前に失敗したretryはretained orphanを増やし得るため、object locator/version/digest/期限と
件数・費用を運用evidenceへ記録し、authorityへ採用せず保持期間満了後のcleanup対象として追跡します。
全apply operation/no-op/checkpoint/complete-seal transactionに加え、full-verificationのpage progressと
verified-root publication transactionも共通rollback-start sentinelのabsenceを検査するため、rollback
startが先にcommitした後のforward progressは成立しません。
Committed-prefix専用のv2 pure persistenceは、admissionまたはmutable v1/v2 predecessor、rich plan/seal
reference、最短journal retention、immutable origin、rollback start root、losslessなrollback lifecycle
state、deterministic reverse command、immutable operation receipt、terminal rolled-back rootをstrict
canonical codecへ固定します。各reverse transitionはcommand、pure reducer successor、logical rollback
marker、durable receiptを再導出し、journal sequence/head、causal chronology、retention、authority successorを
検証します。非空prefixのfinishはsequence 1のterminal receipt、zero-mutation finishはnull receiptへ固定
します。Apply-owned predecessor capabilityはmutable execution-stateと
applied rootを強整合readし、admissionならstate row absence、mutable v1/v2ならcanonical controlled
full-row equalityのConditionCheckを生成します。Partial start側のapplied-root absence条件も共通factoryで
定義済みです。Standalone partial-start AWS portはapply predecessorとapplied rootを強整合readし、
同じshared sentinelへexact predecessor、applied-root absence、full-verification state/root absence、
v2 start/stateを固定13 item transactionでcommitします。応答消失と再起動時はstrictなstart/stateの
coherent reread、論理winner照合、winnerが固定したsealのexact-version再読とcanonical bytes照合で
成功を回収します。開始後のread/retryはstart/state/rolled-back rootを強整合point readで最大3回観測し、
連続2回一致したadvanced rollingまたはterminal lifecycleだけを返します。Standalone v2 reverse portは
lease/pointer/maintenance receipt、closed writer fence、planning boundary、sealed authority、
execution run、start full row、state exact-predecessor CAS、apply sequence/marker、target preimage CAS、
immutable receiptを固定13 item transactionへ結合します。Finishは同じcontrol root、zero-head state CAS、
immutable rolled-back rootを固定10 item transactionへ結合します。Receipt/lifecycleのtorn read、
transaction応答消失、同一targetの後続rollback、target read直前のwinnerをbounded rereadで回収し、
terminal rootとsequence 1 receiptをcanonical bytesまで相関します。Partial-startとv2 reverse/finishを
同一managed sessionへ束縛するcompositionも実装済みで、同じpinned DynamoDB/S3 client、
all-six table incarnation guard、S3 sealとDynamoDB transactionのpost-send quarantineを共有します。
Control CLI/coordinatorはpartial-prefix rollbackとterminal releaseを明示commandへ接続済みです。
ただし、observability、DR、承認済みnon-production evidenceが揃うまではpartial-prefix rollbackを
production capabilityとして扱いません。

Complete applied rootから開始するstandalone reverse-rollback AWS portは、immutable start root、
restart可能な完全run-state、exact-predecessor CAS state、各reverse operationのimmutable receipt、
terminal rolled-back rootをstrict canonical rowとして保存します。Rollback startはfull-verification
state/rootのabsenceを、full verificationのpage/publicationはrollback-start sentinelのabsenceを同じ
transactionで条件検査し、同一runのverify/rollback開始raceをfail-closedにします。各reverse stepは
adapterが次のjournal sequenceとoperation identityを決定し、apply sequence receiptとoperation markerを
強整合再読・完全行条件で固定して、Object Lock上のexact journal versionからnative DynamoDB
key/preimage/postimageを再構成します。Start時の最短journal期限と各stepのexact `retainUntil` は、最終
transaction時刻からminimum commit windowを超えて残っていなければなりません。Targetがpost-apply
snapshotと完全一致する場合だけpreimageへCAS復元し、measured TTL属性を含むknown schemaの追加raceも
拒否して、start/step/finishをそれぞれ固定12/13/10 item transactionでcommitします。個別の強整合read間に
transactionが成立した場合はbounded coherent rereadで安定snapshotを取得します。応答消失、process再起動、
旧revision retryはdeterministic command、immutable receiptとroot-boundなcurrent successorまたは後続state
の一致だけを成功として回収し、同一commandの競合attemptが異なるtrusted timestampを選んでもlogical
winnerを受理します。このportはcomplete applied rootだけを対象にし、writerを再openしません。部分apply
prefixからのdurable start、実行supervisorとterminal releaseは別途必要です。

DynamoDB ConditionExpressionには、itemの未知のtop-level属性名を列挙せずに「完全な属性集合」を比較する
primitiveがありません。したがって、強整合read後からtransactionまでにplanned itemにもknown schemaにも
ない属性を追加するwriterが存在すると、その追加を完全CASすることはできません。Application writer fence、
対象tableのmutation権限分離、全合法top-level名のknown schema列挙、apply attempt内の強整合read、
journal upload後かつtransaction前のall-six incarnation再検証を一体のinvariantとします。強整合read後にも
未知属性を追加できる別writerを排除できない環境では、このapply portを安全なproduction authorityとして
使用しません。

Managed resource-identity compositionは、同じmeasurement generation、pinned DynamoDB client、private
immutable-artifact portからjournal/apply-seal gatewayとapply operation/checkpoint/seal portを構築します。各strong read、
source/target checkpoint Scanの前後と
transaction直前にall-six-table incarnationを再検証し、送信後の成功・error pathで再検証できない場合は
shared execution-control generationをquarantineして`AMBIGUOUS_OPERATION_UNRESOLVED`を返します。この
post-send quarantineをstandalone adapter内の通常のresponse-loss retryへ戻しません。同じguardを持つ
full-verification portもmanaged session内で、raw pageを1 Scanだけ取得するprivate source/target
reducer、plan/apply-seal/result artifact gateway、applied-root strong read、
state/receipt/verified-root transactionへcompositionします。ただし、現時点ではこれらのmanaged
apply/verification capabilityをcontrol CLIまたはpost-close orchestratorへ公開していません。同じ
managed sessionはcomplete applied root向けrollback portもcompositionし、同じpinned DynamoDB/S3
client、all-six table incarnationのread前後検証、transaction直前検証、post-send quarantineを適用します。
Applied root、applied run state、apply sequence/marker、exact journal version、rollback state/receipt/root、
target CASはsession外へraw transport capabilityを公開せずに結合します。
Committed-prefix向けrollback portも同じmanaged session内でpartial-start、reverse、finishをcompositionし、
committed-prefix sealのS3 write前後、exact journal read前後、各DynamoDB read前後とtransaction直前に
all-six guardを適用します。Sealまたはtransaction送信後にtable identityを再確認できない場合はshared
execution-control generationをquarantineし、standalone adapterのresponse-loss回収へ戻しません。
Close後planning supervisorは、同じheartbeat leaseの下でrevision 1 close、close時刻以後に始まる
15分以上のzero-mutation drain、revision 2 admission、durable headからの4 source＋target再取得、
private cursor witnessからのprovenance保存、plan保存、fresh current authority付きsealed root publicationを
順に実行します。
初回close前のartifact retentionはmeasured default retention、S3 request timeout 10秒、必須drain 15分を
含む下限からdefault retention＋1日までに制限し、close authority更新後かつwriter close直前にも同じ
条件を再検証します。各immutable Put直前の通常のretention再検証も維持します。Plan epochはrevision 2の
`admittedAt`とreviewed dry-runの`completedAt`の遅い方から決定し、同じdurable inputでは再起動後も固定し
つつ、fence後に再作成したdry-runを受け付けます。sealed root publicationと同じmanaged clockより未来の
dry-run完了時刻はread-only root recoveryの後、lease取得とcloseより前に拒否します。
Crash時はsame-fence maintenance pointerとrevision 1/2、5 head、sealed rootから再開し、
signal、heartbeat failure、回収不能なresponse loss、session quarantine後に次のtop-level operationを
開始しません。Control CLI/coordinatorはこのplanning supervisorとapply/seal/verification/rollback
execution supervisor、terminal releaseを明示stageごとに接続します。自動rollback/releaseは行いません。
Migration専用のsecret-free telemetryと5 alarmは実装済みです。Restore/failover/DR drill、
承認済みnon-production実行およびalarm delivery evidenceは未完了のため、Production migration gateは
閉じたままです。

現行のmanaged compositionでは、成功する非終端checkpoint 1ページにつき論理上182回の
`DescribeTable`を実行します。Managed `DescribeTable` rate-policy registryはaccount＋regionをscopeとし、
review済みpolicy version、window/lifecycleごとのcall capacity、exact 182回の固定page reservation、
さらにall-six cleanup recovery専用の6回分を要求します。したがってlifecycle capacityは
`page reservation + 6`以上でなければならず、通常page/attemptは最後の6回を消費できません。
boundedなattempt/page cadence、jitter/backoff上限、budget stop条件も明示値として要求します。同一scopeの
callはsingle-flightでaccountingし、barrier、FIFO predecessor、durable checkpoint CAS、cadenceを含む
total admission deadline内に次のdata I/Oまたはpageを予約できなければfail-closedで停止します。
[AWS公式のread-only control-plane上限](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)
である2,500 requests/secondはservice側の上限であってdefault policyではありません。実行環境ごとに
reviewした明示値がないpolicyを受理しません。SDK内の見えないretryでbudgetを超過しないよう、`DescribeTable`は専用の
`maxAttempts=1` transportだけを使い、throttle後のjitter/backoffと再attemptはregistryが管理します。
Transportはcaller指定endpointを受け付けず、regionからpartition-awareな公式DynamoDB endpointを内部導出します。
Ambient default chainは受け付けず、upstreamのmanaged identityで実測したstatic credentials、または
refresh-capableな固定providerだけを受け付けます。Providerはconstruction時にcaptureし、解決のたびに
allowlist済みscalarをsnapshotして、coordinatorから渡すaccountと同じ`accountId`を要求します。
このmoduleは宣言値の一致を検証しますが、STS measurement自体は行いません。Production compositionだけが
選択済みnamed profileのimmutableなstatic/AssumeRole planを保持し、refresh前後で同じ実測accountへ束縛します。
各callはaccount/regionと固定transport descriptorへ結合したnominal one-shot capabilityとして渡し、
任意callback内の複数SDK callや、別scopeのtransportを1 permitとして実行できない形にします。

Write-ahead CAS前のqueued admissionは消費しません。CASでchargedになったattemptまたはpage reservationは、
deadline/interruptionによりphysical callbackが始まらなくても保守的に消費・保持し、明示recoveryまたは
takeover時のforfeit対象にします。Physical callbackが始まったattemptはresponseの成否にかかわらず
消費済みです。Registryはcaller指定digestを受け付けず、account/regionからpolicy非依存のcanonical scope-binding
digestを内部導出します。Checkpointにはこのdigest、完全なpolicy、公式endpoint/operation/`maxAttempts=1`の
transport-binding digestを結合し、明示bootstrap時だけabsent predecessorを作成します。Page callback前に
review済みpage capacity（現行baselineは182回）をwrite-ahead予約し、各one-shot transport実行前にも
reservation-to-attempt遷移と
`attemptInFlight=true`をCAS保存し、完了後に別CASでfalseへ戻します。
Absent ledgerは初回作成とstate table消失・差替えを識別できないため、明示bootstrapでも最初の物理送信前に
window、attempt/page interval、最大throttle backoffの最大値を全量待ちます。Reviewed policy parserは
total admission deadlineがこのsafety horizon以下のpolicyを拒否し、bootstrap直後に必ずcadence-boundとなる
設定を永続化させません。
Attempt/page cadenceの開始時刻はadmission判定時ではなく、対応するwrite-ahead CAS成功後、
物理transportまたはpage callbackの直前にmonotonic clockから取得します。CAS待ち時間をintervalへ
先取りせず、CAS遅延後に連続送信または連続page開始できる扱いにはしません。
Process restart/takeoverで残ったpage reservationは解放せずlifecycle capacityへ保守的にforfeitし、
window、attempt/page interval、最大throttle backoffの最大値を、新processのmonotonic clockから全量待ちます。
CheckpointのUTC時刻はmetadataだけに使い、clock skewを根拠にこの待機を短縮しません。CAS response lossは
各CAS固有の暗号学的write nonceを含むexact checkpointを再読できた場合だけ成功扱いとし、別writerが
同じrevision/counterを書いた競合を自分の応答欠落として回収しません。競合・不一致・不明な結果はtransportを
呼ばずquarantineします。Page reservation、mandatory cleanup要回復marker、in-flight attempt markerは
checkpointで直交して保持します。失敗したcleanup、またはcleanup中に中断したprocessはmarkerを消さず、
権限付きclaim後も専用recovery callbackの成功CASまで通常page/attemptを拒否します。完了不明attemptも
権限付きrecovery callbackが旧owner停止を確認してmarkerをclearするまで新規transportを拒否します。
物理attempt完了後のclear CASを開始してから成功確認するまで、同一processで既にqueue済みのcall、page、
checkpoint readも拒否します。Clear CASの作成・保存・応答確認が失敗した場合はin-flight markerを保守的に
復元し、より高いfenceの明示recoveryを要求します。
Mandatory cleanup中のtakeover/interruption免除はtaskへ渡すcleanup専用capabilityだけに限定し、同じpageや
lifecycleから並行して開始した無関係なcallには継承しません。元のpage内cleanupはpage reservationから
最大6回、restart後のcleanup recoveryは保護した6回分から実行します。いずれもcallback開始前に6回分を
一括preflightし、callbackがsuccess/rejectionのどちらでsettleしても、それ以前に許可済みの子attemptを
合流してからmarkerとbarrierを処理します。Recoveryがcold-start horizon、window、backoffで物理送信前に
停止した場合は同じfenceで再試行できます。一度でも送信したattemptはthrottleを含めて消費済みでrefundせず、
そのrecovery callbackが失敗した場合はquarantineします。
Lifecycle/page/cleanup capabilityのaccounting stateとauthority tokenはECMAScript private stateに保持し、
instance/class/prototypeを固定し、constructorはmodule-private construction keyを要求します。
Controllerはmodule内でcaptureしたexact methodだけを使い、
callbackからのreflectionやprototype差し替えでbudget、page reservation、cleanup 6回上限を変更できません。

Production compositionは公式STS `GetCallerIdentity`で実accountを確認してから初めてrate checkpointを
load/write/claimし、専用`maxAttempts=1` transportへ同じ固定profile providerを渡します。Static profileは
detached credentialsを再利用し、一時credentialsはimmutableな選択済みAssumeRole planから期限前にrefreshして、
各解決結果を実測accountへ再束縛します。同じrate lifecycleと
FIFO gateをmain sessionとfresh subordinate measurementで共有し、child closeはledgerをclaim/closeしません。
Source planning page、target planning page、apply checkpoint、verification page、partial rollback step、
complete rollback stepは、各delegateの最初のdata I/Oより前にexact 182回を予約します。
Lease/heartbeat、all-six pre-send read、successor rate-fence claimは
同じFIFOのnon-page operationとしてpageと並行しません。Irreversible send後のmandatory all-six guardは
interruptionをdeferして完了し、session closeはadmitted ownerをdrainしてから専用transportを一度だけ閉じます。

Resume、lease takeover、replacement measurementでも同じscopeの消費を初期化せず、session quarantine後は
新しい予約を拒否します。同一transition内でもstrong read、Scan、transactionの前後という時点保証をまたぐ
incarnation結果はcacheまたは再利用せず、all-six replacement detectionとpost-send quarantineを維持します。
今回、実AWS accountでrateを実測したevidenceは取得していません。Telemetryは#158の
attempt/throttle/cadence wait/budget stopをconfiguration hash、policy version、UTC window、
correlation/evidence locatorへ集約し、5 alarmがthrottle、budget exhaustion、checkpoint stall、
quarantine、terminal failureを検知します。承認済みnon-production rehearsalと両SNS delivery receiptは
#167へ引き継ぎます。これらのreview済みevidenceが揃うまでProduction migration gateを閉じたままにします。

Pure execution-boundary contractは、exact closed fence digest/authorityと全6 TableIdを持つ`closed` revision 1、
fresh current authority、exact raw maintenance evidence、close後15分以上のdrainを持つ
`planning-admitted` revision 2だけをcanonical bytes/digestとして受け付けます。Source planning v3 と
target planning v1 には、close/admission transactionで同じrun/configuration/TableIdのhead未作成を固定する
ConditionCheck factoryがあり、terminal headには完全なidentity、chain version、checkpoint、recursive head
digest、`completed=true`を比較するfactoryがあります。Exact closed writer-fence rowとsealed planning
authority v2 rootに加え、exact planning-admitted execution boundaryのcanonical bytesを固定する
ConditionCheck factoryもあります。Fixed 10 item transactionへcompositionするexecution-boundary AWS
portと、lease/pointer/receipt、closed fence、revision 2 boundary、sealed root、未作成execution-run rowを
固定順の7 item transactionへcompositionするinitial execution-run admission portは、いずれも
managed-session capability gateに束縛しています。Apply portはこれらのexact condition
factoryとrollback-start sentinelのabsenceをoperationの12/13 item、checkpointの10 item、
complete sealの10 item transactionへ再利用し、managed
resource-identity compositionにも接続済みです。Post-close planning supervisorとexecution supervisorは
operator CLIの互いに独立した明示stageへ接続済みです。CLIはstatusから次stageを自動選択せず、rollback
またはreleaseを明示approvalなしで開始しません。

Sealed planning authority v2 の原子的publication、durable writer-fence row、application writer guardに加え、
planning supervisorがhistorical receipt、current authority freshness、revision 2、5 terminal head、
provenance/plan storageを同じrun/configuration/全6 TableIdへ固定します。Terminal-bound release
primitiveも、exact boundary、sealed authority、execution admission、verifiedまたは完全rolled-back
rootを同じclosed predecessorへ原子的に固定します。Mutating coordinatorはcomplete
apply/verify/rollback/release supervisorを別stageとして接続します。
Digest-only な dry-run v1 と legacy planning v2 は process を越えた planning input、target join、
rollback preimage を再構成しません。これらの未実装項目を完了し、non-production で
artifact upload orphan、version substitution、cursor 境界の中断再開、verify/rollback evidence を
取得するまで production migration gate は閉じたままとし、既存 backfill は dry-run と
maintenance-window 内の再生成用途に限定します。残る未完了項目にはrestore/failover/DR drill、
承認済みnon-production実行・alarm delivery evidence が含まれます。

### Migration control CLI foundation

CLIは環境変数やAWS resourceの自動探索を使いません。Account、region、named profile、review済み40文字
commit OID、6 table、journal bucket、journal KMS key ARNを毎回明示し、既存のmeasured AWS sessionで
STS、table incarnation、PITR、TTL、journal/KMS設定を再測定します。CDK outputの
`WorkspaceSearchMigrationStateTableName`、`WorkspaceSearchMigrationJournalBucketName`、
`WorkspaceSearchMigrationJournalKeyArn`と各domain table outputを使用します。Operator policyは
`WorkspaceSearchMigrationOperatorPolicyArn`として出力されますが、自動attachされないため、承認済みの
operator roleへchange recordに従って明示的にattachします。

利用可能なcommandと完全なflag名は、raw argumentをechoしないmachine-readable helpで確認します。

```sh
bun run --silent search:migration:control -- help
```

同じreview済みresource selectionをshell arrayへ固定し、まずread-only measurementを実行します。

```sh
MIGRATION_RESOURCE_FLAGS=(
  --account "$MIGRATION_ACCOUNT"
  --region "$MIGRATION_REGION"
  --profile "$MIGRATION_PROFILE"
  --commit "$REVIEWED_COMMIT_OID"
  --project-directory-table "$PROJECT_DIRECTORY_TABLE_NAME"
  --work-items-table "$WORK_ITEMS_TABLE_NAME"
  --collaboration-table "$COLLABORATION_TABLE_NAME"
  --documents-table "$DOCUMENTS_TABLE_NAME"
  --workspace-search-table "$WORKSPACE_SEARCH_TABLE_NAME"
  --migration-state-table "$WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME"
  --journal-bucket "$WORKSPACE_SEARCH_MIGRATION_JOURNAL_BUCKET_NAME"
  --journal-key-arn "$WORKSPACE_SEARCH_MIGRATION_JOURNAL_KEY_ARN"
  --rate-policy-file "$REVIEWED_DESCRIBE_TABLE_RATE_POLICY_FILE"
)

bun run --silent search:migration:control -- \
  measure "${MIGRATION_RESOURCE_FLAGS[@]}" \
  --rate-bootstrap true
```

`--rate-policy-file`はcanonicalなreview済みpolicyを全commandで必須とします。上の
`--rate-bootstrap true`はaccount/region ledgerが存在しない最初の1回だけ、別途のowner承認後に指定し、
既存ledgerには指定しません。Crash evidenceが`mandatoryCleanupRequired`または`attemptInFlight`を保持する
場合だけ、それぞれ`--rate-recover-interrupted-cleanup true`、
`--rate-recover-interrupted-attempt true`を明示します。2つのrecoveryは同時指定できますが、bootstrapとは
同時指定できません。`measure`、`status`、`execution-status`はmigration mutation capabilityを持ちませんが、
全`DescribeTable` attemptのdurable rate accountingは更新します。

`measure`が返した`configurationHash`をresource identity、PITR、change recordと独立にreviewしてから、
同じhashをread-only `status`へ渡します。Hashが変わった場合はlease取得やmutationより前に停止します。

```sh
bun run --silent search:migration:control -- \
  status "${MIGRATION_RESOURCE_FLAGS[@]}" \
  --expected-configuration-hash "$REVIEWED_CONFIGURATION_HASH"

bun run --silent search:migration:control -- \
  execution-status "${MIGRATION_RESOURCE_FLAGS[@]}" \
  --expected-configuration-hash "$REVIEWED_CONFIGURATION_HASH" \
  --run-id "$MIGRATION_RUN_ID"
```

`bootstrap-open`は初回guarded-code rollout専用です。AppConfig `disabled`、全surfaceの15分以上の
zero-mutation drain、fresh maintenance evidence、data/application ownerによるexact incarnationの承認が
揃った場合だけ実行します。State-table restore/replacement後のmissing row、reopen、terminal recoveryへ
流用しません。

```sh
bun run --silent search:migration:control -- \
  bootstrap-open "${MIGRATION_RESOURCE_FLAGS[@]}" \
  --expected-configuration-hash "$REVIEWED_CONFIGURATION_HASH" \
  --run-id "$MIGRATION_RUN_ID" \
  --owner-id "$PROCESS_UNIQUE_OWNER_ID" \
  --maintenance-evidence-file "$MAINTENANCE_EVIDENCE_FILE" \
  --approval initial-writer-fence-bootstrap
```

Cutoverは共通のhash/run/owner/evidenceを毎回再指定し、各processをfresh sessionとして起動します。
`PROCESS_UNIQUE_OWNER_ID`はinvocationごとに新しくしてこのarrayを組み直し、前processのleaseが自然失効して
旧operationが停止したことを確認してから次invocationのtakeoverを開始します。

```sh
MIGRATION_MUTATION_FLAGS=(
  "${MIGRATION_RESOURCE_FLAGS[@]}"
  --expected-configuration-hash "$REVIEWED_CONFIGURATION_HASH"
  --run-id "$MIGRATION_RUN_ID"
  --owner-id "$PROCESS_UNIQUE_OWNER_ID"
  --maintenance-evidence-file "$MAINTENANCE_EVIDENCE_FILE"
)

bun run --silent search:migration:control -- \
  close-replan "${MIGRATION_MUTATION_FLAGS[@]}" \
  --reviewed-dry-run-file "$REVIEWED_DRY_RUN_FILE" \
  --retain-until "$REVIEWED_RETAIN_UNTIL" \
  --max-total-rows "$REVIEWED_MAX_TOTAL_ROWS" \
  --max-total-canonical-item-bytes "$REVIEWED_MAX_TOTAL_BYTES" \
  --max-plan-operations "$REVIEWED_MAX_PLAN_OPERATIONS" \
  --approval close-writers-and-replan

bun run --silent search:migration:control -- \
  apply "${MIGRATION_MUTATION_FLAGS[@]}" \
  --approval apply-sealed-migration-plan

bun run --silent search:migration:control -- \
  verify "${MIGRATION_MUTATION_FLAGS[@]}" \
  --approval verify-complete-applied-root

bun run --silent search:migration:control -- \
  release "${MIGRATION_MUTATION_FLAGS[@]}" \
  --approval release-application-writers
```

Apply中断後に明示的にcommitted prefixを戻す場合は`rollback-partial`と
`rollback-committed-apply-prefix`、complete applied rootを戻す場合は`rollback-complete`と
`rollback-complete-applied-root`を使います。`execution-status`でexact durable phaseをreviewしてから
該当する片方だけを実行し、terminal rollback rootを確認した別 invocationで`release`します。Coordinatorは
指定したstage境界だけを進め、次stage、自動rollback、自動releaseを選択しません。

Bootstrapはlease取得後、task開始前に一度heartbeatして60秒windowを回復し、その後durable
`heartbeatAt`を基準に最大20秒間隔のone-shot heartbeatを実行します。前のheartbeatが完了するまで次を
開始せず、同じrun/owner/fenceだけを維持します。Heartbeatはmaintenance receiptの5分freshnessを延長
しません。Heartbeat failure、`SIGINT`、`SIGTERM`では新しいoperationを開始せず、進行中transactionの
response-loss reconciliationと開始済みheartbeatを待ってからsessionを一度だけcloseします。Leaseを削除、
自動takeover、自動rollback、writer reopenは行わず、自然失効させます。CLIのoperation result/error
JSONLはschema/operation/status、stable code、configuration binding/hash、policy version、secret-freeな
writer-fence/execution/coordinator status、identifier-free rate aggregateに加え、terminal result/errorと
同じ1行のtop-level EMFとして`OperationCount`、checkpoint progress、DescribeTable
attempt/throttle/wait/budget stop/exhaustion、quarantine、terminal failureの固定metricを出します。
5分のlive checkpoint stallは、完了待ちでalarmを遅延させない独立EMF行を即時出力し、final recordでは
同じstallをmetricとして二重計上しません。初回`measure`がconfiguration hash取得前に失敗した場合だけ、
`configurationBinding=unbound`、hashなし、policyとprocess correlation由来のopaque evidence locatorで
rate/terminal failureを出します。Helpは固定commandと
resource flag名だけを出します。いずれもraw AWS error、ARN/name、profile、evidence path/bytes、
run/owner ID、cursor、tenant dataを出しません。
Process exit statusは、成功を`0`、migration failureまたは`OPERATION_FAILED`を`1`、
`INVALID_USAGE`/`INPUT_FILE_INVALID`/`INPUT_FILE_UNREADABLE`を`2`、`SIGINT`による
`INTERRUPTED`を`130`、`SIGTERM`による`INTERRUPTED`を`143`として固定します。

Versioned release primitiveはterminal `verified`または完全な`rolled-back` outcomeへ束縛したmanaged
capabilityです。CLIの`release`はfresh evidence、同じgenerationのterminal reread、exact approvalを再要求し、
同じlogical releaseのresponse lossだけを回収します。

### Entry gate

1. STS と `DescribeTable` から実測した source/target account、region、table ARN/ID、作成時刻、
   対象 scope、migration version、実行 commit を固定し、configuration hash を保存する。
   承認済みnon-production accountで、実行commit、rate-policy version、UTC window、page phaseごとの
   attempt/throttle/cadence wait/budget stop、最大同時in-flight数、observed rateを同じconfiguration hashへ
   結合して記録する。Telemetry/alarm contractは実装済みですが、この記録は今回まだ取得しておらず、
   #167のrehearsalで取得・reviewする。Contractにより取得可能であることを取得済みの
   evidenceとして扱わず、review完了までProduction migration gateを開かない。
2. PITR/backup、earliest/latest restorable time、source 件数、代表 key/checksum を保存する。
3. Dry-run の scanned/projected/deleted/skipped/invalid 件数を review する。Dry-run evidence は
   lease/fenceを持たないため、planning source evidenceとして再利用しない。
4. 初回guarded-code rolloutでは、まずAppConfig `disabled`でwriterを止めて初回drain evidenceを取得する。
   そのevidenceを使い、Owner/run ID付きglobal leaseとheartbeatを取得し、fresh immutable maintenance
   receiptをcurrent pointerへcommitする。Cutover前にもlease/receiptをrenewしてcurrent authorityを
   解決する。`bootstrapOpen`/`close`、close後のdrain、再planningを、このlease/current pointer/current
   receiptがcommitされる前に開始してはいけない。初回deployは明示的`rollout-pending`、drain中の
   `bootstrapOpen`、全12 compositionの`required`反映確認の順で行い、途中でwriterを再開しない。
   Application writer guardの永続化境界、runtime配線、初回bootstrap用control CLIとheartbeatに加え、
   writer-fence closeとrevision 1 execution boundaryを同時commitし、post-close planning admissionを
   revision 2へ進める固定10項目AWS transactionとmanaged-session capability gateは実装済みです。
   Exact revision 2 boundary、closed fence、sealed root、fresh authorityを固定したrevision 1
   execution-run stateのstrong read/createと固定7項目admission transactionも実装済みです。ただし、
   admission時にはshared Object Lock deadlineまで実測default retentionの30日すべてが残っていることを
   create/parse/commit直前に要求し、不足するsealed planは再planningします。
   Immutable rich journal reference、admission-rooted mutable execution state、source/targetの強整合readと
   known-attribute CAS、operation marker/sequence indexによるresponse-loss reconciliation、rollback-start
   sentinelのabsenceを含む固定12/13項目のoperation transactionに加え、v2 traversal state、
   source/targetのbounded strong Scan、immutable checkpoint receipt、固定10項目checkpoint transaction、
   terminal checkpoint/execution digest-bound complete-plan apply seal、固定10項目のimmutable applied-root
   transaction、そのmanaged identity
   composition、all-six pre/post guard、post-send quarantineも実装済みです。さらに、exact plan replayと
   applied-root strong read、独立rescanのresumable state/immutable receipt、semantic result artifact、
   immutable verified root、固定10項目transaction、response-loss reconciliationを持つfull-verification
   AWS portとmanaged identity compositionも実装済みです。Complete applied rootを対象に、verifyとの
   start排他、strict durable state/receipt/root、exact apply-receipt guard、journal preimageのreverse
   target CAS、固定12/13/10項目transactionを持つrollback AWS portと、pinned DynamoDB/S3 client、
   all-six pre/post guard、post-send quarantineを持つmanaged identity compositionも実装済みです。
   Committed-prefix向けにはstrict v2 origin/start/lifecycle-state/command/receipt/rolled-back-root codec、
   pure reverse/finish transition、apply-owned exact predecessor guard、complete applied-root absence guard、
   shared rollback-start sentinelとv2 stateを同時commitする固定13項目のstandalone partial-start
   transaction、advanced/terminal lifecycleのcoherent retry、固定13項目のstandalone reverse transaction、
   固定10項目のstandalone finish transactionに加え、同じpinned DynamoDB/S3 client、all-six
   pre/post guard、S3 sealとDynamoDB transactionのpost-send quarantineを共有するmanaged identity
   compositionまで実装済みです。Close、post-close admission、planning evidence再取得、
   plan/provenance保存、sealed root publicationのrestart-safe supervisorと、run creation/apply/seal/
   verification/rollback、terminal releaseを明示stageへ接続するCLI/coordinatorと、Service-only EMF、
   checkpoint/rate/quarantine/terminal telemetry、5 migration alarmも実装済みです。ただし、DR、
   承認済みnon-production execution/alarm delivery evidenceは未完了のため、migration全体のproduction
   gateはまだ実行可能とは扱いません。
5. Online migration は writer fence/epoch または dual-write + high-watermark catch-up を有効化し、
   source scan と cutover の競合を閉じる。Workspace Search v1はmaintenance writer-fenceを選択する。
   Step 4のcurrent authorityで初回`bootstrapOpen`を行い、API、worker、connector、backfillを含む全継続
   writerがexact open-row ConditionCheckを同じtransactionへ含むこと、欠落rowでfail-closedになること、
   初期seed custom resourceがstack updateでは実行されないことを確認する。Cutoverではrenew済みの同authority
   prerequisiteを確認してから`close`し、その後にdrainを実測してsource/target scanとsealed rootを新しい
   runとして再生成する。TTL service deleteはmapperのdisjointness invariantを検証し、対象rowを追加した場合は
   invariant更新またはfence内の追加scanで閉じる。
6. Preimage journal は DynamoDB native value を lossless に保持できる暗号化された segmented store
   に置き、exact `versionId`、content digest、byte length、Object Lock `retainUntil`をoperation markerへ
   固定し、bounded memory/I/O、retention、access audit を確認する。
7. Verify と rollback の command、停止条件、最大実行時間、data/application owner を incident
   または change record に記載する。

Runtime control には対象の API/WebSocket/worker entrypoint を止める `disabled` mode が
ありますが、maintenance `read-only` mode と、mutation だけを網羅的に分類する route/effect
registry は未実装です。初回fence rowのbootstrapとguarded code rolloutでは`disabled`を使いますが、
AppConfigの反映確認をdurable writer-fenceの代用にしてはいけません。`disabled` の反映、guard統合、
fence close、実測上のwriter drainを確認できないproduction migrationは開始しません。

### Required verification and rollback semantics

- Apply は全 writer と共有するrevision/content digest、強整合readでobservedした全top-level属性、
  schema-knownだが不在だった属性をcompare-and-swapする。DynamoDBは未知のtop-level属性追加を完全CAS
  できないため、writer fence、mutation権限分離、完全なknown schema、apply attempt内のstrong read、
  journal upload後のall-six incarnation再検証を必須とし、未知属性writerを排除できなければ停止する。
- Ambiguous transaction response は durable operation-id marker、mutationのjournal-sequence index、
  mutable successor、journal exact versionをreconcileし、commit後のprocess lossを重複mutationにしない。
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
- Migration telemetryはschema version 1、namespace `Mukuroji/WorkspaceSearchMigration`、固定
  `Service` dimension、operation/phase/outcome、configuration binding/hash、policy version、process-local
  correlation、digest由来evidence locator、outer UTC timestamp/sequenceをterminal completion recordへ固定する。
  Live checkpoint stallは同じcorrelation/bound evidenceを持つ即時recordとし、初回measurement failureは
  `unbound`と明示してconfiguration hashを出さない。
  `OperationCount`は各bound invocationで1とし、checkpoint progress/stall、DescribeTable
  attempt/throttle/cadence wait/budget stop/exhaustion、quarantine、terminal failureのmetricをすべて
  明示値（観測なしは0）で出す。`operation`/`phase`/`outcome`やcorrelationをmetric dimensionにしない
- `DescribeTable` rate evidence artifactはschema version、rate-policy version、configuration hash、
  outer UTC window、boundedなpage phaseとevent kind（attempt、throttle、cadence wait、budget stop）、
  monotonic event offset、attempt/forfeited-reservation count、wait/backoff milliseconds、remaining
  normal-admission/window/page capacity、current/max in-flight、observed rateだけを記録する。
  Aggregateのattempt countとmax in-flightはwrite-ahead markerに基づく保守的なcharged値であり、
  実際のphysical start時刻とobserved rateは`attempt` eventから算出する。Cadence wait millisecondsは
  waiterへ要求したdelayであり、早期cancel時の実経過時間とは区別する。
  Physical table名/ARN、account ID、profile、run/owner ID、cursor、tenant data、secret、raw AWS error、
  exception message/stackはeventへ含めない。Approved account/regionと実行commitはconfiguration hashを使って
  access-controlled change record側で結合し、telemetry eventへ複製しない
- Source-evidence の purpose/schema version。`dry-run` v1 は S3 reference/upload なし、legacy
  planning v2 は digest-only かつ append/promote 不可、planning v3 は lossless artifact-bound と
  区別し、v1/v2 を v3 planning input として記録しない
- Target-evidence は planning-only v1 とし、owner/fence/current receipt、順序付き exact target
  artifact reference、target 専用 checkpoint を欠く page を受理しない。State-table の
  `target-evidence/v1/<identity-digest>/head` と immutable page locator、固定5 item transaction の
  request token、exact artifact version replay の結果を同じ durable commit evidence として記録する
- 各 source page で同じ conditional transaction に保存した digest-only row evidence、累積
  checkpoint、直前 checkpoint identity と evidence chain head。Resume cursor は tenant identifier を
  含み得る restricted state であり、raw cursor はログ、汎用 S3 evidence、外部 evidence export へ
  含めない。例外は、全 page の recursive proof に必要な canonical page bytes を暗号化・最小権限の
  immutable provenance object の exact version 内に保持する場合だけとし、standalone cursor や
  checkpoint locator から分離した複製を作らない
- Planning source page の canonical bytes に結合した owner/fence、maintenance receipt digest、
  pointer revision、順序付き exact `{objectKey, versionId, contentDigest}` と、同じ transaction で
  確認した exact lease/pointer/receipt
- Planning artifact 用に実測した bucket ARN/name、versioning、Object Lock COMPLIANCE retention、
  customer-managed SSE-KMS key ARN、測定時刻と configuration hash。各 segment の canonical byte
  length（16 MiB以下）、content digest、segment/item index/count、`PutObject` が返した exact
  `VersionId` を raw item なしで記録する
- 全 segment upload の完了時刻と、その後の固定5 item DynamoDB commit/reconciliation の結果。
  Commit されなかった upload は non-authoritative retained orphan として object locator、version、
  digest、理由、保持期限、費用/件数を記録し、削除や後続 chain への採用を行わない
- Restart/replay では committed reference の exact object version だけを取得して digest/identity/order
  を検証し、restricted checkpoint の cursor と結合して直前 checkpoint から re-reduce した canonical
  v3 page 全体の比較結果を残す。S3 `List`、latest/current version、prefix 推測を evidence に使わない
- Transaction response loss 後に exact successor tuple を再読して成功を回収したか、直前の durable
  checkpoint から再開したこと。異なる successor を成功として採用しない
- Global lease の run/owner/fence/heartbeat/expiry、current receipt digest、receipt pointer revision、
  receipt の exact evidence digest/secret-free locator/freshness window。Heartbeat と receipt renewal
  を別操作として記録し、response loss後は exact leaseまたはreceipt/pointer successorだけを採用する
- Source ごとの initial/final checkpoint digest と cursor 有無、scanned/applied/skipped/invalid/
  rolled-back count。Raw cursor value は restricted state table と、上記 restricted immutable
  provenance object の exact canonical page witness 以外へ複製しない
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
4. `ApiRuntimeConfigurationRevision`はAPI code、または4分割runtime configuration secretへ
   入るparameter/resource値を変更するdeployごとに新しい値へ進め、diffとdeployで同じ値を使う。
   同じrevisionを異なる内容へ再利用しない。
5. Schema/API は backward-compatible にし、migration は上記 entry gate と verify/rollback
   evidence を用意する。
6. Error budget が残り、active SEV1/SEV2 がなく、on-call と alarm destination の test が成功
   していることを確認する。
7. 直前の成功code/configurationを新しい`ApiRuntimeConfigurationRevision`でforward deployする
   rollback commandと、Function URL consumerの切替手順をreviewする。

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
Controlled Lambda 14個はこのall-at-once deploymentの完了へ依存し、初回作成やwriter-fence配線更新で
application処理をfail-closedに保ちます。
`WorkspaceSearchWriterFenceMode=required`へ更新してもbaselineは自動で`enabled`へ戻しません。
全guard反映後の再開は、operatorが監査sequenceを増やした新しい`enabled` hosted versionを
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
   rollback する。Webhook locator は custom resource の逆移行を完了させる。
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

- [ ] Role/roster、primary/secondary notification、通知有効な42 alarmのtest delivery、
  fast-burn両component/compositeのstate history
- [ ] 30日 availability/latency report、transport failure coverage、burn alert test
- [ ] External liveness/readiness probe と rollout stop の test
- [ ] Correlation ID を request → log → event → actor/tenant へ追える sample
- [ ] Required CI checks と repository ruleset / branch protection の確認
- [ ] Migration interruption/resume/verify/rollback の non-production evidence
- [ ] `DescribeTable` account/region budget、single-flight、bounded cadence、throttle stopの承認済み
  non-production rehearsal evidence（commit/policy version、UTC window、page phase、attempt/throttle/wait/
  stop、max in-flight、observed rate）
- [ ] Migration 5 alarmそれぞれのreal metricによる`OK → ALARM → OK` history、secret-free
  correlation/evidence locator、primary/secondary ALARM receipt、read-only execution status
- [ ] Deploy/rollback rehearsal と previous artifact/parameter inventory
- [ ] Runtime control の canary/emergency disable、fail-closed、re-enable、DLQ redrive の drill
- [ ] 90日以内の PITR restore drill、RPO/RTO、integrity evidence
- [ ] S3 restore と DynamoDB metadata 整合の drill
- [ ] Lambda code canary または同等の段階 rollout gate
- [ ] Regional DR の要否決定。必要なら replication/failover game day

関連する詳細手順は [Server backfills](../server/README.md#workspace-search-backfill) と
[CDK upgrade / rollback / PITR](../cdk/README.md#pitr-recovery) を参照してください。
