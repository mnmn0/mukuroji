# 0011. Project の schedule baseline を Planning table の 1 行に保存する

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #336、PR #565

## 背景

#336 では、Project の計画を承認した時点の Work Item の予定日を固定し、現在の予定との差（slip）を出す。最初の範囲では Project ごとに最新の baseline が 1 つあればよい。Work Item の table は Team ごとの partition に Work Item の行が並び、一覧 query がその partition を読むため、別種の行を混ぜられない。

## 決定

- baseline は既存の Planning table（`workspaceId` + `recordKey`）に置く。`recordKey` は `PROJECT_SCHEDULE_BASELINE#<teamId>#<projectId>`（各 ID は URI encode）とし、Project ID が Team をまたいで重複しても衝突しないよう Team で修飾する。`entryType` は `project-schedule-baseline`、`schemaVersion` は 1。
- 1 Project 1 行で、全 Work Item の `workItemId`・予定開始日・予定終了日を `entries` に持つ。1 Team 1,000 件を上限にし（超えると 413）、1 entry 約 80 byte なので DynamoDB の 400 KB の item 上限に収まる。
- 保存は置き換えで、`revision` を 1 ずつ進める。use case は Work Item を読む前に現在の revision を読み、その revision を条件にして書く。読んでいる間に別の保存が入ると 409 になり、古い snapshot で新しい baseline を上書きしない。
- 書き込みには呼び出し元の membership / Enterprise revision の ConditionCheck を同じ transaction に入れる（Planning の他の行と同じ）。

## 検討した選択肢

- Work Item の行に baseline の日付を持たせる: Project manager だけが変えられるという制約を Work Item の更新経路に入れる必要があり、保存のたびに全 Work Item の revision が進む。採らない。
- Work Item ごとに 1 行の baseline: 保存が多数の書き込みになり、1,000 件では transaction の上限（100 件）を超える。採らない。
- 新しい table: 1 Project 1 行の小さい記録のために table を増やす費用に見合わない。

## 結果

- 名前付きの複数 baseline を持つときは、`recordKey` に baseline ID を足した別の行を使う（新しい ADR で決める）。
- 1 Team が 1,000 件を超えると baseline を保存・読み取りできない。超える Team が出たら分割を検討する。
