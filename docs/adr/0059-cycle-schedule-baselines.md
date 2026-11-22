# 0059. Cycle ごとの名前付き schedule baseline を、一覧の行と baseline ごとの行で Planning table に置く

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #336、ADR 0043、ADR 0016

## 背景

ADR 0043 で Project ごとの名前付き baseline を作り、Cycle 単位の baseline は「Work Item が Cycle を持つようになってから検討する」とした。Work Item は Planning の link（`cycleId`）で Cycle に入るので、Sprint を始めた時点のコミット（どの Work Item をいつまでに終える予定だったか）を Cycle ごとに残し、あとから追加・除外・遅れ・予定工数の増減を比べたい。

Project の baseline と違い、Cycle には複数の Team・Project の Work Item が入る。また Gantt・表・Focus・週次まとめは Project の基準の baseline を読むので、Cycle の baseline を「基準」にする必要はない。

## 決定

- Cycle の baseline は Planning table の 2 種類の行に置く。
  - 一覧の行 `CYCLE_SCHEDULE_BASELINE#<cycleId>`（`entryType` は `cycle-schedule-baseline-index`）: `revision` と、保存済み baseline の一覧 `savedBaselines`（ID・名前・保存時刻・Work Item 数、新しい順）。
  - baseline ごとの行 `CYCLE_SCHEDULE_BASELINE_SAVED#<cycleId>#<baselineId>`（`entryType` は `cycle-schedule-baseline-saved`）: entries（`teamId`・`workItemId`・予定開始日・予定終了日・予定工数）。
  - どちらの prefix も他方の key で始まらず、live graph の prefix（`ENTITY#`・`LINK#` など）でも始まらないので、Planning の graph 読み取りには入らない。
- 保存（`POST /api/planning/cycles/:cycleId/schedule-baselines`、任意の `name`）は Cycle の manager 権限（Enterprise では `planning.manage`、`/next` と同じ）が要る。保存する Work Item は、保存する人の Planning snapshot でその Cycle に入っている Work Item。一覧の行の `revision` を条件にした Put、baseline の行の `attribute_not_exists` の Put、上限を超えた分の Delete、呼び出し元の権限の ConditionCheck、audit event `cycle.schedule_baseline_captured` を 1 つの TransactWrite にする。
- 読み取り（`GET` 同じ path、`?baselineId=` で古いもの）は、読む人の snapshot に Cycle が見えるときだけ返す。entries は読む人の snapshot に見える Work Item だけに絞り、`entryCount` は全件を数える（Project の baseline の一覧と同じ）。
- 保存できる数は Cycle ごとに新しい順に 10。11 件目を保存すると最も古いものの行を同じ transaction で消し、audit の metadata に消した ID を残す。Cycle は短いので「基準」の切り替えは作らない。
- 比較（追加・除外・終了予定の遅れ・予定工数の増減）は Web が今の Planning snapshot と baseline から計算する。API は比較結果を持たない。
- audit event の changes には baseline ID・revision・保存時刻・Work Item 数だけを残し、名前・Work Item の ID と日付は残さない（ADR 0043 と同じ）。

## 検討した選択肢

- Project の baseline に Cycle の絞り込みを足す: Cycle は Team・Project をまたぐので Project の行に収まらず、Project の基準と混ざる。採らない。
- 1 つの行に Cycle の全 baseline を入れる: 1 baseline 最大約 100 KB なので 400 KB の item 上限に 3〜4 個しか入らない。採らない。
- 一覧を Query（`begins_with`）で読む: ADR 0043 と同じ理由（一覧と行の整合を別に守る必要がある）で採らない。
- Planning の graph の row にする: graph は Workspace 全体を毎回読むので、使わない entries まで毎回読むことになる。採らない。

## 結果

- 保存する人に見えない Work Item は baseline に入らない。保存は Cycle の manager が行う前提で、ほかの人がより多くの Work Item を見られる場合、その差は「追加」に出る。
- Cycle を archive・削除しても baseline の行は残る（1 Cycle あたり最大 11 行・約 1 MB）。Cycle の ID は再利用しない。DynamoDB の保存料は Cycle 100 個で月 $0.03 程度に収まる。
- 保存の transaction は最大で一覧の行・baseline の行・Delete 1 つ・権限の ConditionCheck・audit の数件で、上限の 100 件と 4 MB に収まる。
- 文書: `docs/planning.md`「Cycle の schedule baseline」、`docs/guide/pm.md`。
