# 0009. Cycle の自動作成・自動繰り越しを既存の due index と scheduled-jobs で動かす

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #387、[docs/planning.md](../planning.md)「Cycle の自動作成・自動持ち越し・一括追加」

## 背景

Cycle に「終了日の 3 日前に次の Cycle を作る」「終了日の翌日に未完了を次の Cycle に繰り越す」自動化を付ける。
期日の来た Cycle を、Workspace の Planning graph 全体を読まずに見つける必要がある。

制約は次のとおり。

- 常時の固定費を増やさない（新しい table、常駐の worker、時間課金のサービスを足さない）。
- 1 回の実行の読み取り量を Cycle の総数ではなく、期日の来た Cycle の数に比例させる。
- 失敗を握りつぶさず、既存の再試行・failure destination・DLQ alarm に乗せる。

## 決定

- Planning table の既存の sparse GSI `UpdateScheduleDueIndex`（partition `updateScheduleShard`、sort
  `nextNotificationAtRecordKey`、KEYS_ONLY）を Cycle にも使う。自動化が有効で次の手順が残っている Cycle の
  `ENTITY#` row だけが、`planning-cycle-00..15` の shard と `<期日>#<sha256>` の sort key を持つ。
  Project / Initiative 更新の通知は `planning-update-NN` の shard だけを読むので、互いの row を読まない。
  手順が終わる（Cycle が完了・取り消し・archive、自動化がオフ）と、同じ commit で 2 つの属性を消す。
- 既存の scheduled-jobs Lambda に `cycle-schedule` job（60 分ごと、3 回試行、runtime control は
  `automation-schedule`）を足す。新しい Lambda や EventBridge rule は作らない。
- Job は shard ごとに期日を過ぎた row を Query し、Cycle ごとに「次の Cycle を作る」「49 件ずつ繰り越す」を
  やることがなくなるまで繰り返す。手順は通常の `mutate()`（Planning META の revision CAS）で書く。
- 読み取りは `CycleScheduleSource` port の背後の DynamoDB adapter で行い、adapter-in は DynamoDB に触れない。
- 失敗した Cycle は期日のまま index に残り、ほかの Cycle の処理は続ける。失敗、Cycle ごとの 20 手順の上限で
  終わらなかった Cycle、または shard ごとの 100 page 上限での打ち切りがあれば、実行全体を reject して
  dispatcher の再試行と alarm に乗せる。
- 前の Cycle の繰り越しが残っている Cycle は、自分の繰り越し（完了）を待つ。job が止まっていて両方の期日を
  過ぎていても、前の Cycle の未完了 Work Item は取り残されない。
- 自動化は呼び出し元なしで `/next` と rollover を行うため、設定には Cycle の scope での manager 権限
  （Enterprise では `planning.manage`）を要求する。

## 検討した選択肢

- 選択肢 A（採用）: 既存の sparse GSI を shard 名で分けて共用し、既存の scheduled-jobs に job を足す。
  利点: 新しい GSI・table・Lambda がなく固定費が増えない。読み取りは期日の来た Cycle の数に比例する。
  欠点: 通知と Cycle が同じ GSI の容量を分け合う（on-demand なので費用は使った分だけ）。GSI の
  partition key の query は shard 名の完全一致なので、互いの row は読まれない。
- 選択肢 B: Cycle 専用の GSI を足す。利点: 分離がはっきりする。欠点: GSI の追加は deploy 時の
  backfill と IAM の変更を伴い、得られる差は名前空間の分離だけである。
- 選択肢 C: 毎時 Workspace ごとに Planning graph を全件読む。欠点: 読み取りが Cycle の総数と
  Workspace 数に比例し、graph の上限（20,000 row）に近い Workspace ほど高くつく。

## 結果

- 期日の来た Cycle だけを読んで、次の Cycle の作成と繰り越しを自動で行える。
- 中断していた job が再開すると、遅れた分の手順を前の Cycle から順に追いつく。
- 永続化された続きの位置（checkpoint）は持たない。1 shard に 10,000 件を超える期日の Cycle が溜まると
  実行が失敗になり alarm で分かる。そこまで溜まる実績が出てから checkpoint を検討する。
- 更新した文書: `docs/planning.md`、`docs/guide/pm.md`。
