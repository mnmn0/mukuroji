# Enterprise identity・provisioning・security policy

この文書は、Workspace の SSO、SCIM provisioning、custom role、security policy、
service account、break-glass administrator の永続化・API・監査契約を定義します。
Workspace membership と Cognito user lifecycle は
[`event-audit.md`](event-audit.md) の state/event transaction 契約、および既存の
Workspace access lifecycle を引き続き利用します。

## Trust boundary

- Cognito User Pool と2つの public app client は CDK stack の外で管理します。Stack は
  `CognitoUserPoolId`、password/API 用 `CognitoUserPoolClientId`、Hosted UI SSO 専用
  `CognitoSsoUserPoolClientId` を受け取ります。API はその issuer と、相互に異なる2つの
  client ID だけを信頼します。
- SAML/OIDC provider、Hosted UI domain、callback URL、logout URL、OAuth flow は Cognito
  側で設定します。mukuroji は確認済み domain と login policy を保存し、Hosted UI へ遷移する
  discovery metadata を返します。
- Enterprise identity record は必ず Workspace scope を持ちます。Workspace をまたぐ record は
  domain claim の owner pointer だけです。SCIM alias と directory object の一意性は、強整合で
  読んだ Workspace state 内で identity provider ごとに確認します。
- Password、SAML assertion、OIDC client secret、SCIM bearer token、service account credential
  は DynamoDB、audit event、application log に保存しません。
- API は permission を route ごとに評価し、未知の permission、role schema、policy version は
  fail closed で拒否します。`system-admin` Cognito group は break-glass account の代用にしません。

## DynamoDB model

`EnterpriseIdentityTable` は次の key と保護設定を持ちます。

| 項目 | 値 |
| --- | --- |
| Partition key | `scopeKey` (String) |
| Sort key | `recordKey` (String) |
| TTL | `expiresAt` (epoch seconds) |
| Billing | on-demand |
| Recovery | point-in-time recovery |
| Deletion | deletion protection + CloudFormation retain |

主な item family は以下です。SCIM connection や provisioning run ごとの専用 partition は作りません。

- `WORKSPACE#<workspaceId>` / `CONTROL`: 現在 commit 済みの `controlRevision` と
  `activeStateGeneration`、および active から sealed snapshot までの
  `activeStateGenerations`。Chain は最大64世代です。Compaction 後は、TTL 付与が完了するまで
  `retiredStateGenerations` に旧 generation ID、revision、削除猶予を保持します。Soft threshold
  または retirement がある間だけ `maintenanceRequired=true` にして stream filter を通します。
- `WORKSPACE_STATE#<workspaceId>#<generation>` / `GENERATION`: generation kind、revision、
  parent、record count、canonical manifest hash を持つ marker。
- `WORKSPACE_STATE#<workspaceId>#<generation>` / `STATE#<logical-record-key>`: entity ごとの
  immutable delta または tombstone。Identity provider、policy、domain の Workspace view、
  role/mapping、SCIM user/group/credential、provisioning preview/run/log、service account、
  break-glass metadata、idempotency receipt はすべてこの family に staging します。
- `DOMAIN#<ascii-normalized-domain>` / `CLAIM`: Workspace をまたぐ domain owner pointer。

初回 mutation は sealed snapshot、以後の通常管理/SCIM mutation は変更 delta、tombstone、
generation marker だけを最大25件ずつ generation 固有 partition へ先に staging します。通常 request
path で directory 全件の snapshot を書き直しません。Marker の
manifest は logical key、record kind、entity key、content hash、論理 expiry を拘束し、欠落、余剰、
payload 改ざんを reader が fail closed で拒否します。その後、一つの DynamoDB transaction で
`CONTROL` の revision を compare-and-swap し、domain claim の取得・解放と immutable audit event を
request audit context がある場合は同じ commit point に含めます。API の CAS は revision と active
generation head の両方を拘束し、同じ logical revision で行われる compaction との lost update も
拒否します。Reader は `CONTROL` を強整合で読み、列挙された最大64個の generation partition を
並列の強整合 query で取得して、revision と parent chain、marker manifest を相互検証してから state を
再構成します。

