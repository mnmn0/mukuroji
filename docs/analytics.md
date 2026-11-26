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

`GET /api/analytics/reports` は `limit`（1〜200）とWorkspaceに束縛されたopaqueな`cursor`で
ページングします。WorkspaceごとのSaved reportは最大1,000件で、並行作成時もDynamoDB transaction
で上限を超えないようにします。

Ad-hoc query は filter、widget、`asOf`、IANA timezone を受け取ります。Saved report ID を指定した
query は保存済み filter、widget、timezone を使い、request body の同名値で report definition を
上書きしません。保存済み forecast baseline も report definition の一部として再利用します。
Report snapshot の作成時も保存済み definition を必ず使い、request body で上書きできるのは
実行時点を固定する `asOf` だけです。
Evidence、snapshot、export でも現在の認可を読み直し、以前は見えていた
Work Item が権限変更や削除で見えなくなった場合、その値や件数を返しません。

### Export の名前表示

Snapshot の group は Team ID・Project ID・member key・status category をそのまま key と label に
持ちます。名前は保存せず、表示と export のたびに引き直します（名前を変えると古い snapshot も新しい
名前で出ます）。共通の解決規則は contracts の `resolveAnalyticsGroupLabel` で、Web と export が
同じものを使います。Project・担当者・custom field の値がない group は locale に合わせた
「未設定」/「Unassigned」になります。名前が分からない ID（削除された Team など）は元の値のままです。

Export が引く名前は caller が見られる範囲に限ります。Team と Project は caller の Project
directory（`GET /api/teams/projects` と同じ絞り込み）から、member 名は読める Project の member
一覧から、Work Item Type と custom field の名前は見える Team の configuration から読みます。
member と configuration は query が担当者・Work Item Type・custom field を使うときだけ読み、
読み取りに失敗した分は元の値で出力します。
Project ID と custom field ID は Team の中でしか一意でないので、Project 名は行の Team と組で引き、
custom field 名は query が絞った Team の configuration から引きます。Team が決まらず名前が食い違う
ときは「名前 (Team) / 名前 (Team)」と併記します。

PDF の見出しは保存済み report の名前です。保存済み report を開いて live query のまま出力するときは、
Web が `titleReportId` を添え、server が caller の権限で report を読んで名前だけを使います（出力内容は
`query` のまま）。

CSV は既存の列の後ろに「Dimension key」「Team」「Project」を足しました。Group 行の
「Dimension value」は名前、「Dimension key」は元の key です。Table 行の「Team」「Project」は
「Team ID」「Project ID」の名前です。

PDF は report 名（ad-hoc query では `mukuroji analytics`）、期間（report の timezone の日付）、
基準日時、timezone、絞り込み、widget ごとの値と group 別の内訳（widget あたり 100 件まで）、
forecast を書き、余白に収まらない行は折り返します。埋め込みの日本語 font は固定ラベル用の
subset なので、それ以外の文字（Team 名の漢字など）は非埋め込みの CID font
（`HeiseiKakuGo-W5`、Adobe-Japan1、`UniJIS-UCS2-H`）で書き、PDF viewer が持つ日本語 font で
表示します。この font を使う文字には ToUnicode を付け、コピーと検索で元の文字を返します。
ASCII に分解できる文字（`é` など）は `e` として書き、どちらの font でも書けない文字（絵文字など）は
`?` にします。

Analytics 用の canonical reader は Team partition を archived row も含めて読み、現在の
Team/Project ACL を適用します。Project filter がある場合も、その Project が属する Team
partition から読みます。現在状態が `asOf` より後に project 移動、archive、status 変更されていても
過去状態を復元できるよう、Audit event は request の読み取り時点まで古い順に読みます。
Workspace 全履歴をscanせず、現在参照可能な canonical `team/{teamId}/issue/{workItemId}` ごとに
`EntityOccurredAtIndex` をqueryします。event の flat/nested entity type と ID は query した
canonical Work Item identity に完全一致する場合だけ採用します。
Engine は canonical row から `asOf` より後の event を巻き戻してから filter と metric を評価します。
巻き戻した `asOf` state の Project がcallerのcurrent readable Project集合に含まれない場合は、
現在のcanonical rowが別の参照可能なProjectへ移動済みでも、そのfactとevidenceを除外します。
Project access rowはcurrent active directory Projectとの積集合で評価し、削除済みProjectを指す
stale access rowをallowlistとして信頼しません。
Canonical row と entity index の audit history は同時には更新されないため、API は同じ cutoff
に対して canonical state を前後で強整合 readし、Work Item とProject allowlistのfingerprintが
一致し、各latest revisionのupdate eventが到達済みであることを確認します。不整合は有界回数だけ
再試行し、揃わない場合は部分的なsnapshotを返さず`503`でfail-closedにします。

