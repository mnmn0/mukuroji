# 0119. coding agent の推定費用は USD のまま Project 予算レポートに出し、USD の予算だけ実績・閾値通知・EVM に足すかを Workspace 設定で選ぶ

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #837、Issue #835、[ADR 0061](0061-agent-token-usage-over-otlp.md)、[ADR 0065](0065-project-budget-report-and-evm.md)、
  [ADR 0104](0104-project-expense-entries.md)、[ADR 0105](0105-project-budget-threshold-alerts.md)、
  [ADR 0108](0108-analytics-agent-usage-metrics.md)、[docs/time-tracking.md](../time-tracking.md)

## 背景

Project 予算の実績は「工数のコスト + 承認済みの経費」（ADR 0104）で、予算消化率の閾値通知（ADR 0105）と予算レポートの
金額の EVM（CPI / EAC）も同じ値を使う。coding agent の推定費用は OTel で Run ごとに届き（ADR 0061）、Analytics の
`agent-cost`（ADR 0108）で見られるが、通貨は USD（100 万分の 1 ドル単位）で、予算（既定 JPY）とは単位が違う。
#837 はこれを予算の実績と alert に入れることを求め、後続の #835（Work Item 単価）も同じ扱いを使う。
Shinji の方針は「なるべく安く」で、2026-11-28 に「円に換算せずにドルのままでいい」と決めた。

## 決定

1. **換算しない**：推定費用は USD のまま扱い、為替レートは持たない。Workspace の profile（tenant administration table の
   既存の profile 行）に `agentCost: { includeInProjectBudgets }` だけを足す。保存は既存の `PATCH /api/tenant/profile`
   （Workspace 管理者だけ、revision 付き、audit あり）で、新しい行・table は作らない。
2. **どこに足すか**：`includeInProjectBudgets` が on のとき、予算レポートは Project の推定費用を USD で出す。
   予算が USD なら（`agentCost.status = 'included'`）、日ごとの合計を 1 回だけ cent に丸めて実績コスト・消化率・累積 series・
   金額の EVM（CPI / EAC / ETC / VAC）・CSV と、毎朝の閾値通知の消化率に同じ値を足す。予算が USD 以外なら
   （`'separate-currency'`）実績には足さず、レポートに USD の額を別に並べる。閾値通知はこのとき Agent Run を読まない。
   報告と通知の数え方を揃える約束（ADR 0105）を守るため、通知と EVM を別々に選ぶ設定にはしない。既定は off で、off のときは
   Agent Run を読まない。cent への丸めは `@mukuroji/contracts` の `agentCostMicroUsdToCents` にまとめ、#835 も使う。
3. **何を数えるか**：予算レポートの期間（`from`〜`asOf`、閾値通知では予算期間〜今日）に、予算の time zone の日付で終わった
   Agent Run のうち、**今その Project にある Work Item** の Run（Analytics と同じく今の state で寄せる）。Run の費用は
   ADR 0061 と同じ割り当てで usage 行から読む。費用が届いていない Run は数えない。
4. **誰に見えるか**：予算レポートは今どおり Project の manager（その Team の manager と Workspace 管理者を含む）が読み、
   通知は割合だけを持つ（ADR 0105）。予算レポートに出るのはその Project の Work Item の Run の合計だけで、Run ごとの費用は
   出さない。Workspace 管理者が設定を on にすることで、Project の AI コストを Project の予算として扱うと決める。
   Run ごとの費用や Team 全体の費用を誰に見せるか（ADR 0108）は、この ADR では変えない。
5. **上限**：1 回の計算で、日付の範囲内に終わった費用のある Run を 1,000 件（範囲外の Run は上限に数えない）、Team の
   終了済み Run index を 100 page まで読む。index は新しい Run から返すので、超えたときは新しい Run の分だけを数えて
   `agentCost.truncated = true` にし、値は下限として表示する（閾値通知も下限で判定する）。失敗した Run とそれ以外の Run の
   index は交互に読んで終了時刻で混ぜ、新しい順の約束を結果で守る。閾値通知が Project の Work Item を探す Team の Work Item
   読み取りは 200 page までで、超えたら一部だけで数えずにその Workspace の判定を失敗にする（既存の Workspace ごとの失敗処理に
   乗る）。報告期間が今日より後なら読まない。Software factory を deploy していない環境では読まない。
6. **通知の schedule job**：Software factory を deploy した stack では、notification schedule job に Agent Runs table の
   `GetItem` / `Query`（table と `FinishedRunIndex`）の読み取り権限と `AGENT_RUNS_TABLE_NAME` を足す。Work Items table は
   既に読める。
7. **PMO dashboard（Team portfolio）と Analytics の EVM metric（ADR 0110）には足さない**。前者は全 Project の Run を
   毎回読むことになり、後者は工数（分）だけの指標だからである。

## 検討した選択肢

- Workspace 管理者が決めた固定の為替レートで予算の通貨に換算する：最初はこの案で実装したが、Shinji が USD のままでよいと
  決めた。レートの設定・検証・変更時の再計算が要らず、為替の見積もり誤差も入らない。却下。
- 為替 API から日々のレートを取る：外部通信と secret・費用が増え、同じ snapshot の再現性も落ちる。却下。
- USD 以外の予算でも消化率に足す：単位の違う額を足すことになる。経費の他通貨（ADR 0104）と同じく別に出す。却下。
- 通知と EVM に含めるかを別々の設定にする：レポートの消化率と通知の消化率が食い違う。却下。

## 結果

- Workspace の設定に「coding agent の推定費用」（予算レポートに出すか）が増える。
- 予算レポートに `agentCost`（状態・USD・USD 予算に足した cent・Run 数・下限か）が増え、USD 予算では実績コストの注記に、
  それ以外では別の注記に AI コストが出る。
- on の Workspace では、予算レポート 1 回あたり Agent Runs table の読み取りが最大で Run 数 × 2 回と index 100 page 増える。
  閾値通知は USD の予算だけ、Project ごとに同じ量と Team の Work Item の読み取りが増える（50 人規模なら月数十円程度）。
- 予算が円の Project では、AI コストは消化率の通知と CPI / EAC に入らない。
- 更新した文書：`docs/time-tracking.md`、`docs/guide/pm.md`、`docs/guide/admin.md`。