Active chain が16世代に達すると、`CONTROL` の DynamoDB Stream から secret を持たない15分 Lambda
compactor を起動します。Compactor は active chain を検証して全 logical record の sealed snapshot を
generation 固有 partition へ staging し、同じ revision と読み取った head の CAS に成功した場合だけ
`CONTROL` を一世代へ切り替えます。CAS loser の snapshot は不可視で、既知 key を best-effort で
削除します。連続 write が worker より先に64世代へ達した場合、それ以上の mutation は retryable な
`EnterpriseIdentityCompactionRequired` で停止します。この quiescence 中に worker が compaction を
完了した後、同じ request を retry できます。Stream failure は部分 batch retry と監視対象 DLQ へ
送られます。

Active chain に列挙されない未 commit staging generation や古い committed generation は読まれないため、
staging 途中の失敗や CAS loser で部分 state が公開されることはありません。書き込み失敗が確定した
staging item は best-effort で削除します。古い committed generation は in-flight reader を壊さない
よう compaction commit から1時間後の物理 `expiresAt` を worker が全 item に付与し、付与完了後に
retired list を head/revision CAS で clear します。期限後に DynamoDB TTL がすでに partition の一部を
削除していた retry では、manifest を再検証せず、残存 item へ新しい1時間 TTL を再付与してから
list を CAS clear します。これにより、未付与 item を orphan にせず保守 state も永久に詰まりません。

SCIM user↔group relation と provisioning preview/run の change は、それぞれ独立した logical record
に分割します。Enterprise Identity table に lookup/due GSI はありません。Domain discovery は global
claim を強整合 `GetItem` し、Workspace state は `CONTROL` の強整合 `GetItem` と、そこに列挙された
generation partition の強整合 `Query` だけで読みます。

10分の provisioning preview、10分の one-time credential replay receipt、24時間の SCIM
idempotency receipt は、generation record の `logicalExpiresAt` で失効させます。Reader は期限切れ
record を無視し、次の sealed snapshot が物理 state からも取り除きます。Active generation の一部だけを
DynamoDB TTL が先に削除して manifest を壊さないよう、active generation record に table TTL 属性の
`expiresAt` があれば reader は fail closed で拒否します。物理 TTL は `CONTROL` から外れた旧
generation にだけ worker が grace 付きで設定します。古い `CONTROL` を先に読んだ in-flight reader
が物理 TTL を見た場合は `CONTROL` を強整合で再取得し、head が変わっていれば最新 chain から一度だけ
読み直し、同じ head のままなら active state corruption として拒否します。User、group、role、policy、provider、
provisioning run/log、service account、break-glass history の active records は TTL で暗黙削除しません。

## Credential hashing and rotation

SCIM token と service account credential は管理 API の作成・rotate response で返します。
Persistence には raw token ではなく、credential metadata と次の HMAC-SHA-256 digest だけを
保存します。

```text
HMAC-SHA-256(
  ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET,
  credential-kind + NUL + workspace-id + NUL + credential-id + NUL + raw-token
)
```

`credential-kind` には少なくとも `scim` と `service-account` を使用し、異なる用途の token が
同じ digest namespace を共有しないよう domain separation します。比較には constant-time
comparison を使います。Raw token は作成・rotate response と後述の短い recovery response にだけ含め、
snapshot・audit・log には含めません。HMAC secret と完全な digest は response・audit・log の
いずれにも含めません。

Service account の作成・rotate と SCIM token rotate は、entity、operation generation、
`Idempotency-Key` に束縛した次の HMAC から one-time token を決定的に導出します。

