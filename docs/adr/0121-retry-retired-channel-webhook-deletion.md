# 0121. 削除・差し替えた channel 投稿先の古い Webhook secret の削除を再試行する

- 状態: 提案
- 日付: 2026-11-28
- 関連: ADR 0086（一部を置き換え）、PR #788 の CodeRabbit 指摘

## 背景

ADR 0086 では、Team・Project の channel 投稿先の設定を削除したり Webhook URL を差し替えたりした後に、古い version の
secret の削除が失敗しても再試行しないとした。version は推測できない UUID で、Workspace 閉鎖時の prefix 削除で消えるからである。

しかし Workspace が続くかぎり、どの設定からも参照されない Webhook URL が Secrets Manager に残り続ける。URL を差し替えた理由が
漏えいだった場合、管理者は古い URL が消えたと考えるが、実際には消えていないことがある。

## 決定

- 設定の保存（URL の差し替え）と削除の transaction に、古い version の削除予定を表す row を同じ transaction で書く。
  key は `<workspace>#!channel-secret-cleanup` / `SECRET#<targetKey>#<version>`、`itemType` は `channel-secret-cleanup`。
  設定が commit されたときだけ予定が残り、拒否された保存は予定を残さない。
- 予定の row は既存の sparse index `SlackDeliveryIndex` に専用の shard（`channel-secret-cleanup`）で載せ、
  `slackNextAttemptAt` は書いた時刻の 5 分後にする。新しい table や index は作らない。
- request の中では従来どおりすぐに削除し、成功したら予定の row を index から外して 7 日後に TTL で消す。
- Slack の job（channel 投稿と同じ 1 分ごとの実行）が期限の来た予定を 1 回に 20 件まで読み、削除を試す。
  secret がもうなければ成功として扱う。失敗したら 10 分 × 2^試行回数（上限 24 時間）後に回し、8 回失敗したら
  `channel-secret-cleanup-failed` にして index から外し、job を失敗させて既存の alarm に載せる。読めない row も同じく alarm に載せる。
- Slack の job に `mukuroji/automation-webhooks/*/slack-channel/*` だけへの `secretsmanager:DeleteSecret` を足す。
  個人の送信先（`slack/*`）は削除できないままにする。

## 検討した選択肢

- **再試行しない（ADR 0086 のまま）。** 状態が要らない。ただし差し替えた URL が Workspace の閉鎖まで残る。
- **API の request の中で何度か再試行する。** 状態が要らない。ただし Secrets Manager の障害が続くと結局残り、
  request も遅くなる。
- **専用の queue（SQS）で再試行する。** 再試行の仕組みは揃っている。ただし設定の commit と queue への送信を同じ transaction に
  できず、commit 後に送信が失敗すると同じ穴が残る。

## 結果

- 削除・差し替えた channel 投稿先の古い Webhook URL は、Secrets Manager の障害が続いても、回復後に job が消す。
- 8 回失敗した削除と読めない予定は alarm で運用者に伝わり、row から対象の secret 名をたどれる。
- `SlackDeliveryIndex` を読む job が 1 shard 分多く Query する。予定がない間は空の Query 1 回で済む。