Audit history を読むのは、`updatedAt` が query 期間の開始（`filter.period.from`）以降の Work Item
だけです。Canonical Work Item の変更は audit event と同じ transaction で書かれ、`updatedAt` を
event 時刻にそろえます。そのため期間開始より前から更新のない Work Item には、期間内の完了、
`started` への遷移、Project scope change がなく、期間開始から `asOf` までの各評価時点の state は
現在の canonical row と同じです。Engine はこの Work Item を history なしでも同じ metric 値で評価する
ため、canonical row 自体を事前集計として使い、entity timeline を読みません。期間開始を解釈できない
場合はすべての Work Item の history を、`updatedAt` を解釈できない Work Item はその history を読みます。Read barrier の latest revision 確認も、
history を読む Work Item だけに適用します（読まない Work Item は前後2回の canonical read の
fingerprint 一致で変更がないことを確認します）。定期配信の runner も同じ選択を使います。

History は Work Item ごとの history row（`AnalyticsTable` の `WORK_ITEM_HISTORY#<teamId>#<workItemId>`、
[ADR 0042](adr/0042-analytics-work-item-history-rows.md)）から先に読みます。Row は audit projection の fan-out が
AuditEvents stream から作り、target が Work Item 自身の event だけを、engine が読む field の変更、revision の
metadata、audit の保持期限（`expiresAt`）に絞って持ちます。Row の `coveredRevision`（途切れずにそろった最大の
canonical revision）が canonical の `revision` と一致し、`overflow` でない Work Item だけ row を使い、row がない・
古い・`overflow` の Work Item と、保持期限を過ぎた entry が残る Work Item は下の entity timeline の query で読みます。
Row は強整合性の BatchGetItem で読み、throttling など一時的な失敗のときはその query の全 Work Item を timeline から読みます（権限エラーなどはそのまま失敗にします）。
`overflow` の row も最も早い entry の保持期限で消え、次の event で測り直します。どちらから読んだ event にも同じ read barrier を
かけるので、結果は全 Work Item の entity timeline を読んだ場合と同じです。Row から復元する entry は 1 query 合計
200,000 件・row の合計 64 MiB まで（超えたら `413`）、保持期限を過ぎた entry は使わず、projection も書き込み時に落とします。Row は最も早い entry の
保持期限（`historyExpiresAt`、`AnalyticsTable` の TTL）で消え、次の event で作り直されます。Projection は row がないとき（revision 1 の INSERT を除く）や
revision が飛んだときに entity timeline から row を作り直し（row にある event は stream で受けた保持期限を残し、足りない event だけ timeline から足す）、Work Item の削除で row を消します。更新に失敗した
row も消します（保持期限の変更は revision を進めないため）。Revision 1 より後から始まる row は、最も古い entry が
1 時間より前（entity index の遅れではなく保持期間で消えたと言える）のときだけ使います。