```text
prefix + Base64url(HMAC-SHA-256(
  ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET,
  "enterprise-one-time-credential-v1" + NUL + credential-kind + NUL + workspace-id +
  NUL + entity-id + NUL + operation-generation + NUL + receipt-key
))
```

同じ key と同じ
request fingerprint の再送だけは、応答消失を回復するため operation 成功から10分以内に同じ token を
再取得できます。異なる payload への key 再利用は `409`、10分経過後の同じ operation は
`EnterpriseOneTimeCredentialAlreadyIssued` です。UI はこの短い transport-recovery window を
「いつでも再表示できる secret」として扱わず、成功直後の画面でだけ表示します。

Rotate は expected generation/revision を optimistic condition にし、新 credential commit と同時に
旧 token の digest を削除するか credential を revoke します。応答を失い10分を過ぎた場合は、新しい
logical rotate で credential を再発行します。`ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET` の変更は既存
credential をすべて失効させる計画的 rotation であり、通常の deploy では同じ secret を維持します。

## SSO discovery and Hosted UI

Login 画面は password 認証を始める前に次を呼び出します。

```http
GET /api/auth/sso/discovery?email=user@example.com
```

Server は email の domain を trim・小文字化し、末尾の `.` を除いた ASCII DNS 名として検証します。
Unicode domain を IDNA/Punycode へ自動変換しないため、国際化 domain は caller が ASCII の
Punycode 表現で渡す必要があります。Verified claim と有効な identity provider policy を強整合で
確認し、SSO が必須なら Cognito Hosted UI へ遷移する
authorization URL と provider metadata を返し、password login を拒否します。Pending/failed
domain や provider connection test failure では SSO を強制しません。Response は user の存在を
明かさず、domain policy だけで決定します。

Hosted UI/client は password/API client から分離した public client とし、client secret なし、
`ExplicitAuthFlows=ALLOW_REFRESH_TOKEN_AUTH` のみ、OAuth server 有効、authorization code flow のみ、
`openid email profile` scope のみ、登録 callback は `COGNITO_SSO_REDIRECT_URI` の1件だけにします。
`SupportedIdentityProviders` は `COGNITO_ENTERPRISE_IDP_NAME` の1件だけで、native user-pool login の
`COGNITO` を含めません。通常 client と同じ client ID、password/SRP/custom auth、implicit flow、
余分な callback/provider/scope のいずれかがある場合は SSO start/exchange を fail closed で拒否します。
これにより、native password login で得た authorization code を SSO exchange へ持ち込み、
enterprise assurance を付与させる経路を閉じます。

Flow は PKCE、署名済み `state`、`nonce` を必須とします。State version 2 は email、provider ID、
provider revision、redirect URI、return path、nonce、PKCE challenge を束縛します。Callback 時に
current provider ID/revision と一致しなければ token endpoint を呼ぶ前に login を破棄するため、
provider の置換・再設定後に古い state を利用できません。この段階の callback は Cognito Hosted UI と
Web client が所有し、API に独自 callback endpoint を追加しません。Callback 後も API は issuer、
専用 client ID、`token_use`、expiry、subject、verified email、Workspace claim を検証します。
SSO discovery response を認証済み session の代わりに使用してはいけません。

Code exchange 成功時は server が `SHA-256(access-token)` の session ID に、provider ID と
provider revision から導出した予約済み authentication method を記録します。Enforced domain の
runtime 認可は current provider revision と一致する server-side record を要求し、access/ID token の
`amr` に同じ予約 prefix を偽装しても採用しません。Provider revision の更新は既存 state だけでなく
以前の SSO session assurance も無効化します。

Identity provider の設定変更は
`PUT /api/enterprise/security/identity-provider` で行います。Provider を `active` にする前に
issuer/audience、redirect URL、署名 metadata を検証します。Cognito 側で必要な設定は以下です。

