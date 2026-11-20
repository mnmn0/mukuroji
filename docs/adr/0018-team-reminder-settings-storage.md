# 0018. Team の通知日数設定を NotificationsTable の Workspace 内 partition に保存する

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #395, PR #520, PR #465

## 背景

期限前・再通知・escalation・未更新の督促・工数の督促の日数は、これまで schedule Lambda の環境変数だけで決まっていた。
Issue #395 で Team ごと・本人ごとに変えられるようにする。本人の設定は既存の通知設定の行（NotificationsTable の
member partition）に足せるが、Team の設定には保存先がない。

制約は次のとおり。

- schedule は 1 回の実行で Team ごとに 1 回だけ設定を読むため、Team 単位の get が 1 回で済む key が要る。
- Workspace の削除・export は NotificationsTable の `<workspaceId>#` で始まる partition を対象にしているため、
  その範囲から外れる key にすると削除・export の漏れになる。
- 変更は Team manager の操作で、誰がいつ何日から何日に変えたかを audit に残す必要がある。
- 応答が失われたときの再送で、revision の競合として失敗させたくない。

## 決定

- Team の設定は NotificationsTable の partition key `<workspaceId>#!team-reminder-settings`、sort key
  `TEAM#<teamId>` の行に保存する。member の partition は member key が必ず `@` を含むので衝突しない。
  `<workspaceId>#` で始まるので、Workspace の削除・export の既存の範囲に入る。
- 行は `revision` を持ち、`PUT /api/teams/{teamId}/notification-reminders` は `expectedRevision` を条件にした
  transaction で保存する。同じ transaction で `notification-reminders.updated` の audit event を書く。
- `Idempotency-Key` 付きの保存では、同じ partition の sort key `TEAM#<teamId>#MUTATION#<key の sha256>` に receipt 行を
  同じ transaction で書く。receipt は request の fingerprint（`expectedRevision` と日数の sha256）と、その保存で書いた
  設定を持ち、`attribute_not_exists` を条件にする。同じ key・同じ fingerprint の再送は、後に別の保存を挟んでいても
  receipt の設定を返し、同じ key・別の body は 409 `IdempotencyKeyReused` にする。
- 保存の transaction には、route で確認した呼び出し元の Workspace member 行の `version` と Enterprise の CONTROL
  revision の ConditionCheck も入れる。確認から保存までの間に権限が変わると、revision の競合と区別できる 409
  `TeamReminderSettingsAuthorizationChanged` で取り消す。
- 工数の督促の配信時の読み直しは、Analytics table の time entry の `revision` を条件にした ConditionCheck を
  通知の保存と同じ transaction に入れる。そのため projection の role に Analytics table への
  `dynamodb:ConditionCheckItem` を足す。

## 検討した選択肢

- Team 用の新しい table を作る: key を自由に決められるが、Workspace の削除・export・backup の対象を増やす必要があり、
  table 1 つ分の運用と IAM が増える。
- Team の行を Planning table（Team の本体）に置く: Team と同じ場所に置けるが、通知の設定を読むために schedule と
  API が Planning table の書き込み権限を持つことになり、通知の module 境界を越える。
- NotificationsTable の Workspace 内 partition に置く（採用）: 既存の削除・export・IAM の範囲に収まり、Team 単位の
  get 1 回で読める。
- 冪等性を設定の行に最後の 1 件だけ残す: transaction の item は増えないが、別の key の保存を挟むと古い key の記録が
  消え、その key を別の body で送ると通ってしまう。「同じ key の別の入力は拒否する」契約を守れないので採らない。
- 冪等性を専用の receipt 行で持つ（採用）: transaction の item が 1 つ増え、保存のたびに小さな行が残る。

## 結果

- Team の設定は Workspace の削除・export に自動で含まれ、新しい table を増やさない。
- 再送は key ごとに救える。receipt は Workspace の partition にあるので、Workspace の削除・export に含まれる。
- 権限を失った manager の保存は、確認と保存の間に失効しても確定しない。
- 工数の督促は、配信直前に提出された entry に対して通知が残ることがなくなる。代わりに projection が Analytics table
  への ConditionCheckItem 権限を持つ。
- 現在の契約は [`docs/notifications.md`](../notifications.md) の「リマインドの日数」と「工数の督促」に書く。
