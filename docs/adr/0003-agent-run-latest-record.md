# 0003. Work Item ごとの最新 Run を `agent-run-latest` row で強整合に持つ

- 状態: 採用
- 日付: 2026-11-19
- 関連: Issue #407, PR #521

## 背景

止まった Run の再開（resume）では、同じ Work Item の直前の Run を決め、その Run が `paused` などで
終わっていることを確かめてから新しい Run を始める。これまで Work Item の Run 一覧は
`WorkItemRunIndex`（GSI、`<startedAt>#<runId>` の降順）だけで読んでいた。GSI は結果整合のため、
始まった直後の Run がまだ index に出ず、古い Run を「直前の Run」と誤認して再開したり、
同時に始まった別の Run を見落としたりする。

resume、start、take over は Run・claim・Work Item revision などを 1 つの TransactWrite で確定しているが、
「直前の Run がまだ同じである」ことを条件にできる強整合の参照がなかった。

## 決定

`AgentRunsTable` の Team partition（`directoryTeamId`）に、Work Item ごとの
`agent-run-latest#<workItemId>` row を追加する。値は Work Item で最後に始まった Run の `runId` とする。

- start、take over、resume の transaction で、新しい Run の put と同時にこの row を書く。
- resume は row を強整合で読んで直前の Run を決め、transaction では row がまだその `runId` を指していることを
  条件に新しい Run へ置き換える。読み取り後に別の Run が始まった場合は条件が外れて `409` になる。
- Run 履歴の先頭ページはこの row も強整合で読み、index にまだない最新 Run を先頭に補う。
- start・take over・再開の新しい Run の `startedAt` は直前の Run より必ず後にし、row が指す Run と
  index の先頭を一致させる。
- row の導入前に最後の Run が始まった Work Item（row がない）は、従来どおり Run 履歴 index で
  直前の Run を決める。row がないことを transaction の条件にするため、同時に始まった Run とは競合として扱う。

## 検討した選択肢

- 選択肢 A: GSI だけで直前の Run を決める。追加の row は不要だが、結果整合のため直後の Run を見落とし、
  誤った Run から再開しうる。競合を transaction で検出できない。
- 選択肢 B: Work Item 側（Work Items table）に最新 Run ID を持つ。Work Item と同時に読めるが、
  Run の開始ごとに Work Item revision が変わり、無関係な Work Item 更新と競合する。table をまたぐ書き込みも増える。
- 選択肢 C: `AgentRunsTable` に専用 row を持つ（採用）。claim row と同じ partition・同じ transaction で
  維持でき、Work Item revision を動かさない。row 1 件分の書き込みと強整合読み取りが増える。

## 結果

- resume と Run 履歴の先頭が、index の反映を待たずに最新 Run を正しく扱える。
- start・take over・resume の transaction に 1 item 増える（TransactWrite の上限には十分余裕がある）。
- 既存の Work Item は最初の start / take over / resume で row が作られるまで index に頼るため、
  移行用の backfill は行わない。row のない Work Item が問題になれば backfill を検討する。
- 現在の契約は [`docs/software-factory.md`](../software-factory.md) の「永続化」と「止まった Run の再開」に書く。
