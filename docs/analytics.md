# Analytics

Analytics は canonical Work Item の現在状態と append-only audit event を同じ認可境界で評価し、
dashboard、saved report、immutable snapshot、drill-down、CSV/PDF export、forecast を提供します。
集計値だけを先に計算してから権限で隠すことはせず、現在の caller が参照できる Work Item を確定して
から、その Work Item に厳密に一致する event だけを入力にします。

## API

すべての route は Cognito access token を
`Authorization: Bearer <token>` で受け取ります。

- `POST /api/analytics/query`
- `POST /api/analytics/evidence`
- `POST /api/analytics/export`
- `GET|POST /api/analytics/reports`
- `PATCH|DELETE /api/analytics/reports/{reportId}`
- `GET|POST /api/analytics/reports/{reportId}/snapshots`

Ad-hoc query は filter、widget、`asOf`、IANA timezone を受け取ります。Saved report ID を指定した
query は保存済み filter、widget、timezone を使い、request body の同名値で report definition を
上書きしません。保存済み forecast baseline も report definition の一部として再利用します。
Evidence、snapshot、export でも現在の認可を読み直し、以前は見えていた
Work Item が権限変更や削除で見えなくなった場合、その値や件数を返しません。

Analytics 用の canonical reader は Team partition を archived row も含めて読み、現在の
Team/Project ACL を適用します。Project filter がある場合も、その Project が属する Team
partition から読みます。現在状態が `asOf` より後に project 移動、archive、status 変更されていても
過去状態を復元できるよう、Audit event は request の読み取り時点まで古い順に読みます。
Workspace 全履歴をscanせず、現在参照可能な `team/{teamId}/issue/{workItemId}` ごとに
`EntityOccurredAtIndex` をqueryします。Legacy raw Work Item ID は、event metadata の
Team/Issueまたはcanonical Work Item targetでcurrent authorized Work Itemへ一意に解決し、
存在するentity、metadata、targetのtype/Team/Issue identityがすべて一致する場合だけ採用します。
Engine は canonical row から `asOf` より後の event を巻き戻してから filter と metric を評価します。
巻き戻した `asOf` state の Project がcallerのcurrent readable Project集合に含まれない場合は、
現在のcanonical rowが別の参照可能なProjectへ移動済みでも、そのfactとevidenceを除外します。
Project access rowはcurrent active directory Projectとの積集合で評価し、削除済みProjectを指す
stale access rowをallowlistとして信頼しません。

1 query の上限は Team partition 100件、1 partition 10,000 Work Item、現在参照可能な Work Item
合計10,000件、canonicalとlegacy raw IDを合わせたentity timeline 500件、全timelineを通じた
Audit page query 500回、返却されたAudit event合計10,000件、1 identityあたり100 pageです。
raw ID eventが認可・identity整合性チェックで除外される場合も、page queryと返却eventの上限を
消費します。raw IDが重複しない通常構成では1 Work Itemにつきcanonicalとraw IDの2 timelineを
確認するため、250件を超える場合はhistory read前に`413`でfail-fastします。
上限に達した場合は部分集計を成功扱いせず
`413` で fail-closed に終了します。Partition数と合計Work Item上限は、Team/Project filterで
読み取るTeam partition数を減らして回避できます。1つのTeam自体が10,000件を超える場合は、
Work Item storeのpartition分割またはscoped indexが必要です。
無関係なWorkspace eventはこの上限を消費しません。対象Work Item自体の履歴が上限を超える場合は、
report scopeを狭めるか、履歴の保持・集約方針を見直す必要があります。

Snapshot 作成時は実行した正規化済み query、report revision、metric contract version、
permission scope hash を保存します。一覧は新しい順に最大100件を返し、export と一覧のどちらも
current accessible Work Item keyとactive readable Project ID集合を含むpermission scope hashを
再検証します。
現在のscopeが変わったsnapshotは再集計せず非表示、または`403`にします。

Filterとgroup-byのTeam、Project、assignee、status、custom field、archive状態は、いずれも
`asOf`へ復元したstate dimensionで評価します。Throughput、cycle/lead time、scope changeなどの
event metricは`asOf`以前かつ指定期間内の有効なeventだけを使います。

## Metric definitions

Metric contract の version は snapshot に固定します。同じ入力、metric version、timezone、
`asOf` からは同じ値を再計算できます。

| Metric | Definition |
| --- | --- |
| Throughput | 指定期間中に有効な完了を迎えた Work Item 数。reopen された item は、再完了後の最新の有効な完了を1回だけ計上します。 |
| Cycle time | 有効な完了の直前に `started` へ遷移した時点から、その完了までの経過時間。履歴が不足する item は sample から除外し warning を返します。 |
| Lead time | Work Item の `createdAt` から有効な完了までの経過時間。 |
| WIP | `asOf` 時点で `started` category、かつ archive されていない Work Item 数。 |
| Overdue | Report timezone の calendar date で期限を過ぎ、`completed` / `canceled` ではない Work Item 数。 |
| Scope change | 期間中の Project assignment の追加、削除、移動に相当する event 数。 |
| Velocity | 期間の週数で正規化した completed Work Item 数。 |
| SLA | Widget の `slaTargetHours` 以下で完了した eligible Work Item の割合。 |

