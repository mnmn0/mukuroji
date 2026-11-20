# 0002. 認証の試行制限を DynamoDB の共有 counter で数え、信頼できる送信元を key にする

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #507, #511, #513, #478, PR #540, PR #528

## 背景

MFA code の確認、初回 password の設定（new-password challenge）、password reset の要求と確定、MFA setup の確認には、送信元と email ごとの試行制限があった。

- counter は Lambda instance ごとの memory（`Map`）にあり、cold start で消え、同時に動く instance の間で共有されなかった。総当たりを試す側は instance をまたぐだけで数え直しになる。
- key の送信元は `getConnInfo(c).remote.address` だった。`/api/*` は CloudFront 経由なので、これは利用者ではなく CloudFront edge の address になる。同じ edge を通る別の利用者が、他人の email に対する制限を使い切れる。
- 監査 log の `ipAddress` と OAuth token endpoint の IP 制限も、client が指定できる `X-Forwarded-For` の先頭や edge address を使っていた。

すでに `resolveTrustedRequestSource`（CloudFront の origin secret を検証したうえで viewer address を返す）と、Public API 用の DynamoDB fixed-window rate-limit store（developer platform table、TTL 付き）があった。費用を増やさないことも前提にした。

## 決定

- 送信元が必要な箇所（試行制限、OAuth token endpoint の IP 制限、監査 log の `ipAddress`）は、`server/src/infrastructure/http/trusted-request-source.ts` の `resolveTrustedRequestSource` / `resolveTrustedClientAddress` だけを使う。CloudFront 経由なら origin secret で検証した viewer address、直接呼び出しなら Lambda の `requestContext.http.sourceIp` を使い、`X-Forwarded-For` は信頼しない（設定された trusted proxy から来た場合を除く）。
- 認証の試行制限は、Public API と同じ `RateLimitPort`（developer platform table）で数える。
  - partition（`workspaceId`）は `authentication-attempts` で、Public API の counter と分ける。
  - `credentialId` は `<scope>:<sha256(scope, 信頼できる送信元, subject)>`。subject は小文字化した email、または MFA setup では Cognito の user。record key は既存の `RATELIMIT#<credentialId>#<windowStart>`、`expiresAt`（TTL）は window の終わり + window 長。
  - scope と上限: `mfa-challenge` と `new-password-challenge` は 5 分 10 回、`password-reset-request` は 15 分 5 回、`password-reset-confirm` は 15 分 10 回、`mfa-setup-verify` は 5 分 10 回。
  - fixed window で、成功しても counter は消さない（window が切れるまで残る）。
  - 送信元が分からない request（Bun server など Lambda の request context がない場合）は、共通の marker（`transport-unavailable`）を送信元として数える。
- store に書けないとき（DynamoDB の障害など）は fail closed とする。試行制限の呼び出しが例外を投げ、request は 5xx で失敗し、Cognito や招待の lock には進まない。
- OAuth token endpoint の client 単位の制限は、client secret と app の状態を確認できた request だけを、確認済み OAuth app の内部 ID で数える。誤った secret の試行は IP 単位の制限で抑える。

## 検討した選択肢

- 試行制限用に専用の DynamoDB table を作る: 権限と key 空間を分けられる。table・IAM・Floci の初期化が増え、既存 store と同じ実装を重複させる。
- 既存の developer platform table の rate-limit store を使う（採用）: 原子的な fixed-window の実装、TTL、test 用 in-memory 実装がすでにある。developer platform の table を認証が使うという依存が増える。
- memory のまま key だけ直す: 追加費用はないが、instance をまたいだ総当たりを止められない（#513 の問題が残る）。
- 成功時に counter を消す: 正しく認証した利用者は直後に再試行しやすい。共有 store に削除 API を足す必要があり、窓が短いので見送った。
- store 障害時に fail open にする: 可用性は上がるが、障害中は総当たりの制限が外れる。認証の制限なので fail closed にした。

## 結果

- 試行回数が全 instance で共有され、CloudFront edge を共有する別の利用者に制限を使い切られなくなる。監査 log の送信元を client が偽れなくなる。
- 各試行で DynamoDB の書き込みが 1 回増える（on-demand で 100 万回あたり約 1.25 USD）。
- 認証の可用性が developer platform table の可用性に依存する。
- この変更の途中で、rate-limit store の式が DynamoDB の予約語 `consumed` をそのまま使っていて、Floci では毎回失敗することが分かり、alias に直した。
- 更新した文書: `docs/public-api.md`（token endpoint の制限）。
