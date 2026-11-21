# 0043. 名前付きの複数 schedule baseline を、基準の行と baseline ごとの行に分けて Planning table に置く

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #336、ADR 0016

## 背景

ADR 0016 では Project ごとに最新の baseline を 1 行だけ持ち、保存し直すと前の baseline は残らなかった。#336 の残りとして、計画承認・再計画などの節目ごとに名前を付けて baseline を残し、どれと比べるかを切り替えたい。また Work Item ごとに予定工数も固定したい。

一方で、Gantt・表・週次まとめ・Focus の `slipped`（PR #678）は「Project の baseline」を 1 つ読む前提で作られている。読む側をすべて複数対応にすると変更が広がり、1 回の Focus 読み取りで Project ごとに複数行を読むことになる。

## 決定

- Project ごとに **基準（active）の baseline** を 1 つ決め、これまでと同じ行（`PROJECT_SCHEDULE_BASELINE#<teamId>#<projectId>`）に置く。この行は基準の baseline の entries に加えて、`id`・`name` と、保存済み baseline の一覧 `savedBaselines`（ID・名前・保存時刻・Work Item 数。entries は持たない）を持つ。Gantt・表・Focus・Planning update はこれまでどおりこの行だけを読む。
- 保存した baseline はそれぞれ別の行 `PROJECT_SCHEDULE_BASELINE_SAVED#<teamId>#<projectId>#<baselineId>`（`entryType` は `project-schedule-baseline-saved`）にも置く。基準の行と prefix が違うので、どちらの key も他方の key で始まらない。
- 保存（`POST .../schedule-baseline`、任意の `name`）は新しい baseline を作って基準にする。切り替え（`PUT .../schedule-baseline/active`、`baselineId` と `expectedRevision`）は保存済みの行の entries を基準の行に写す。どちらも基準の行の `revision` を条件にした Put、保存済みの行の `attribute_not_exists` の Put、上限を超えた分の Delete、呼び出し元の権限の ConditionCheck、audit event を 1 つの TransactWrite にする。
- 一覧は基準の行の中にあるので、一覧を読むのに Query は要らず、一覧と保存済みの行の整合は基準の行の revision で守られる。
- 保存できる数は Project ごとに 20。超えると、基準ではない最も古いものの行を同じ transaction で消し、audit event の metadata に消した ID を残す。
- ADR 0016 の形式で保存された行（`id` が無い）は、読むときに `legacy-r<revision>` の ID で一覧に出し、次の保存か切り替えのときに保存済みの行として書き出す。移行の batch は要らない。
- entries に `plannedEffortMinutes`（保存時の予定工数）を足す。古い行の entry には無く、その Work Item の工数差は出さない。
- audit event は `project.schedule_baseline_captured`・`_replaced` に加えて切り替えの `project.schedule_baseline_activated` を書く。changes には baseline ID・revision・保存時刻・Work Item 数だけを残し、名前・Work Item の ID と日付は残さない。

## 検討した選択肢

- baseline ごとの行だけを持ち、基準は ID だけを持つ: 読む側が毎回 2 行読むことになり、Focus（最大 100 Project）の読み取りが倍になる。採らない。
- 一覧を Query（`begins_with`）で読む: 一覧と基準の行を別々に読むと、その間に保存が入ったときの整合を別に守る必要がある。採らない。
- 基準の行に全 baseline の entries を持つ: 1 baseline 最大約 100 KB なので 400 KB の item 上限に 3〜4 個しか入らない。採らない。
- 新しい table: 小さい行のために table を増やす費用に見合わない（ADR 0016 と同じ）。

## 結果

- 基準の baseline の entries は基準の行と保存済みの行に重複して入る。1 Project あたり最大 21 行・約 2 MB で、DynamoDB の保存料は月 $0.0005 程度に収まる。
- 保存・切り替えの transaction は最大で基準の行・保存済みの行 2 つ・Delete 2 つ・権限の ConditionCheck・audit の数件で、上限の 100 件と 4 MB に収まる。
- 名前を付けた Cycle 単位の baseline は、Work Item が Cycle を持つようになってから検討する（今は Project 単位で、名前で区別する）。
- 文書: `docs/work-items.md`「Schedule baseline と slip」、`docs/planning.md`（Planning update の evidence）、`docs/guide/pm.md`。