- User Pool domain と HTTPS callback/logout URL
- Password/API client とは別の authorization code + PKCE 専用 public app client
- SAML または OIDC provider と attribute mapping
- `email_verified`、immutable subject、Workspace directory claim
- Token/session lifetime が mukuroji policy の上限を超えない設定

## SCIM 2.0 contract

SCIM data plane は Workspace ごとに分離します。

```text
GET    /api/scim/v2/:workspaceId/ServiceProviderConfig
GET    /api/scim/v2/:workspaceId/Users
POST   /api/scim/v2/:workspaceId/Users
GET    /api/scim/v2/:workspaceId/Users/:id
PUT    /api/scim/v2/:workspaceId/Users/:id
PATCH  /api/scim/v2/:workspaceId/Users/:id
DELETE /api/scim/v2/:workspaceId/Users/:id
GET    /api/scim/v2/:workspaceId/Groups
POST   /api/scim/v2/:workspaceId/Groups
GET    /api/scim/v2/:workspaceId/Groups/:id
PUT    /api/scim/v2/:workspaceId/Groups/:id
PATCH  /api/scim/v2/:workspaceId/Groups/:id
DELETE /api/scim/v2/:workspaceId/Groups/:id
```

Request は `Authorization: Bearer <token>` と `application/scim+json` を使用します。認証失敗は
connection、Workspace、user の存在を明かさない同じ `401` response にします。SCIM response と
error は RFC 7643/7644 の schema、pagination、`meta.version`/ETag を使用します。Advertise する
filter、PATCH、bulk capability は実装済みの subset だけに限定します。現行 collection filter は
`externalId` / `userName` / `displayName` の `eq`、page size は最大200件、PATCH は
`add | replace | remove`、Bulk は非対応です。

User は SCIM `id` と immutable internal member ID で関連付け、`userName`/email は変更可能な
alias として扱います。`externalId` と lowercase 比較した `userName` は、強整合で再構成した
Workspace state 内で identity provider ごとに重複を拒否します。同じ external object と同じ
canonical payload の再送は24時間の idempotency receipt 内で同じ結果を返し、同じ
`Idempotency-Key` に異なる payload fingerprint が来た場合は conflict にします。

Group PATCH は member relation の差分として適用します。Group mapping が付与する role は、
Directory state と mapping revision の両方を記録して再計算します。SCIM DELETE または
`active=false` は物理削除ではなく deactivation です。

SCIM bearer token の発行・rotate は
`POST /api/enterprise/security/scim/token` で行います。Response の raw token は通常一回だけ表示し、
同じ idempotency request の応答消失時だけ前述の10分 window 内で回復できます。

SCIM user/group の POST/PUT/PATCH/DELETE は desired version を保存した後、その request 内で
Workspace access/Cognito へ適用して `appliedVersion` を進めます。外部 side effect が失敗した場合は
desired version が先行したまま残り、後述の provisioning preview/reconcile で差分を確認・回復できます。

## Roles and group mappings

Role definition は安定した `roleId`、名称、permission ID 集合、guest assignment 可否、revision を
持ちます。Built-in role は削除できず、custom role 名は Workspace 内で一意です。Assignment は
`member | directory-group | service-account` principal、`workspace | team | project` scope、role ID、
`direct | directory-mapping | system` source と任意の mapping ID を持ちます。

Effective permission は該当 scope の assignment の和集合を計算した後、次の制限を適用します。

1. Account が active でなければ拒否する。
2. Guest/external policy、IP policy、MFA、session/reauth policy を ceiling として適用する。
3. Sensitive permission は recent re-authentication を満たさない限り拒否する。
4. Unknown/removed permission と scope 外 permission は付与しない。

Group mapping CRUD は `/api/enterprise/security/group-mappings`、custom role CRUD は
`/api/enterprise/security/roles` 以下で提供します。Role 更新・削除前には assignment impact を
preview して confirmation token を要求し、assignment、group mapping、active service account から
参照中の role は、参照をすべて付け替えるまで削除できません。

## MFA, session, re-authentication, IP and guest policy

