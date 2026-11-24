# 0081. 通知の Web Push を自前の RFC 8291 暗号化と VAPID で送り、Email と同じ配信 queue に push channel を足す

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #351、ADR 0005

## 背景

Web Push の購読登録 API と `PushSubscriptionsTable` は実装済みだったが、配信 worker がなく、通知設定で
「プッシュ」を選んでも何も届かなかった。Email（ADR 0005）と Slack は、通知 row と同じ transaction で書く
配信予定を channel ごとの sparse GSI から毎分読み、lease・再認可・quiet hours・有限回の再試行で送っている。

制約は次のとおり。

- なるべく安く運用する。SNS Mobile Push や外部の push SaaS は使わない。
- VAPID の秘密鍵は Lambda の環境変数や CloudFormation parameter に置かない。
- 購読の endpoint は登録時に既知の push service の host だけに絞っている（SSRF 対策）。
- 依存 package は増やしたくない。暗号処理は Node の `crypto` で書ける。
- AWS 環境はまだなく、検証はエミュレータで行う。

## 決定

- push channel を Email と同じ配信 queue に足す。通知 row に `pushQueueShard` / `pushNextAttemptAt` /
  `pushDeliveryStatus` / `pushAttempts` を書き、Notifications table に sparse GSI `PushDeliveryIndex`
  （KEYS_ONLY）を追加する。lease は 3 channel の間で互いに待ち合う（既存の claim 条件に push の lease を加える）。
- 有効化は deploy 時の opt-in とし、既存の parameter `WebPushVapidPublicKey` を使う。空なら projection は push の
  配信予定を書かず、job は queue も secret も読まない。後から有効にしても過去の通知はまとめて送られない。
- VAPID の秘密鍵（P-256 の 32 byte の scalar、padding なし base64url）は Secrets Manager の固定名
  `mukuroji/web-push/vapid-private-key` に運用者が置く。worker は warm な Lambda ごとに 1 回読み、公開鍵と
  対になっていることを確かめてから使う。IAM はこの 1 つの secret の `GetSecretValue` だけを許す。
  鍵の組は `bun run web-push:vapid-keys` で作る。
- payload は RFC 8291（`aes128gcm`、RFC 8188 の 1 record）で暗号化し、RFC 8292 の ES256 token
  （`aud` は endpoint の origin、`exp` は 12 時間、`sub` はアプリの origin）で署名する。実装は Node の `crypto`
  だけで行い、RFC 8291 Appendix A のテストベクタと一致することをテストで確かめる。
- 送信先は recipient の購読のうち、期限内で、endpoint の所有者 row がまだその member を指すものだけにする。
  送る直前に endpoint を登録時と同じ allowlist で再検証し、redirect は追わない。
- push service が `404` / `410` を返した購読は、送った時点の `updatedAt` を条件に削除する（その間に同じ endpoint を
  登録し直した browser の行は消さない）。`429` / `5xx` / 通信失敗は再試行し、`Retry-After` を尊重する。
  `400` / `401` / `403` / `413` は VAPID や payload の問題として失敗にし、alarm の対象にする。
- 1 台でも受け付ければ送信済みとする。別の端末が一時的に失敗しても再試行しない（受け付けた端末に同じ通知を
  2 回出さないため）。購読が 1 つもなければ alarm を出さずに抑止する。
- opt-in の境界は Email と同じく server が保存する `pushEnabledAt` とし、transport 導入前に push を選んでいた
  設定は最後の保存時刻を境界にする。
- 通知設定の API は `transports: { email, push }` を返し、設定画面は送信できない channel に「無効」と表示する。

## 検討した選択肢

- `web-push` などの npm package を使う: 実装量は減るが、依存と供給網の確認対象が増える。必要な処理は
  HKDF・ECDH・AES-GCM・ES256 署名だけで、公開テストベクタで検証できる。
- Amazon SNS Mobile Push / Pinpoint: browser の Web Push を直接扱えず、platform application の管理が増える。
- VAPID 秘密鍵を `NoEcho` の CloudFormation parameter で渡す: 環境変数に平文で残り、変更履歴にも出る。
- 失敗した端末だけを後で再送する: 端末ごとの配信状態を持つ必要があり、row と GSI が増える。今は通知ごとの
  状態に留める。

## 結果

- push を有効にしたメンバーの登録済み端末に、Email と同じ再認可・quiet hours・再試行の規則で通知が届く。
- 失効した購読は配信のたびに掃除される。
- Notifications table の GSI が 1 つ増える。CloudFormation は 1 回の更新で GSI を 1 つしか足せないため、
  初回 deploy 後に入れる場合は他の GSI の追加と同じ更新に含めない。
- scheduled-jobs Lambda の role は managed policy が 10 個の上限に達するため、文が少ない Cycle schedule の権限を
  inline policy に移した。
- 運用者は鍵を作り、秘密鍵を secret に置いてから `WebPushVapidPublicKey` を設定する。順序が逆だと配信は
  `PushKeysUnavailable` で再試行され、`PushNotificationBacklogAlarm` が出る。
- 更新した文書: `docs/notifications.md`、`docs/operational-readiness.md`、`docs/guide/member.md`、`cdk/README.md`。
