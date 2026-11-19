# 0011. 期限通知の schedule を Work Items table の sparse な期限 index で読む

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #373、Issue #365、PR #520、[docs/notifications.md](../notifications.md)「Due / overdue scan」

## 背景

期限当日・超過・期限前・再通知・escalation・未更新の督促は、毎時 Work Items table 全体を強整合で
scan して対象を探していた。読み取り費用は完了・archive 済みを含む全履歴に比例し、1,000 page
（100,000 row）の上限を超えると期限通知そのものが止まる。同じ scan で Customer 完了通知の marker と、
工数の督促を送る Team の一覧も集めていた。

制約は次のとおり。

- 常時の固定費を増やさない（新しい table・常駐 worker を足さない）。
- 読み取り量を「期限の近い未完了 Work Item の数」に比例させ、page 上限を撤廃する。
- 完了・archive・期限変更で index から外れる。
- 通知の重複排除 key（期限と理由）を変えない。
- index の key 属性を書き込み経路ごとに手で維持するため、維持の漏れが通知の取りこぼしにつながる。

## 決定

- Work Items table に sparse GSI `WorkItemNotificationDueIndex` を足す。partition は
  `notificationScheduleShard`（`work-item-schedule-00..15`、Workspace・Team・Work Item ID の sha256 で決める
  固定の shard）、sort は `notificationDueKey`、projection は ALL。
- `notificationDueKey` は archive されていない未完了の Work Item だけが持つ。`backlog` / `unstarted` は
  期限があるときだけ期限日（`YYYY-MM-DD`）、`started` は未更新の督促のため期限に関係なく `0000-00-00`
  （毎回読む）。完了・中止・archive・期限の削除で消す。
- `notificationScheduleShard` は row の key だけで決まるため、作成時と毎回の更新で書く。index 属性の
  ない既存 row は次の更新で index に載る。既存 row への一括付与は #365 の migration 契約で行う。
- 属性は Work Item の作成・更新・日程の連鎖更新・承認による状態遷移の各書き込みで、本体と同じ
  UpdateItem / Put の中で計算して書く。計算は `work-items` module の
  `work-item-notification-schedule-index.ts` に 1 か所だけ置く。
- schedule は shard ごとに `notificationDueKey <= 今日（UTC）+ 366 日` を昇順に読み、page 上限なしで最後まで
  読む。366 日は期限前通知の日数の上限（365 日）と timezone の余裕 1 日。index の item で段階が出るときだけ
  base table を強整合で読み直して評価する。
- Customer 完了通知の marker は、同じ shard を partition、既存の `customerCompletionPreparationAt` を sort に
  した sparse GSI `WorkItemCustomerCompletionPreparationIndex`（KEYS_ONLY）で読む。marker の付与・削除は
  既存の書き込みのままで index に反映される。
- 工数の督促の Team 一覧は、督促を送る 1 日 1 回の実行だけ Project directory table を読んで作る。

## 検討した選択肢

- 選択肢 A（採用）: sparse な期限 GSI と marker GSI を足し、key 属性は書き込み時に計算する。
  利点: 読み取りが対象の数に比例し、上限で通知が止まらない。完了した履歴を読まない。
  欠点: GSI 2 本分の書き込みと保存の費用（未完了 row と短命な marker だけ）。書き込み経路を増やすときに
  属性の維持を忘れると通知が漏れる。既存の環境に足すときは CloudFormation の 1 回の更新で GSI を 1 本しか
  作れないため、2 回に分けて deploy する。
- 選択肢 B: Planning update と同じように「次に通知する時刻」を sort key にする。利点: 読む量が最小。
  欠点: 時刻は受け取る人の日数設定（個人・Team）で変わり、設定の変更で全 row を書き直す必要がある。
- 選択肢 C: 1 本の GSI に marker も sentinel の sort key で載せる。利点: GSI が 1 本で済む。
  欠点: marker の有無を知らない書き込み経路（承認による状態遷移）が marker の row を index から外しうる。
- 選択肢 D: 既存の `dueDate` をそのまま sort key にする。利点: 属性の維持が要らない。欠点: 完了・archive
  した row が index に残り、読み取りが履歴に比例する。

## 結果

- 期限通知の読み取りが Work Item の総数ではなく、期限が近い・超過した・着手中の未完了 Work Item の数に
  比例する。`NOTIFICATION_SCHEDULE_MAX_PAGES` は Planning の index と directory の読み取りにだけ残る。
- 期限前通知の日数を 365 日まで設定できるため、query は 1 年先までの期限を読む。日数の大きい設定が
  実際に少ないなら、設定の最大値を記録して範囲を狭めることを検討する。
- 超過したまま放置された Work Item は完了するまで毎回読まれる（超過の再通知のために必要）。
- 更新した文書: `docs/notifications.md`、`cdk/README.md`。