`PUT /api/enterprise/security/policy` は MFA requirement、interactive session lifetime、
sensitive operation の re-authentication interval、IPv4/IPv6 CIDR allowlist、guest/external
enablement、external session lifetime 上限、許可 guest domain を version 条件付きで更新します。

- MFA required の Workspace は認証 token の MFA context を確認し、未達の session を拒否します。
- Session lifetime と re-authentication は server-side `auth_time` と policy revision で判定し、
  browser storage の expiry だけを信頼しません。
- Policy を厳しくした時は revision を進めます。API request は毎回 current policy を評価し、
  realtime connection も message/connection validation 時に absolute/idle/reauthentication/IP policy を
  再評価します。
- IP allowlist は直接の transport source を使います。`X-Forwarded-For` は immediate source が
  明示した trusted proxy の場合だけ評価し、先頭値を無条件に信頼しません。
- Guest/external restriction は role grant より優先する permission ceiling です。現行 model に
  guest membership expiry と自動 deactivation scheduler はなく、guest の時間制限は
  `maximumSessionLifetimeMinutes` による session 上限です。

IP policy の誤設定に備えて、保存前に caller の現在 IP への影響を preview します。ただし
break-glass を一般 policy の迂回経路にはせず、後述の短時間 activation と監査を必須にします。

## Service accounts and break-glass

Service account は human member と異なる principal kind です。Interactive login、password reset、
guest invitation を利用できません。Role、許可 scope、credential generation、expiry、任意の
source CIDR を持ち、audit actor kind は `service` です。

`/api/enterprise/security/service-accounts` 以下で作成、credential rotate、revoke を行います。
Revoke 後は active account と未 revoke digest の両方を要求する bearer authentication を即時拒否し、
disabled account と revoked credential metadata は管理 snapshot/監査のため保持します。

Break-glass administrator は Cognito の通常 system-admin group や service account と分離します。
Recovery account は active な non-guest member、Cognito MFA enrollment 済み、かつ managed domain 外の
email で事前登録します。SSO enforcement の prerequisite として使うには、30日以内に
`POST /api/enterprise/security/break-glass/test` を成功させる必要があります。

Activation には current MFA、policy の sensitive re-authentication interval 内の認証、理由、1〜account
上限分の短い絶対 expiry を必須とします。Activation は access token 全文ではなく
`SHA-256(access-token)` の base64url digest を `authenticationSessionId` として保存し、同じ member かつ
同じ認証 session でだけ昇格を再利用できます。`revoke-activation` は current session だけを終了し、
`deactivate` は account とその未失効 activation を停止します。Activation は対象 Workspace 内では
break-glass principal として全 enterprise permission を持ち、IP allowlist を bypass しますが、別
Workspace や別 session へは移せません。少なくとも定期 access test、credential rotation、利用通知を
運用手順に含めます。

## Dry-run, reconciliation, retry and deprovision

管理 API は次の workflow を提供します。

```text
POST /api/enterprise/security/provisioning/preview
POST /api/enterprise/security/provisioning/reconcile
GET  /api/enterprise/security/provisioning/logs
POST /api/enterprise/security/provisioning/logs/:runId/retry
```

Preview は SCIM user/group の desired/applied version 差分から create/update/deactivate/delete/noop と
session revoke を計算し、deterministic change ID、summary、blocking flag、fingerprint、10分の expiry を
返します。Active owner、active break-glass recovery account、managed project または planning entity を
所有する member の deprovision は blocking change です。Dry-run は Workspace access/Cognito の
authoritative state を変更しませんが、preview record 自体は短期 state として保存します。

Apply は未失効 preview ID と expiry を照合し、適用直前に新しい preview を強整合 state から作って
fingerprint が同じことを確認します。Workspace ごとに `running` run は一つだけで、run は5分の worker
lease を持ちます。Lease が切れた同じ run は attempt を進めて takeover できますが、現行 run model に
fencing token はありません。User/group の各 desired version を Workspace access/Cognito に適用した
後、`appliedVersion`/`appliedAt` を checkpoint します。全 non-noop change の checkpoint がそろうまで
run を `succeeded` にできません。

