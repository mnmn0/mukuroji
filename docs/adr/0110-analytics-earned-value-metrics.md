# 0110. Analytics の EVM（SPI / CPI / EAC）は query のたびに管理する Project の予算レポートの値を読み、その Project の集合を snapshot の scope に固定する

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #345, [ADR 0108](0108-analytics-agent-usage-metrics.md), [ADR 0104](0104-project-expense-entries.md),
  [docs/analytics.md](../analytics.md), [docs/time-tracking.md](../time-tracking.md)

## 背景

Project の予算レポート（`GET /api/teams/:teamId/projects/:projectId/budget-report`）は、baseline の予定工数・Work Item の
進捗・記録時間から PV / EV / AC と SPI / CPI / EAC を計算し、Project manager にだけ返す。全 member の時間を足すからである。
#345 は、この SPI / CPI を Analytics の widget に置き、snapshot で同じ値を再現できることを求めている。Analytics の metric は
Work Item の canonical row と audit event から `asOf` 時点の state を巻き戻して計算するが、EV が使う進捗（手入力の進捗率や
残工数）の履歴は Analytics の fact にない。Shinji の方針は「なるべく安く」。

## 決定

- **Metric**：`evm-spi`（unit `index`）、`evm-cpi`（unit `index`）、`evm-eac`（unit `hours`）を足す。値は予算レポートと同じ
  計算の工数（分）版で、金額は使わない（Project ごとに通貨が違い、足せないため）。複数 Project の値は分を足してから割る
  （SPI = ΣEV ÷ ΣPV、CPI = ΣEV ÷ ΣAC、EAC = ΣBAC ÷ CPI）。Group は Team と Project だけ。Chart は Team か Project で分ける
  ことを必須にし、日・週の series は作らない。Evidence は Work Item ごとではないので返さない。
- **読み方**：該当 widget を含む query のときだけ、API が report の範囲（Team / Project の filter）にある認可済み Work Item の
  現在の Project を Team 付きで集め、閲覧者が Project manager である Project ごとに予算レポートと同じ読み取りで値を作る。
  AC は予算期間の開始と baseline の予定日のうち最も早い日から `asOf` の日付までの記録時間。1 query で 20 Project を超えれば
  `413`（`AnalyticsEarnedValueLimitExceeded`）にする。同じ Team の Work Item の読み取りは query の中で使い回す。
  新しい保存 row・index・事前集計は作らない。
- **`asOf` の制限**：EV は Work Item の今の進捗を使うので、`asOf` が 1 日より前の query では値を作らず、
  warning だけを返す。過去の値は、その時点で作った snapshot で見る。
- **権限**：閲覧者が manager でない Project は数えず、件数を warning で返す。Manager である Project の集合
  （`teamId\0projectId`）を snapshot の permission scope hash に加え、一覧・export の再検証でも同じ規則で比べる。
  Manager でなくなった人にはその snapshot を見せない。EVM の widget がない query の hash は変えない。
- **使えないとき**：定期配信の runner は読まず、widget は `Earned value is not available for this run.` の warning だけを
  返す（hash にも Project を加えない）。

## 検討した選択肢

- 金額の CPI・EAC を出す：Project ごとに通貨が違い、為替換算を持たないので足せない。金額は予算レポートで見る。却下。
- 過去の `asOf` でも今の進捗で EV を出す：過去の PV と今の EV を比べることになり、SPI が実際より良く見える。却下。
- 進捗の履歴を Analytics の fact に足して過去の EV を出す：手入力の進捗率と残工数の履歴の読み取りと Team の進捗方式の
  履歴が要り、今回の範囲を超える。必要になれば別の ADR にする。
- 日ごとの EVM snapshot row を worker で作る：過去の推移が見られるが、worker・保存 row・backfill が要る。却下。

## 結果

- Report に「SPI」「CPI」「EAC」を置ける。CSV/PDF にも出る。Table は Project ごとに BAC / PV / EV / AC の時間と値を出す。
- 1 query で Project ごとに予算・baseline・進捗方式・時間・経費の読み取りと Team の Work Item の読み取り（Team ごとに 1 回）が増える。
- 予算レポートの EVM と同じ値になる（AC の開始日が同じとき）。
- 更新した文書：`docs/analytics.md`、`docs/guide/pm.md`。