1 query の上限は Team partition 100件、1 partition 10,000 Work Item、現在参照可能な Work Item
合計10,000件、history を読む canonical entity timeline 500件、全timelineを通じた Audit page query
500回、返却されたAudit event合計10,000件、1 entityあたり100 pageです。
canonical identity と一致しない event は採用せず、query 数と返却event数の上限は消費します。
Work Item の entity timeline には context item・comment・file など Work Item に付く record の event も
載りますが、state の巻き戻しと遷移には target が Work Item 自身の event だけを使います
（context item の `title` 変更で Work Item の表示名が巻き戻らないようにするため）。
History row で読めない（entity timeline の query が要る）Work Item が501件以上ある場合は、その query の前に `413` で fail-fast します。
Web は `413` を受けると、期間を短くするか Team / Project で絞り込むよう表示します。
Web の新規 ad-hoc query は、上限にかかりにくいよう直近30日と閲覧者が見られる Team を既定の filter にします。
上限に達した場合は部分集計を成功扱いせず
`413` で fail-closed に終了します。Partition数と合計Work Item上限は、Team/Project filterで
読み取るTeam partition数を減らして回避できます。1つのTeam自体が10,000件を超える場合は、
Work Item storeのpartition分割またはscoped indexが必要です。
無関係なWorkspace eventはこの上限を消費しません。対象Work Item自体の履歴が上限を超える場合は、
report scopeを狭めるか、履歴の保持・集約方針を見直す必要があります。

正規化後の集計期間は最大366 local calendar day、全widgetが生成するcalendar bucket / pointの
合計は10,000件までです。これらの上限は認可対象データを読み始める前に検証し、過大なqueryは
`413`で拒否します。

Snapshot 作成時は実行した正規化済み query、report revision、metric contract version、
permission scope hash を保存します。一覧は新しい順にcurrent ACL検証済みsnapshotを1 response
あたり最大100件返し、export と一覧のどちらもcurrent accessible Work Item keyとactive readable
Project ID集合を含むpermission scope hashを再検証します。
Snapshot の作成日時をDynamoDB sort keyへ含め、repositoryは強整合の逆順queryを最大100件の
scope-bound cursor pageとして返します。APIはrepository pageへACL post-filterを適用し、閲覧可能な
100件、保存行の末尾、または1 responseあたり1,000件の検査上限へ達するまで読み進めます。
各repository readは残りの閲覧可能件数にかかわらず最大100件で行い、DynamoDBの1 MB response
上限などで1 pageが100件未満になっても、1 API responseで直列実行するrepository readを最大10回に
制限します。10回のread後も保存行が残る場合は`nextCursor`を返します。閲覧可能100件へpage途中で
達した場合は最後に検査したrecordの直後を`nextCursor`にし、同じpageからまだ検査していない
snapshotを次responseで再開します。
Responseの`inspectedCount`はそのresponseでACL検査した保存record数です。返却上限または検査上限へ
達した時点で保存行が残る場合は`nextCursor`を返し、clientは同じWorkspace/reportの`cursor` query
parameterとして継続できます。これにより長期運用で蓄積したpayload全件を一度に読み込みません。
現在のscopeが変わったsnapshotは再集計せず非表示、または`403`にします。
Table widgetのsnapshot previewは先頭50行までに制限し、全明細はページングされたevidence APIで
取得します。live responseのJSONは256 KiB、DynamoDBへ保存するsnapshot recordは350 KiBを上限とし、
超過時は部分データを保存せず`413`で拒否します。

Filterとgroup-byのTeam、Project、assignee、status、priority、custom field、archive状態は、いずれも
`asOf`へ復元したstate dimensionで評価します。

