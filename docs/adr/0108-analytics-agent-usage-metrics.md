# 0108. Analytics の `agent-tokens` / `agent-cost` は query のたびに終了済み Run と usage 行を読み、費用を見られる Team を snapshot の scope に固定する

- 状態: 提案
- 日付: 2026-11-26
- 関連: Issue #729, Issue #355, [ADR 0061](0061-agent-token-usage-over-otlp.md),
  [ADR 0006](0006-finished-run-index.md), [docs/analytics.md](../analytics.md)

## 背景

ADR 0061 で coding agent のトークン数と推定費用を OpenTelemetry で受け、Work Item の Run 一覧と Factory board の
期間サマリーで見せた。Analytics engine の widget・保存済み report・snapshot・CSV/PDF export でも同じ値を使いたい。
Analytics は Work Item の canonical row と audit event を同じ認可境界で読んで計算し、Agent Run の table は読んでいなかった。
推定費用は Team manager にだけ見せる約束があり、snapshot は作った後も一覧・export のたびに現在の権限で
再検証する（permission scope hash）。Shinji の方針は「なるべく安く」。

## 決定

- **Metric**：`agent-tokens`（unit `tokens`）と `agent-cost`（unit `usd`）を足す。期間内（`asOf` まで）に終わった
  Agent Run の usage を、その Run の Work Item に寄せて足す。トークンは入力・出力・prompt cache の読み取り・書き込みの合計。
  Chart の bucket は Run の終了時刻で分け、Team・Project・担当者などの group は他の metric と同じく `asOf` 時点の
  Work Item の state で分ける。Evidence は Run ごとに 1 件。
- **読み方**：該当 widget を含む query のときだけ、API が認可済み Work Item の Team ごとに終了済み Run の index
  （ADR 0006）を期間の両端で読み、認可済み Work Item の Run だけを残す。Run を強整合で読み直し、ADR 0061 と同じ
  割り当てで usage 行を読む。1 query で 500 Run を超えるか、index を 100 page 読んでも終わらなければ、部分集計を返さず `413`
  （`AnalyticsAgentUsageLimitExceeded`）にする。usage のない Run は数えない。新しい保存 row・index・事前集計は作らない。
- **費用の権限**：`agent-cost` を含む query では、Work Item の Team のうち閲覧者が manager である Team を読み、
  その Team の Run だけを数える。費用は Team の全 Project の Run を足すので、manager は ADR 0087 と同じく Team の全
  active Project の manager（Enterprise では Team または Workspace の `teams.manage`）とし、一部の Project だけの
  manager は含めない。それ以外の Run は件数を warning で知らせ、数えられる Run がない group の値は
  `null` にする。Manager である Team の集合を snapshot の permission scope hash に加え、manager でなくなった人には
  その snapshot を一覧・export で見せない。`agent-cost` のない query の hash は変えない。
- **使えないとき**：Software factory を deploy していない環境と定期配信の runner は usage を読まず、widget は
  `Agent Run usage is not available for this run.` の warning だけを返す（hash にも Team を加えない）。

## 検討した選択肢

- 受信時に Work Item・日ごとの集計行を作る：query は軽くなるが、受信時には Run が分からず（ADR 0061）、Run の
  終了後に集計行を作る worker と backfill が要る。却下。
- 上限を超えたら新しい Run だけで部分集計し warning にする：Factory board の期間サマリーと同じ扱いだが、
  Analytics は上限で `413` にする約束（`docs/analytics.md`）なので合わせる。却下。
- 費用を manager 以外にも 0 として返す：値が 0 に見えて誤解を招く。却下。
- 定期配信でも usage を読む：runner の閲覧者の Team 権限で費用を絞る仕組みがまだない。Milestone trend と同じく
  warning にする。

## 結果

- Report に「エージェントのトークン」「エージェントの推定費用」を置ける。CSV/PDF にも出る。
- 1 query で usage の Query が最大 1,000 回（Run 500 件 × Run と usage）増える。期間を短くするか Team / Project で
  絞れば上限に当たりにくい。
- 終了済み Run の index は結果整合なので、終わった直後の Run は数秒ほど入らないことがある。
- Codex / Kiro の usage は ADR 0061 の後続（#729）で、届けば同じ metric に入る。
- 更新した文書：`docs/analytics.md`、`docs/software-factory.md`、`docs/guide/pm.md`、`docs/guide/coding-agent.md`。
