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
- 行に最後の `Idempotency-Key` と request の fingerprint（`expectedRevision` と日数の sha256）を残す。
  同じ key・同じ fingerprint の再送は保存済みの設定を返し、同じ key・別の body は 409 `IdempotencyKeyReused` にする。
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
- 冪等性を専用の idempotency 行で持つ: 複数 key の履歴を残せるが、transaction の item が増える。設定は Team ごとに
  直近 1 回の再送だけを救えば十分なので、設定の行に最後の 1 件だけ残す。

## 結果

- Team の設定は Workspace の削除・export に自動で含まれ、新しい table を増やさない。
- 再送は直近の 1 回分だけ救える。別の変更を挟んだ後に古い key を再送すると、revision の競合として 409 になる。
- 工数の督促は、配信直前に提出された entry に対して通知が残ることがなくなる。代わりに projection が Analytics table
  への ConditionCheckItem 権限を持つ。
- 現在の契約は [`docs/notifications.md`](../notifications.md) の「リマインドの日数」と「工数の督促」に書く。