Group-byの`cycle`と`milestone`はPlanningのWork Item linkの現在の所属で分け、`asOf`へは
復元しません。CycleとMilestoneはcallerがPlanning ACL（`GET /api/planning`と同じ規則、Enterpriseは
各entityのscopeでの`planning.read`）で読めるものだけを使い、読めないentityに属するWork Itemは
未設定（key `''`）に入れます。Group labelはentityのtitleで、callerが読めるCycleとMilestoneの
scope keyをsnapshotのpermission scope hashへ含めるので、その権限が変わったsnapshotは
非表示または`403`になります。定期配信はPlanningを読まないため、この widget は
`Cycle and Milestone membership is not available for this run.` の warning だけを返します。
Work Item history row（ADR 0042）は`priority`の変更も保持します。Throughput、cycle/lead time、scope changeなどの
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
| Remaining scope | 評価時点で archive されておらず、`completed` / `canceled` ではない Work Item 数。Chart の各 point は burnup 用に `scope`（`canceled` を除く total scope）と `completed` を `segments` で返します。`weighting: "effort"` では残工数（記録された残工数、なければ見積）の合計時間で、burnup の `scope` と `completed` は見積の合計時間です（残工数の消化が scope の減少に見えないようにするため）。 |
| Cumulative flow | 評価時点で archive されていない Work Item 数。Chart の各 point は status category（`completed` / `started` / `unstarted` / `backlog` / `canceled`）ごとの件数を `segments` で返します。 |
| Milestone trend | 期間中に予定日（forecast の終了日）が変わった Milestone 数。Chart の各 point は bucket 末時点の各 Milestone の予定日を、key が Milestone ID、value が 1970-01-01 からの日数の `segments` で返します。Group は Milestone ごとに、期間中に予定日が動いた日数（遅れは正）と変更回数（`sampleSize`）を返します。 |
| Agent tokens | 期間内（`asOf` まで）に終わった Agent Run が使ったトークン数（入力・出力・prompt cache の読み取り・書き込みの合計、unit `tokens`）。`sampleSize` は数えた Run 数です。 |
| Agent estimated cost | 期間内に終わった Agent Run の推定費用（USD、unit `usd`）。閲覧者が manager である Team の Run だけを数えます。 |
| SPI | `asOf` の日付の出来高（EV）÷ 計画値（PV）。baseline の予定工数（分）で測り、unit は `index`（小数 2 桁）。閲覧者が manager で、予定工数のある baseline を持つ Project だけを数えます。 |
| CPI | EV ÷ Project に記録した時間（AC）。unit `index`。対象は SPI と同じです。 |
| EAC | baseline の予定工数（BAC）÷ CPI を時間で表した値（unit `hours`）。対象は SPI と同じです。 |

Remaining scope と cumulative flow は WIP と同じく、chart の bucket ごとに bucket 末（`asOf` を超えない）時点へ
state を巻き戻して評価する state metric です。期間の途中で作成された Work Item は作成後の bucket から scope に入るため、
burnup の `scope` で scope 追加を区別できます。これらの metric の追加で既存 metric の値と version は変わりません。

### Milestone trend

Milestone trend は Work Item ではなく Planning の Milestone を入力にします。API は `milestone-trend` widget を
含む query のときだけ Planning graph を読み、live（archive されていない）Milestone を使います。従来の権限の
caller は `GET /api/planning` と同じ current Planning ACL で絞ります。Analytics の route は `work-items.read` で
認可され、Enterprise の caller の principal にある scope はその permission のものなので使わず、各 Milestone の
Team / Project / Workspace resource で `planning.read` を評価し、許可のない Milestone は読みません。Team / Project filter は Milestone の現在の scope に適用し、
どちらかを指定すると Workspace scope の Milestone は含めません。`asOf` より後に作られた Milestone も含めません。
1 query で読む Milestone は 100 件まで（超えたら `413`）で、Work Item 用の filter（担当者、status、
custom field、Work Item 一覧など）は Milestone に効きません。

