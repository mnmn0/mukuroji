# 0119. coding agent の推定費用を、Workspace が決めた固定の USD レートで換算し、Project 予算の実績・閾値通知・EVM に含めるかを Workspace 設定で選ぶ

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #837、Issue #835、[ADR 0061](0061-agent-token-usage-over-otlp.md)、[ADR 0065](0065-project-budget-report-and-evm.md)、
  [ADR 0104](0104-project-expense-entries.md)、[ADR 0105](0105-project-budget-threshold-alerts.md)、
  [ADR 0108](0108-analytics-agent-usage-metrics.md)、[docs/time-tracking.md](../time-tracking.md)

## 背景

Project 予算の実績は「工数のコスト + 承認済みの経費」（ADR 0104）で、予算消化率の閾値通知（ADR 0105）と予算レポートの
金額の EVM（CPI / EAC）も同じ値を使う。coding agent の推定費用は OTel で Run ごとに届き（ADR 0061）、Analytics の
`agent-cost`（ADR 0108）で見られるが、通貨は USD（100 万分の 1 ドル単位）で、予算（既定 JPY）とは単位が違う。
#837 はこれを予算の実績と alert に入れることを求め、後続の #835（Work Item 単価）も同じ換算を使う。
Shinji の方針は「なるべく安く」。

## 決定

1. **換算レートの置き場所**：Workspace の profile（tenant administration table の既存の profile 行）に
   `agentCost: { includeInProjectBudgets, usdExchangeRates }` を足す。`usdExchangeRates` は通貨ごとの
   「1 USD あたりの主単位」（例 `{ JPY: 150 }`）で、Workspace の管理者が設定画面で決める。0 より大きく 1,000,000 以下、
   小数 6 桁まで、20 通貨まで。USD の予算は 1 で換算し、`USD` の行は持たない。保存は既存の
   `PATCH /api/tenant/profile`（Workspace 管理者だけ、revision 付き、audit あり）で、新しい行・table は作らない。
2. **換算のしかた**：レートは読み取りのたびに今の値を使う（Run ごとの当時のレートは持たない）。レートを変えると過去の分も
   新しいレートで数え直す。日ごとの USD 合計を 1 回だけ換算して最小単位に丸め、累積の series と合計を一致させる。
   換算は `@mukuroji/contracts` の `convertAgentCostMicroUsdToMinor` / `resolveAgentCostUsdExchangeRate` にまとめ、#835 も使う。
3. **何を数えるか**：予算レポートの期間（`from`〜`asOf`、閾値通知では予算期間〜今日）に終わった Agent Run のうち、
   **今その Project にある Work Item** の Run（Analytics と同じく今の state で寄せる）。Run の費用は ADR 0061 と同じ割り当てで
   usage 行から読み、終了日は予算の time zone の日付で数える。費用が届いていない Run は数えない。
4. **一つの設定で揃える**：`includeInProjectBudgets` が on のとき、予算レポートの実績コスト・消化率・累積 series・金額の
   EVM（CPI / EAC / ETC / VAC）・CSV と、毎朝の閾値通知の消化率に同じ値を足す。報告と通知の数え方を揃える約束
   （ADR 0105）を守るため、通知と EVM を別々に選ぶ設定にはしない。既定は off で、off のときは Agent Run を読まない。
   予算の通貨のレートがなければ足さず、レポートに `agentCost.status = 'missing-exchange-rate'` と USD の額を出す。
5. **誰に見えるか**：予算レポートは今どおり Project manager だけが読み、通知は割合だけを持つ（ADR 0105）。Project manager に
   見えるのはその Project の Work Item の Run の合計だけで、Run ごとの費用や Team 全体の費用（ADR 0108 の Team manager 限定）
   は広げない。Workspace 管理者が設定を on にすることで、Project の AI コストを Project の予算として扱うと決める。
6. **上限**：1 回の計算で、予算の time zone の日付で期間内に終わった費用のある Run を 1,000 件（期間外の Run は上限に数えない）、Team の終了済み Run index を 100 page まで読む。index は新しい Run から
   返すので、超えたときは新しい Run の分だけを数えて `agentCost.truncated = true` にし、値は下限として表示する
   （閾値通知も下限で判定する）。失敗した Run とそれ以外の Run の index は交互に読んで終了時刻で混ぜ、新しい順の約束を
   結果で守る。閾値通知が Project の Work Item を探す Team の Work Item 読み取りは 200 page までで、超えたら一部だけで
   数えずにその Workspace の判定を失敗にする（既存の Workspace ごとの失敗処理に乗る）。報告期間が今日より後なら読まない。
   Software factory を deploy していない環境では読まない。
7. **通知の schedule job**：Software factory を deploy した stack では、notification schedule job に Agent Runs table の
   `GetItem` / `Query`（table と `FinishedRunIndex`）の読み取り権限と `AGENT_RUNS_TABLE_NAME` を足す。Work Items table は
   既に読める。
8. **PMO dashboard（Team portfolio）と Analytics の EVM metric（ADR 0110）には足さない**。前者は全 Project の Run を
   毎回読むことになり、後者は工数（分）だけの指標だからである。

## 検討した選択肢

- 為替 API から日々のレートを取る：外部通信と secret・費用が増え、同じ snapshot の再現性も落ちる。予算の見積もりには
  管理者の固定レートで足りる。却下。
- Run の受信時・終了時に予算通貨へ換算して保存する：受信時には Run が分からず（ADR 0061）、レート変更で
  backfill が要る。行も増える。却下。
- Project ごと・予算ごとにレートを持つ：Workspace で 1 つのレートを使えば #835 とも揃い、設定箇所が少ない。却下。
- 通知と EVM に含めるかを別々の設定にする：レポートの消化率と通知の消化率が食い違う。却下。
- AI コストの行は Team manager にだけ見せる：消化率と EVM は Project manager に見えるので、合計を隠しても差から
  分かってしまう。Workspace の設定で明示的に含めると決める方にした。

## 結果

- Workspace の設定に「coding agent の推定費用」（含めるかと 1 USD あたりのレート）が増える。
- 予算レポートに `agentCost`（状態・USD・換算額・レート・Run 数・下限か）が増え、実績コストの注記に AI コストが出る。
- on の Workspace では、予算レポート 1 回あたり Agent Runs table の読み取りが最大で Run 数 × 2 回と index 100 page 増える。
  閾値通知も Project ごとに同じ量と Team の Work Item の読み取りが増える（50 人規模なら月数十円程度）。
- 更新した文書：`docs/time-tracking.md`、`docs/guide/pm.md`、`docs/guide/admin.md`。
