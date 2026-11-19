# 0003. Connector の OAuth callback を、flow を開始した本人の認証済み session で完了する

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #508, PR #544

## 背景

Connector の OAuth callback（`GET /api/developer/connector-oauth/callback`）は provider からの
redirect で呼ばれ、Mukuroji の認証情報を持たない。これまではこの request の中で署名付き・1回限りの
state を consume し、PKCE で token を交換して installation を作っていた。state と PKCE が示すのは
「Mukuroji が flow を開始した」ことだけで、「完了させた人が開始者である」ことは示さない。
そのため、管理者が得た authorization URL を別の人が開いて承認すると、その人の provider account と
token が開始者の Workspace に install され、以後その account の resource が同期される。

Web は Cookie を使わず Bearer token で API を呼んでおり、API base URL を Web と別の origin にも
設定できる。

## 決定

- callback は flow を完了しない。state と code（provider が拒否した場合は `cancelled=true`）を
  URL fragment に載せて Web の `/settings/connectors/oauth-callback` へ 303 で引き渡す。
  fragment はサーバーへも Referer にも送られない。
- Web はその page で fragment を読んで履歴と router の location から消し、利用者の Bearer token で
  `POST /api/developer/connector-oauth/complete` を呼ぶ。この endpoint は integration を管理できる
  利用者だけが呼べ、`Idempotency-Key` を要求する。
- server は state を consume したあと、flow の Workspace と user が呼び出し元と一致しなければ
  403（`ConnectorOAuthActorMismatch`）を返す。不一致でも state は消費済みのままにし、漏れた URL を
  誰も再利用できないようにする。その後に従来どおり現在の権限を再評価する。
- callback を受けた時点で未ログインなら、login の戻り先には callback page ではなく Connector 設定を
  使い、code と state をログイン URL や SSO の state に載せない。利用者は設定画面から接続し直す。
- provider の redirect URI が Web と別の API origin を指す構成では、API の環境変数
  `CONNECTOR_OAUTH_WEB_ORIGIN` に Web の origin を設定し、引き渡し先を絶対 URL にする。
  同じ origin の構成（CloudFront 配下）では設定しない。

## 検討した選択肢

- 開始時に短命の `HttpOnly; Secure; SameSite=Lax` nonce cookie を発行し、callback で照合する:
  callback の route と provider 設定を変えずに済む。一方、API が Web と別 origin のとき開始 request の
  Set-Cookie が callback に届く保証がなく、idempotent replay で cookie を再発行できない。
  worker が作る再認証 URL のように browser を経ずに作る flow にも cookie を付けられない。
- callback を認証済みの Web で受け、Bearer token 付きで完了させる（採用）: 既存の認証方式のまま
  完了者を確定でき、origin 構成にも依存しにくい。fragment の扱いとログイン前の callback の破棄を
  Web 側で守る必要がある。

## 結果

- authorization URL を他人に渡しても、その人が承認した時点で 403 になり、その URL は使えなくなる。
- worker が installation に保存する再認証 URL は installer 本人しか完了できなくなる。Web の再認証
  ボタンは操作した本人用の新しい flow を作るので、画面上の操作は変わらない。
- callback 時に未ログインの場合は接続をやり直す必要がある。
- 契約は [`docs/public-api.md`](../public-api.md) の OpenAPI、運用設定は
  [`cdk/README.md`](../../cdk/README.md)、利用者向けの説明は
  [`docs/guide/admin.md`](../guide/admin.md) に書く。