予定日の履歴は各 Milestone の `planning-entity` audit timeline（[#639](https://github.com/mnmn0/mukuroji/issues/639)
の作成・変更・移動の event）から `forecast.endDate`、`teamId`、`projectId` の変更を読みます。上限は Milestone
あたり 20 page、全体で page query 500 回・event 10,000 件です（超えたら `413`）。ある時点の値は、その時点以前の
最新の変更の `after`、なければそれより後の最初の変更の `before`、変更がなければ現在値です。Milestone は作成後、
かつ記録された Team / Project scope が現在と同じ間だけ予定日を返すので、閲覧者が今は読めない scope に
あった間の履歴は返しません。記録上の scope には、各 event が metadata に残した書き込み時点の Team / Project も
使います。親（Initiative など）の移動で Milestone の scope が変わった場合は Milestone 自身の event がないため、
別の Team へ移って戻った間の変更もその event の scope で隠れます。ある event の scope が直前の event の後の scope と
違えば、その間のどこかで親が動かしたので、その区間は scope 不明として予定日を返しません。`updatedAt` が最後の event
より後なら親の書き込みで運ばれたとみなし、最後の event からそれまでも scope 不明、それ以降を現在の scope とします。Audit を書く前に作られた Milestone は作成時から現在の予定日を返し、warning を付けます。
Audit の entity index は結果整合なので、各 Milestone の履歴が最新の書き込み（`updatedAt` 以降の event、または5分より
前の親による移動）と現在の予定日に追いつくまで Planning と audit を読み直し（3 回まで、上限は再試行全体で共有）、
揃わなければ `503`（`AnalyticsReadBarrierUnavailable`）で fail-closed にします。作成直後で作成 event がまだ見えない
Milestone も、audit 前の Milestone とはみなさず読み直します。

Snapshot の permission scope hash には、Milestone を読んだ query のときだけ読めた Milestone の ID と現在の
Team / Project scope を加え（移動した Milestone の snapshot は再検証で見えなくなります）、
一覧・export の再検証でも同じ規則で現在読める Milestone と比べます（現在読める Milestone が上限の 100 件を超える場合、
その snapshot だけを scope 不一致として扱います）。Milestone trend のない report の hash は
変わりません。定期配信の runner は閲覧者の Planning ACL を評価できないため Milestone を読まず、その widget は
warning だけを返します（hash にも Milestone を加えません）。変化日数は期間末と期間開始の予定日の差で、期間開始の時点で予定日を返せない場合は期間内で最初に返せた予定日を基準にします（CSV の `shiftFrom` と table の `periodStartForecastEndDate` もその日付です）。CSV では segment の値を `YYYY-MM-DD` で出力し、table の行は値に変化日数、サンプル数に変更回数、ディメンション値に
`baseline=…; shiftFrom=…; forecast=…` を出力します。
Segment は bucket 数 × Milestone 数だけ増えるため、長い期間を日次で多数の Milestone について描くと
response の 256 KiB 上限で `413` になります。Web の builder は週次 bucket で widget を追加します。


Chart widget の `visualization` は `line` / `bar` に加え、`area`（`segments` の積み上げ面、CFD 用）、`burndown`
（残量と、最初の point の残量から期間末に 0 へ向かう ideal line）、`burnup`（`scope` と `completed` の 2 本線）を
選べます。ideal line は保存値ではなく、snapshot の series から表示時に引きます。

Filter の `workItems`（`{ teamId, workItemId }` の一覧、最大500件）は対象 Work Item を明示的に絞ります。Cycle の
burndown は Planning の Work Item link から Cycle に属する Work Item を列挙してこの filter に渡します。API は列挙された
Team partition だけを読み、列挙された Work Item だけを history read の対象にするため、500件を超える Team でも
Cycle 単位の chart を計算できます。Cycle 所属の履歴は保存していないため、過去の bucket も現在の所属で評価します。

既定では throughput と velocity は item count を単位とし、任意の数値 custom field を暗黙に story point として扱いません。
Throughput / velocity widget は `weighting: "effort"` を指定すると、完了した Work Item の正本見積
（`schedule.plannedEffortMinutes`）の合計を時間（`hours` / `hours-per-week`）で返します。見積のない完了 item は
0 として数え、その件数を warning で返します。他の metric に `weighting` を指定すると `400` で拒否します。

Forecast は query / report の `forecastWeighting: "effort"` で、完了した見積工数の日次分布と、未完了 Work Item の
残工数（記録された残工数、なければ見積）の合計 `remainingEffortHours` から完了日を予測します。この場合の
`dailyThroughput` は 1 日あたりの見積時間です。`weighting` と `forecastWeighting` は query hash、snapshot、
evidence、定期配信の hash に含まれます。

### Agent tokens / Agent estimated cost

[ADR 0108](adr/0108-analytics-agent-usage-metrics.md)。値は OpenTelemetry で届いた usage を
[ADR 0061](adr/0061-agent-token-usage-over-otlp.md) の規則で Run に割り当てたものです。API は `agent-tokens` /
`agent-cost` widget を含む query と evidence のときだけ、認可済み Work Item の Team ごとに終了済み Run の index を
期間の両端で読み、report の filter に `asOf` 時点で一致する Work Item の Run だけを強整合で読み直してから usage 行を読みます。usage のない Run は数えません。
1 query で 500 Run を超えるか、index を 100 page（見えない Work Item の Run も page を埋めます）読んでも終わらなければ `413`（`AnalyticsAgentUsageLimitExceeded`）です。Chart の bucket は Run の終了時刻で
分け、group は他の metric と同じく `asOf` 時点の Work Item の state で分けます。Evidence と table は Run ごとに 1 行で、
値はその Run のトークン数または推定費用です。

推定費用は閲覧者が manager である Team（Team の全 active Project の manager）の Run だけを数え、それ以外の Run は件数を warning で返します（数えられる Run の
ない group の値は `null`）。費用が届いていない Run は 0 として数え、usage の読み取りが上限で止まった Run は合計が
下限であることを warning で返します。`agent-cost` を含む snapshot の permission scope hash には、Work Item の Team の
うち閲覧者が manager である Team の ID を加え、一覧・export の再検証でも同じ規則で比べます。`agent-cost` のない query の
hash は変わりません。Software factory を deploy していない環境と定期配信の runner は usage を読まず、widget は
warning だけを返します（hash にも Team を加えません）。

### SPI / CPI / EAC（EVM）

[ADR 0110](adr/0110-analytics-earned-value-metrics.md)。値は Project の予算レポート
（[docs/time-tracking.md](time-tracking.md)）の EVM と同じ計算の工数版です。PV は baseline の各 Work Item の予定工数を
予定開始日〜終了日に均等に割り振った `asOf` の日付までの合計、EV は予定工数 × Work Item の今の進捗率、AC は Project に
`asOf` の日付までに記録したすべての時間（経費は含めません）です。中止した Work Item は BAC・PV・EV から外します。
複数の Project をまとめた値と group の値は、丸める前の分を足してから割り、最後に丸めます（SPI = ΣEV ÷ ΣPV、
CPI = ΣEV ÷ ΣAC、EAC = ΣBAC ÷ CPI）。
PV が 0 なら SPI、AC が 0 なら CPI と EAC、CPI が 0 なら EAC は `null` です。

API は EVM の widget を含む query のときだけ、report の範囲（Team / Project の filter）にある認可済み Work Item の今の
Project を Team 付きで集め、閲覧者が Project manager である Project を読みます。それ以外の Project と、予定工数のある
baseline がない Project は件数を warning で返します。1 query で 20 Project を超えれば `413`
（`AnalyticsEarnedValueLimitExceeded`）です。担当者・状態などほかの filter は EVM に効きません。Group は Team と Project
だけで、chart はどちらかで分けることが必須です（日・週の series は作りません）。Table は Project ごとに BAC / PV / EV / AC
の時間と値を返します。Evidence はありません。

EV は Work Item の今の進捗を使うので、`asOf` が 1 日より前の query では値を作らず warning だけを返します。過去の値は、
その時点で作った snapshot で見ます。EVM を含む snapshot の permission scope hash には、閲覧者が manager である Project の
`teamId\0projectId` を加え、一覧・export の再検証でも同じ規則で比べます。EVM のない query の hash は変わりません。
定期配信の runner は EVM を読まず、widget は warning だけを返します（hash にも Project を加えません）。

Software factory の Run の成功率・手戻り率・工程別の滞在時間は、まだ Analytics engine の metric ではなく、
Factory board の期間サマリーとして別 API で計算します。定義は
[Software factory の「期間サマリー」](software-factory.md#期間サマリーanalytics) を参照してください。

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

必要な開始・完了 event がない metric は推測で補完せず、sample size と warning で不足を示します。

現在 canonical Work Item が存在しない削除済み履歴や、現在 caller が参照できない Project の event
は集計にも evidence にも含めません。これは過去 snapshot の見かけ上の合計を維持することより、
現在の認可境界を優先するためです。

## Report visibility and authorization

- `personal`: owner memberだけが読み書きできます。
- `team`: Team viewerが読み取れ、Team managerだけが作成・更新・削除できます。
- `project`: `teamId` と `projectId` の組で Project を指します。その Team の Project を読める member が読み取れ、
  その Project の manager（Enterprise では Team または Workspace の `teams.manage`）だけが作成・更新・削除
  できます。Project ID は Team をまたいで重なりうるので、判定は必ず Team 付きで行います（ADR 0062）。
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
1 reportのrecipientは最大100人です。Runnerはrender前に既存のreceiptとsnapshotを強整合で確認し、
途中失敗後のretryでは保存済みcheckpointから未完了recipientだけを処理します。配信対象・schedule・
queryなどの意味が変わるreport editはoccurrence definitionを変更するため、旧definitionの処理は
新しいschedule cursorを進めません。表示名など配信の意味を変えないeditは同じoccurrenceとして
安全にcursorを進められます。

Due index はWorkspace/reportの安定hashで16個のpartitionへ分散し、runnerは全partitionを走査します。
各partitionのpaginationは`nextRunAt/workspaceId/reportId`のexclusive keysetを使うため、処理済み
reportの`nextRunAt`が進んでdue集合から消えても、同じinvocationの後続pageを飛ばしません。

現行の delivery boundary は immutable snapshot と in-app receipt の durable 保存です。CSV/PDF
artifact renderer はその前に実行する副作用のない検証処理であり、外部送信やユーザー状態の変更を
行いません。Renderer に失敗した場合は snapshot/receipt を保存せず、recipientの途中で失敗した
場合も schedule cursor を進めません。Lambda retryでは既存 snapshot/receiptを冪等に再利用します。

受信者への通知は、receipt の保存後に recipient ごとに1件の audit outbox event
（`analytics.report.delivered`）を AuditEvents へ条件付き put して行います。通知は常に保存済み receipt
の snapshot を指します。通知に失敗すると schedule cursor は進まず、retry では完了済み receipt から同じ
通知を書き直します。Event ID は receipt の occurrence key から決まるため重複しません。既存の
collaboration projection がこの event を受信者の Inbox 行に変え、受信者が通知設定で Slack / Email を
有効にしていれば同じ channel delivery queue に載せます。Event は report ID を entity、snapshot ID を
target に持ち、`/reports?v=1&report=<id>&snapshot=<id>` を deep link にします。Team visibility の
report は event に Team ID を載せ、projection と外部送信の直前に recipient の Team access を再確認します。
Project visibility の report は Team ID と Project ID を載せ、Project 単位の通知と同じ規則で recipient の
Project access を再確認します。
Report と同じく、Team の Project のどれかを読めれば Team access ありとします。Shared / personal report
の外部送信は、Enterprise の Work Item 閲覧権限が Workspace・Team・Project のどれか1つにあれば送ります。

Inbox は表示のたびに report を読み直し、report が削除されたか recipient が現在の visibility
（personal は owner、team は Team の参照権限、project は Team 付き Project の参照権限、shared は Workspace member）を満たさない場合は通知を
隠し、表示名は現在の report 名に置き換えます。Link 先の snapshot 一覧は従来どおり recipient の
現在の permission scope と一致する snapshot だけを返します。Analytics Lambda は AuditEvents に
書くだけで、AuditEvents stream の direct consumer にはしません。

Schedule failure は非同期retry後にencrypted SQS DLQへ入り、visible message数の
CloudWatch alarmで検出します。同じ occurrence を手動再実行してもreceiptにより重複配信しません。

受信者は自分への配信を `GET /api/analytics/deliveries?limit&cursor`（limit は 1〜50、既定 20）で新しい順に
読めます（ADR 0064）。Runner は receipt の確定後、通知の直前に受信者ごとの索引行
（`DELIVERY_RECIPIENT#<member key の hash>#<deliveredAt>#<reportId>#<snapshotId>`）を冪等に書きます。API は caller 本人の
索引だけを Query し、今その report を読めるもの（report 一覧と同じ判定）だけを今の report 名で返します。
cursor は Workspace と受信者に結び付き、他のメンバーの索引は辿れません。返した snapshot を開くときは通常どおり
permission scope hash を再確認します。