失敗時は safe な failure code、attempt、redacted log を保存して run を `failed` にします。Retry は
`POST /api/enterprise/security/provisioning/logs/:runId/retry` から同じ reviewed plan を手動実行します。
Due GSI、`retryAt`、指数 backoff、background retry scheduler は現行実装にありません。Secret、SCIM
payload 全文、email は provisioning log に保存しません。

Deprovision は次の順序で安全側へ倒します。

1. SCIM user の desired state を `active=false` で保存する。中央 authorization は全 linked directory
   identity が inactive なら、既存 access token と realtime access を即時拒否する。
2. Workspace directory member を deprovisioned にする。
3. Cognito user を disable し、global sign-out する。
4. SCIM user の desired version を applied と checkpoint する。Directory-managed group/role grant は
   active かつ applied 済み state からだけ解決し、directory-managed user の legacy
   Workspace/project grant も認可へ混ぜない。
5. Cognito や Workspace access 適用の部分失敗は failed run と unapplied desired version に残し、
   operator が同じ plan を retry する。

Owner、active break-glass recovery account、managed project、planning entity の ownership を失う変更は
preview で blocking とし、apply 時にも再検査します。Service account、pending invitation、一般の
resource ownership を自動移譲する処理はこの provisioning workflow には含まれません。

## Admin API and concurrency

管理 UI は `/api/enterprise/security` の snapshot を取得し、以下を操作します。

- `PUT /identity-provider`
- `POST /domains`、`POST /domains/:domain/verify`
- `POST /policy/preview`、`PUT /policy`
- `POST /scim/token`
- `POST /roles`、`POST /roles/:roleId/impact`、`PUT /roles/:roleId`、
  `DELETE /roles/:roleId`
- `POST /group-mappings`、`PUT /group-mappings/:mappingId`、
  `DELETE /group-mappings/:mappingId`
- `POST /provisioning/preview`、`POST /provisioning/reconcile`、
  `GET /provisioning/logs`、`POST /provisioning/logs/:runId/retry`
- `POST /service-accounts`、`POST /service-accounts/:accountId/rotate`、
  `POST /service-accounts/:accountId/revoke`
- `POST /break-glass/accounts`、`POST /break-glass/test`、`POST /break-glass/activate`、
  `POST /break-glass/revoke-activation`、`POST /break-glass/deactivate`

Mutation は `Idempotency-Key` と `X-Correlation-Id` を受け取ります。Credential の応答消失を安全に
retry する caller は同じ key と payload を維持し、更新 API は対象ごとの `expectedVersion` または
preview ID/expiry を送ります。Enterprise state は generation staging 後の `CONTROL` transaction で
idempotency receipt、domain claim、audit event と commit します。SCIM desired state と provisioning
run は Cognito/Workspace access side effect より先に保存し、部分失敗は applied-version checkpoint と
failed run に残して明示的 retry で収束させます。

## Audit and redaction

Request audit context を持つ enterprise mutation は、`CONTROL` commit と同じ transaction で immutable
audit event を作ります。現行 event type は次の値です。

- `identity-provider.updated`, `identity-domain.updated`,
  `identity-domain.enforcement-updated`, `security-policy.updated`
- `custom-role.updated|deleted`, `directory-group-mapping.updated|deleted`
- `scim-credential.issued|rotated|revoked`,
  `scim-user.reconciled|deactivated|applied`, `scim-group.reconciled|deactivated|applied`
- `provisioning.previewed|reconciled|succeeded|failed|retried`
- `service-account.created|authenticated|revoked`,
  `service-account-credential.issued|rotated`
- `break-glass-account.updated`,
  `break-glass.activated|activation-revoked|deactivated`
