# 0005. 通知の Email を SES で送り、Slack と同じ配信 queue を channel ごとの sparse index で持つ

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #351

## 背景

通知設定には in-app / email / push / Slack の channel があるが、外部へ実際に送る transport は Slack だけだった。
Email を選んでも Inbox に残るだけで、mukuroji を開いていないメンバーには届かない。
Slack 配信は、通知 row と同じ transaction で保存する配信予定（`slackQueueShard` / `slackNextAttemptAt`）を
16 shard の sparse GSI `SlackDeliveryIndex` から毎分読み、lease・version 条件・再認可・quiet hours の再確認・
有限回の再試行・失敗 row の運用者向け index で送っている。

制約は次のとおり。

- なるべく安く運用する。常駐 server や外部 SaaS の契約は増やさない。
- 送信先は Cognito profile の Email で、Slack の Webhook URL のような宛先 secret はない。
- Email を選んだまま transport がなかった既存の設定がある。
- AWS 環境はまだなく、検証はエミュレータで行う。

## 決定

- Email の送信には Amazon SES（API v2 の `SendEmail`）を使う。送信元は deploy 時の parameter
  `NotificationEmailSender` で 1 つだけ指定し、空なら Email 配信は無効のままにする。
- 配信は Slack と同じ方式にする。通知 row に `emailQueueShard` / `emailNextAttemptAt` / `emailDeliveryStatus` /
  `emailAttempts` を同じ transaction で書き、Notifications table に sparse GSI `EmailDeliveryIndex`
  （KEYS_ONLY）を追加する。Slack と別の index にするのは、同じ通知を両方の channel で独立に進め、
  片方の失敗や再試行が他方を止めないようにするため。
- queue の読み取り・lease・再試行・失敗 shard の処理は channel 共通の実装にし、Slack と Email は
  channel 名（属性と index の接頭辞）・opt-in の判定・失敗 code の接頭辞だけを渡す。
- 毎分の scheduled-jobs Lambda に `email-notifications` job を追加する。送信元が空の環境では queue を読まずに終わる。
  projection も送信元が空なら Email の配信予定を書かないので、後から有効にしても過去の通知はまとめて送られない。
- 宛先は現在の Workspace membership の Cognito username で `AdminGetUser` を読み、`email_verified` が true の
  アドレスだけを使う。メンバーが削除・無効化された場合と未確認アドレスは、alarm を出さずに配信を抑止する。
- opt-in の境界は Slack と同じく server が保存する `emailEnabledAt` とする。transport 導入前に Email を有効にしていた
  設定は、最後に保存した時刻（`updatedAt`）を境界として扱う。
- 本文は ja / en 併記のプレーンテキストで、Inbox と同じ deep link を Web の origin で絶対 URL にする。
  origin が違う link は使わない。
- bounce / complaint は SES の account-level suppression list に任せる。SES は suppression 中の宛先へは送らない。

## 検討した選択肢

- SMTP relay（外部 SaaS や自前 MTA）: 送信元の自由度は高いが、認証情報の保管と契約・運用が増える。
  SES なら IAM で送信元を絞れ、送った分だけの課金で済む。
- Slack と同じ `SlackDeliveryIndex` に `email#` shard を相乗りさせる: GSI は増えないが、1 つの row は 1 つの
  shard 属性しか持てないため、Slack と Email を同時に有効にした通知を両方送れない。
- digest（複数通知を 1 通にまとめる）を最初から入れる: 完了条件の一部だが、frequency ごとの集約 row と
  送信済みの扱いを新しく設計する必要がある。今回は Slack と同じく通知ごとに 1 通とし、後続で入れる。
- bounce / complaint を SNS で受けて独自の suppression list を持つ: 運用者が mukuroji 側で確認できるが、
  SNS topic・受信 worker・保存先が増える。まず SES 標準の suppression list を使う。

## 結果

- Email を有効にしたメンバーに、Slack と同じ再認可・quiet hours・再試行の規則で通知が届く。
- Notifications table の GSI が 1 つ増える（sparse なので Email を使わない環境では空）。
- SES の sandbox 解除、送信元ドメインの SPF / DKIM / DMARC は deploy 時に運用者が行う。
- 後続で入れるもの: email の digest、Web Push transport、設定画面の「無効」表示、SNS による bounce の取り込み、
  Analytics scheduled delivery などの outbox 接続。
- 更新した文書: `docs/notifications.md`、`docs/operational-readiness.md`、`docs/guide/member.md`、`cdk/README.md`。
