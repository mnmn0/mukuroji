# 0017. Enterprise SSO の access token を API が JWKS で検証し、失効を API 側の record で持つ

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #476, #493, #514, PR #545

## 背景

Enterprise SSO の app client が発行する access token の scope は `openid email profile` だけです。
Cognito `GetUser` は `aws.cognito.signin.user.admin` scope を要求するので、SSO の token は
`/api/auth/sso/exchange` でもその後の API 呼び出しでも拒否されていました（#476、#493）。

SSO の token を受け入れるようにすると、`/api/auth/sso/exchange` を通らずに Cognito
`/oauth2/token` で直接引き換えた token も受け入れてしまいます。exchange は nonce、
`email_verified`、email と state の一致を確かめる唯一の場所なので、ここを通らない token は
SSO を強制していない domain でも受け入れてはいけません（#514）。

また、`GetUser` を通らない token には Cognito 側の失効（`RevokeToken`、`AdminUserGlobalSignOut`）が
届きません。sign-out、directory の deprovisioning、管理者によるパスワードリセットの後に、
同じ sign-in の token が使えてはいけません。

## 決定

- `client_id` が SSO app client の access token に限り、API が User Pool の JWKS
  （`<issuer>/.well-known/jwks.json`）で RS256 署名を検証し、issuer、`client_id`、
  `token_use=access`、`exp`、`iat` を確かめます。user は `AdminGetUser` で読み、無効化された
  user と `sub` が一致しない user は拒否します。password app client の token は従来どおり
  `GetUser` で確かめます。
- JWKS は process 内で 1 時間 cache します。取得は前回の試行から 60 秒に 1 回までにし、
  取得に失敗しても cache 済みの鍵は使い続けます。鍵を一度も読めないときは 503 で拒否します。
- SSO の token は、SSO の強制有無にかかわらず、exchange が記録した server-side の SSO marker と、
  member の verified domain に結び付いた provider の current revision を要求します。
- sign-out では、その sign-in の `origin_jti` を realtime sessions table に
  `HTTP_SIGN_IN_REVOKED#<workspaceId>#<signInId>` として記録します。TTL は Cognito の access
  token 有効期限の上限（24 時間）で、既存の record を短くはしません。
- deprovisioning と管理者によるパスワードリセットでは、member record に `signInsRevokedAt` を
  書き、それ以前に始まった sign-in（`auth_time`、なければ `iat`）の SSO token を拒否します。
  パスワードリセットでは Cognito の global sign-out の前後で 1 回ずつ書きます。

## 検討した選択肢

- SSO app client に `aws.cognito.signin.user.admin` scope を足し、`GetUser` を使う:
  変更は小さいが、SSO user が `UpdateUserAttributes` などで自分の属性を書き換えられるようになり、
  IdP が管理する属性を利用者が上書きできてしまうので採らない。
- ID token で API を呼ぶ: Cognito の access token と別の検証経路と失効の扱いが要り、
  refresh や sign-out の既存の流れとも合わないので採らない。
- 失効を新しい table で持つ: TTL 付きの短命 record で足り、realtime sessions table が既に
  TTL（`expiresAt`）を持つので、key prefix を分けて同じ table に置く。

## 結果

- SSO の sign-in とその後の API 呼び出しが成立し、exchange を通らない token は拒否されます。
- API Lambda は Cognito の JWKS endpoint へ HTTPS で出ます。JWKS が読めない間に初めて現れた鍵は
  503 になります。
- SSO token の検証は Cognito 側の失効を見ないので、失効は API 側の record に依存します。
  sign-out や member の sign-out を新しく足すときは、この record を書く必要があります。
- 更新した文書: `docs/enterprise-identity.md`。