- 認証済み mutation rejection の `enterprise-security.request-rejected`
- Audit log の成功した閲覧・export 自体を記録する `audit.viewed`, `audit.exported`

Actor kind は `user | service | break-glass` を区別し、break-glass mutation は active activation ID を
correlation に束縛します。Event には Workspace、opaque/stable entity ID、operation/correlation ID、
結果、安全な metadata だけを渡します。Email、externalId、SCIM payload、domain verification token、
IdP secret、bearer credential、HMAC key/digest は event payload に含めません。Break-glass reason は
`[REDACTED]`、activation expiry と duration は safe metadata として記録します。Internal event の
`sourceDetails` には request source IP/User-Agent が入りますが、audit JSON/NDJSON projection からは
除外します。

`GET /api/audit/events` と `GET /api/audit/events/export` は system administrator を要求し、query/export
完了後に filter の有無、件数、truncation、format を別の immutable event に記録します。Audit writer が
無い場合は閲覧を fail closed で拒否します。

## Environment variables

| 名前 | 用途 |
| --- | --- |
| `ENTERPRISE_IDENTITY_TABLE_NAME` | Enterprise identity/configuration/provisioning state table |
| `ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET` | SCIM/service credential HMAC secret。32–256文字、安定値、必須 |
| `ENTERPRISE_SSO_STATE_SECRET` | SSO state 署名専用 secret。32–256文字、安定値、必須 |
| `COGNITO_USER_POOL_ID` | Trust する既存 User Pool |
| `COGNITO_CLIENT_ID` | Password/API 認証用に trust する public app client |
| `COGNITO_SSO_CLIENT_ID` | Hosted UI SSO 専用に trust する、通常 client と異なる public app client |
| `COGNITO_ISSUER` | Access token issuer。local では Floci endpoint |
| `COGNITO_HOSTED_UI_DOMAIN` | Cognito managed login の HTTPS domain |
| `COGNITO_SSO_REDIRECT_URI` | App client に完全一致で登録した SPA callback URI |
| `COGNITO_ENTERPRISE_IDP_NAME` | Cognito に登録した SAML/OIDC provider 名 |
| `MUKUROJI_WORKSPACE_DIRECTORY_ID` | Cognito claim と DynamoDB が共有する Workspace ID |
| `AUDIT_EVENTS_TABLE_NAME` | Immutable audit/outbox table |
| `MUKUROJI_AUDIT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | Enterprise mutation と audit view/export event の保持日数。既定値2555日 |
| `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` | PII を公開 audit ID へ変換する HMAC key |

CDK parameter `CognitoUserPoolClientId` と `CognitoSsoUserPoolClientId` は、それぞれ
`COGNITO_CLIENT_ID` と `COGNITO_SSO_CLIENT_ID` に渡します。両値が同じ stack configuration は
deploy 前に拒否します。`EnterpriseIdentityTokenHashSecret` は NoEcho で API Lambda の
`ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET` に渡します。`EnterpriseSsoStateSecret` も NoEcho で
`ENTERPRISE_SSO_STATE_SECRET` に渡し、credential HMAC と OAuth state の鍵を分離します。
Output には出しません。Local development
では root `.env` に同名の安定した secret を置き、Docker Compose、ready hook、backend deploy、
`server:dev` で同じ値を使用します。Generated env file には secret を複製しません。

SSO を enforce する前に、前述の専用 client contract を満たし、SAML/OIDC provider を
`COGNITO_ENTERPRISE_IDP_NAME` と同じ名前で接続してください。Login は
`/api/auth/sso/start` が短命な署名済み state・nonce・PKCE challenge を発行し、
`/api/auth/sso/exchange` が code を Cognito token endpoint で交換します。IdP の生の
authorization endpoint へブラウザを直接 redirect しません。Floci は Cognito Hosted UI
federation を模擬しないため、local では SSO enforcement を有効化できません。
