# 0090. 期限前の rule は通知用の期限 index から Work Item を選び、営業日の繰り返しは実行時に Team の稼働カレンダーで数える

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #393, PR #783, ADR 0022, ADR 0058

## 背景

Automation rule に「期限の n 日前に担当者へ通知する」と、繰り返し作業に「月末」「第 n 営業日」を加える（#393）。

- 既存の trigger は1つの event に対して rule を1回動かす。期限前の rule は時刻で動き、対象の Work Item が複数ある。
  Automation 側には Work Item を期限で探す手段がない。
- 繰り返し作業の次回実行は保存時に決めて ScheduleDueIndex に載せる。営業日は Team の稼働カレンダー（ADR 0058）で決まり、
  休日は保存後にも変わる。

## 決定

- 期限前の rule は `schedule` trigger の任意項目 `dueWorkItems: { daysBefore }`（0〜365）で表す。新しい trigger 種別は作らない。
  - schedule の各実行時刻で、その time zone の日付に `daysBefore` 日を足した日を期限とする未完了の Work Item を読み、
    1件ずつ rule を動かす。event ID は `scheduled-rule:<rule>:<実行時刻>:due:<team>:<item>` で、同じ実行時刻の再処理は
    既存の execution を再開する。
  - Work Item は Work Items table の `WorkItemNotificationDueIndex`（ADR 0022）から読む。16 shard ごとに、期限の日付の key と、
    着手済みの Work Item が持つ `0000-00-00` の key を Query し、Workspace の `directoryTeamId` 接頭辞と `dueDate` で絞る。
    取得後は Work Item を強整合で読み直し、期限が変わっていれば動かさない。
  - 1件の失敗はその execution の再試行に任せ、実行時刻の完了は止めない。
- notify action に `notifyAssignee` を加え、rule が対象にしている Work Item の担当者にも通知できるようにする。
  受信者は `recipientMemberKeys` と担当者の和で、どちらか一方は必須。
- 月の日の決め方として `RecurringSchedule.monthlyDay` を加える。`day-of-month`（既定、省略）、`last-day`、`business-day`。
  - `last-day` は日付だけで決まるので、rule と繰り返し作業の両方で使える。
  - `business-day` は `dayOfMonth`（1〜23）を第 n 営業日として扱い、繰り返し作業だけで受け付ける。
    保存時の次回実行は「暦の n 日」で計算する。第 n 営業日はこの日より前にならないため、ここが下限になる。
    その月の暦の n 日を過ぎてから保存した場合は、翌日の実行時刻を次回実行にして、同じ月の第 n 営業日を逃さない。
  - 繰り返し作業の実行時に、owner Team の有効な稼働カレンダー（稼働曜日と休日）を読み、前回実行（なければ作成時刻）から
    現在までの営業日ベースの実行時刻を数える。まだ来ていなければ、`deferRecurringWork` で次回実行を実際の営業日へ
    revision 付きで後ろへずらし、実行済みの slot は変えない。
  - 実際の営業日が同じ月にある間は、待つ先を毎日の実行時刻にして、そのたびにカレンダーを読み直す。
    休日を外すなど営業日が前に動く変更も、その日のうちに反映される。

## 検討した選択肢

- 期限前の Work Item の選び方
  - 選択肢 A（採用）: 既存の通知用期限 index を読む。
    - 利点: 新しい index や書き込みが要らず、未完了で期限のある Work Item だけを読む。
    - 欠点: 着手済みの Work Item は期限に関係なく `0000-00-00` にあるため、その分を Workspace と期限で絞る読み取りが増える。
  - 選択肢 B: Automation 専用の期限 index を Work Item の書き込みで作る。
    - 利点: Workspace と期限で直接読める。
    - 欠点: Work Item の全書き込み経路と backfill に手が入る。
- 営業日の扱い
  - 選択肢 A（採用）: 保存時は暦の n 日を下限として登録し、実行時にカレンダーで数えて後ろへずらす。
    - 利点: 保存後の休日変更も実行時に反映され、カレンダーが変わったときの再計算 job が要らない。
    - 欠点: 下限の時刻に一度起きて次回実行を書き直す。
  - 選択肢 B: 保存時にカレンダーで次回実行を決める。
    - 利点: 実行時の読み取りが減る。
    - 欠点: 休日の追加や削除のたびに、影響する定義の再計算が要る。

## 結果

- 「期限 3 日前に担当者へ通知」は、毎日の schedule rule に `dueWorkItems: { daysBefore: 3 }` と `notifyAssignee` の notify action で作れる。
- 期限前の rule は rate limit を Work Item ごとの実行で数える。対象が多い Workspace では rate limit を上げる必要がある。
- 営業日の繰り返し作業は、暦の n 日から実際の営業日まで、毎日1回次回実行を書き直す（月に数回の書き込み）。
- 着手済みの Work Item が多い Workspace ほど、期限前の rule 1回あたりの読み取りが増える。
