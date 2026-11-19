# 0004. Public API の rate limit・冪等性の呼び出し元を OAuth app 単位にする

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #505, Issue #506, PR #536

## 背景

Public API の rate limit bucket（`RATELIMIT#<呼び出し元>#<window>`）、冪等 receipt
（`IDEMPOTENCY#<呼び出し元>#<digest>`）と receipt の暗号化 context、Work Item 作成の決定的 ID は、
認証した credential の ID を呼び出し元として key にしていた。OAuth の `client_credentials` では
access token ごとに ID が変わるため、次の問題があった（#505）。

- token を発行し直すだけで rate limit の残数が戻り、上限を回避できる。
- network timeout 後に新しい token で同じ `Idempotency-Key` を再送すると、replay されず二重に作成される。

API key では、利用のたびに `lastUsedAt` を書く処理が row の `version` を進めていた。revoke・rotate は
`version` の条件付き書き込みで競合を検出するため、使われ続けている key は `409` で失効できなかった（#506）。

## 決定

- 認証済み credential に「呼び出し元」（`principalId`）を持たせる。OAuth access token では
  発行元 OAuth app の `oauth-app:<oauthAppId>`、API key では従来どおり credential ID とする。
- rate limit bucket、冪等 receipt の key と暗号化 context、Work Item 作成の決定的 ID は呼び出し元で作る。
  同じ OAuth app の token は quota と冪等の範囲を共有し、別の app とは分ける。
- 監査 log の actor（`credential:<id>`）と cursor の束縛は、これまでどおり個々の credential ID のままにする。
- `lastUsedAt` は `version` を変えない条件付き update で記録し、書き込みは credential ごとに 60 秒に 1 回までにする。
  revoke は読み取り時の `version` と `lastUsedAt` を条件にし、競合したら読み直して最大 3 回まで再試行する。

## 検討した選択肢

- 選択肢 A: token ID のまま key にする。変更はないが、token の再発行で quota と冪等性を回避できる。
- 選択肢 B: OAuth app ID を呼び出し元にする（採用）。token を発行し直しても同じ app の操作として扱える。
  同じ app の複数 token が quota を共有するため、app ごとの上限が実質の上限になる。
- 選択肢 C: Workspace 単位にする。回避はできないが、別の連携同士が quota と冪等 key の空間を奪い合う。
- `lastUsedAt` を別 row に分ける案も考えたが、認証ごとの書き込みと読み取りが増えるため、
  同じ row の属性を `version` を動かさずに更新する方式にした。

## 結果

- token の再発行で rate limit と冪等性を回避できなくなる。使用中の API key も失効できる。
- 既存の rate limit・冪等 receipt の key が変わる。2026-11-19 時点で稼働中の環境がなく、旧 key の
  データは存在しないため移行処理は持たない。稼働環境ができた後に key をまた変える場合は、旧 namespace の
  receipt を読む移行期間を設ける。
- `lastUsedAt` の表示は最大 60 秒遅れる。
- [`docs/public-api.md`](../public-api.md) と管理者ガイド（[`docs/guide/admin.md`](../guide/admin.md)）に、
  OAuth app 単位の quota と冪等範囲を書いた。