Work Item の重みを表す共通 estimate/point field はまだありません。そのため velocity は item count
を単位とし、任意の数値 custom field を暗黙に story point として扱いません。

## Timezone and date boundaries

- `asOf` と audit event は UTC ISO 8601 instant です。
- Report は有効な IANA timezone ID を保存します。
- Day/week/month bucket の境界は report timezone で作り、DST の23時間日・25時間日を許容します。
- Work Item の `dueDate` は date-only 値です。UTC midnight へ変換せず、report timezone の
  calendar date と直接比較します。
- Snapshot は timezone、query hash、`asOf`、生成時刻を固定します。

## Archive, deletion, and incomplete history

通常の current WIP/overdue では archived Work Item を除外します。
Analytics reader 自体は現在 archived の canonical row も読み、archive event を使って `asOf`
時点の状態を復元します。その後で engine が `includeArchived` を適用するため、現在は archive
済みでも `asOf` 当時は active だった item を historical query から誤って落としません。
`includeArchived` を明示した query でも、caller が現在も Team/Project を参照できる canonical row
だけが対象です。Archive 前に完了した item は throughput、cycle time、lead time の履歴へ残せます。

Audit backfill は現在状態から作成した snapshot event であり、過去の全 transition を復元するもの
ではありません。また backfill では assignee、description、custom field value などが redacted
されています。必要な開始・完了 event がない metric は推測で補完せず、sample size と warning で
不足を示します。

現在 canonical Work Item が存在しない削除済み履歴や、現在 caller が参照できない Project の event
は集計にも evidence にも含めません。これは過去 snapshot の見かけ上の合計を維持することより、
現在の認可境界を優先するためです。

## Report visibility and authorization

- `personal`: owner memberだけが読み書きできます。
- `team`: Team viewerが読み取れ、Team managerだけが作成・更新・削除できます。
- `shared`: active Workspace memberが読み取れ、Workspace owner/adminだけが作成・更新・削除できます。

Guest は report を読み取れますが、Workspace business data を変更できません。Report definition の
revision は optimistic concurrency に使い、stale update/delete を `409` で拒否します。
Snapshot 作成時にも report と現在データの両方を再認可します。

## Forecast

Forecast は指定期間をreport timezoneのlocal calendar dayへ分割し、各日の日別完了件数と
`asOf`時点の未完了scopeを使います。履歴期間の各開始offsetから日別完了列を循環再生し、未完了
scopeを消化するまでのlocal day数を1scenarioとして、nearest-rankのp50、p85、p95 empirical
quantileを求めます。求めた日数は`asOf`へlocal calendar-day単位で加えるため、DSTを跨いでも
reportのlocal wall-clockを維持します。

乱数やMonte Carlo simulationは使わず、同じ入力からは同じ結果になります。Daily throughputは
指定期間の完了数をlocal day数で割り、confidenceは完了sample数が20件で1.0になるよう段階的に
上げます。保存済みbaseline終了日とp85の差を`low` / `medium` / `high` riskに変換します。
完了sampleが2件未満、またはthroughputが0の場合は予測日を作らず`unknown`を返します。

## Scheduled delivery

Saved report は daily、weekly、monthly の local wall-clock schedule を持てます。
EventBridge は due report を5分ごとに確認し、schedule timezone の予定 occurrence を `asOf`
として実行します。DST の fall-back で同じ local calendar date / wall-clock が2回現れても、
同じ local date には1回だけ配信します。Client が送った `nextRunAt` は信頼せず、server が
schedule 設定から計算した cursor だけを保存します。

Schedule runner は recipient が active Workspace member で、report と対象 Team/Project を現在も
参照できることを各 occurrence で再確認します。確認できない recipient は protected data を
読まずにskipします。同じ report revision、occurrence、query、permission scope の recipient は
1つの immutable snapshot を共有し、recipientごとに決定的な receipt を保存して重複を排除します。
APIと同様、recipientのProject accessはactive directoryとの積集合に限定し、`asOf` stateが
current allowlist外のfactをscheduled snapshotへ含めません。

現行の delivery boundary は immutable snapshot と in-app receipt の durable 保存です。CSV/PDF
artifact renderer はその前に実行する副作用のない検証処理であり、外部送信やユーザー状態の変更を
行いません。Renderer に失敗した場合は snapshot/receipt を保存せず、recipientの途中で失敗した
場合も schedule cursor を進めません。Lambda retryでは既存 snapshot/receiptを冪等に再利用します。

Emailなど外部providerへの送信を追加する場合は、純粋rendererへ副作用を混ぜず、transactional
outboxまたは明示的なdelivery state machine、recipient認可、retry、bounce、secret管理を別途
実装してください。Analytics LambdaをAuditEvents streamの3つ目のdirect consumerにはしません。

Schedule failure は非同期retry後にencrypted SQS DLQへ入り、visible message数の
CloudWatch alarmで検出します。同じ occurrence を手動再実行してもreceiptにより重複配信しません。
