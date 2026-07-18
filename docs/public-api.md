# Public API と developer platform

mukuroji は `/api/v1` を外部 client 向けの versioned REST API とし、SDK 生成に使う OpenAPI 3.1 document を `GET /api/v1/openapi.json` で公開する。`/api/developer` 以下は Workspace の developer settings UI が利用する管理 API であり、Cognito access token と現在の Workspace RBAC で保護する。

## SDK 用 contract

OpenAPI document を SDK generator の入力にする。TypeScript の server/web 実装は `@mukuroji/contracts` が export する `ApiProblem`、`CursorPage`、credential、webhook、connector、import/export 型を共有し、OpenAPI schema と同じ stable field 名を使う。SDK 生成時は次のように document を snapshot し、バージョン管理する。

```sh
curl --fail --silent --show-error https://<mukuroji-host>/api/v1/openapi.json \
  --output mukuroji-openapi.json
```

Client は SDK の再生成だけでなく、`info.version`、endpoint path、schema 差分を review してから更新する。

## Credential と secret

Public API は scoped API key、または `/api/v1/oauth/token` で発行した OAuth access token を `Authorization: Bearer <credential>` として受け取る。API key の作成・rotation と OAuth app の作成・secret rotation では、平文 secret を成功 response に一度だけ含める。その後に取得できるのは ID、名前、prefix、scope、expiry、last-used、status などの非機密 metadata だけである。

- 平文 secret は暗号化された transport 上で作成者へ一度だけ表示し、再取得 endpoint を設けない。
- Server、監査 event、application log、analytics、error response に平文 secret を残さない。保存時は一方向 hash または provider が要求する暗号化形式を使う。
- Secret を紛失した場合は再表示せず rotation する。Rotation 成功時に旧 secret を失効し、revoke 後の credential は復旧しない。
- 管理 UI は一度限りの response を閉じる前に安全な保管先へ移したことを利用者に確認させる。
- Token、credential、signing secret を含む response は成功・error・idempotent replay のいずれでも `Cache-Control: no-store` と `Pragma: no-cache` を返す。

OAuth は server-to-server の `client_credentials` grant だけを提供する。Authorization endpoint、authorization code、refresh token、redirect flow は提供しない。OAuth app の scope と expiry は作成時に固定し、client secret の rotation では変更しない。

## Scope と Workspace RBAC

Credential の scope は権限を追加するものではない。Request の実効権限は「credential に付与された scope」と「credential の owner または service principal が Workspace で持つ RBAC permission」の積集合である。例えば `work-items:write` scope を持つ API key でも、actor が対象 Team の Work Item を更新できなければ `403 insufficient_scope` または `403 forbidden` になる。Resource が actor から不可視の場合は存在を漏らさないため `404` を返すことがある。

Scope は用途ごとに read/write を分離し、Work Item の削除だけは `work-items:delete` を別途要求する。

| Scope | 許可する操作 |
| --- | --- |
| `work-items:read` | Work Item の取得と一覧 |
| `work-items:write` | Work Item の作成と更新 |
| `work-items:delete` | Work Item の削除 |
| `webhooks:read` / `webhooks:write` | Subscription と delivery log の参照 / 管理・replay |
| `integrations:read` / `integrations:write` | Connector と external link の参照 / 管理 |
| `imports:read` / `imports:write` | Import record/report と export の参照 / dry-run・実行 |

Credential の scope は作成後に変更しない。権限を変える場合は、新しい credential を最小 scope で作成し、利用側を移行してから旧 credential を revoke する。

## Cursor pagination

一覧 response は `{ items, hasMore, nextCursor? }` を返す。`nextCursor` は署名された opaque token であり、client は decode、編集、永続的な bookmark としての利用をしない。同じ filter、sort、Workspace scope で次 request の `cursor` にそのまま渡す。

- `limit` は 1–100、既定値は 50 とする。
- Cursor は発行から 15 分で失効する。
- `hasMore: false` の response では `nextCursor` を返さない。
- Cursor は Workspace、credential または management user、route/resource、filter、page limit、期限へ署名付きで束縛する。いずれかが request と一致しない場合、期限切れ、改ざん、または対象 scope が変わった場合は `400 invalid_request` を返す。
- 一覧の途中で resource が更新される可能性があるため、client は ID で重複排除し、完全な snapshot が必要なら最初から走査し直す。
- In-memory pagination を行う一覧は作成・検出・接続日時の降順、同時刻では resource ID の降順に固定する。Downstream store の continuation を使う一覧も、外側の署名 cursor で同じ request scope を検証する。
- Work Item 一覧で actor が参照できる Project が 90 件を超える場合、DynamoDB から取得した page を application 側で権限 filter する。このため読み取り量が増え、`items` が `limit` 未満または空でも `hasMore: true` と `nextCursor` を返すことがある。Client は page の件数で走査完了を判断せず、`hasMore: false` になるまで `nextCursor` を辿る。

## Idempotency

作成、更新、削除、rotation、replay、connector 操作、import 実行などの mutation は `Idempotency-Key` header を必須とする。Key は logical operation ごとに client が生成する最大 256 文字の推測困難な値とし、network timeout 後の同一 retry でだけ再利用する。`X-Correlation-Id` は client trace の照合に利用できる。

Server は actor、HTTP method、canonical path、idempotency key と request fingerprint を関連付ける。同じ key と同じ fingerprint なら保存済み status/body を返し、`Idempotency-Replayed: true` を付ける。同じ key を異なる query/body へ再利用した場合は `409 idempotency_conflict` を返す。平文 key は監査 log へ保存せず digest 化する。

Connector の authorization / reauthorization は内部 operation ID から OAuth state と PKCE verifier を導出し、未失効の同一 flow を再利用する。Response receipt 保存前に process が停止しても、同じ idempotency key の再送で provider authorization flow を増殖させない。

## Error と rate limit

Error は `application/problem+json` の `ApiProblem` に統一する。`code` は client 分岐用の安定値、`requestId` は support 照合用、`retryable` は同じ intent を再試行できる可能性を表す。Field 位置を特定できる入力 error は JSON Pointer、field code、message を `errors` に含める。

すべての API response は次の header で quota を通知する。

- `RateLimit-Limit`: 現在 window の上限
- `RateLimit-Remaining`: window 内の残数
- `RateLimit-Reset`: quota 回復までの秒数
- `Retry-After`: `429` または一時的な `503` で待つ秒数

Client は `Retry-After` を優先し、値が無い retryable error では full jitter 付き exponential backoff を使う。`401`、`403`、validation error、idempotency conflict は自動 retry しない。

IP 単位の token endpoint rate limit は Lambda event の `requestContext.http.sourceIp` だけを信頼する。Internet client が指定できる `Forwarded`、`X-Forwarded-For`、`X-Real-IP` は rate-limit identity に使わない。

## Signed webhook

Webhook body は `WebhookEventEnvelope` で、retry と手動 replay の間も同じ event ID を保つ。Delivery request には次の header を付ける。

Subscription 作成時は `teamIds` を必須とし、作成者がその時点で閲覧できる Team だけを登録できる。Server は event enqueue 時にも作成者の current Team access と event の `teamId` を再検証し、許可済み selector 外の Team data を endpoint へ送信しない。Subscription metadata には `createdByUserId` と `teamIds` を保存する。

- `X-Mukuroji-Event-Id`: envelope の event ID
- `X-Mukuroji-Delivery-Id`: delivery log ID
- `X-Mukuroji-Timestamp`: Unix 秒
- `X-Mukuroji-Signature`: `v1=<hex HMAC-SHA256>`

署名対象は UTF-8 の `${timestamp}.${rawRequestBody}` とし、subscription の signing secret を HMAC key にする。Consumer は JSON parse より前の raw body で constant-time 比較し、現在時刻との差が 5 分を超える request を拒否し、event ID を保存して重複処理を防ぐ。Signing secret も作成・rotation response で一度だけ返す。

`2xx` を成功とし、timeout、`408`、`425`、`429`、`5xx` は jitter 付き exponential backoff で retry する。それ以外の `4xx` は設定 error として自動 retry を終了する。Retry は同じ event ID と delivery ID を保ち、attempt 数、最終 HTTP status、次回時刻を delivery log に記録する。上限到達後は `failed` とし、管理者は設定を修正して replay できる。手動 replay は同じ event ID を持つ新しい監査対象 delivery として扱う。

## Connector と同期の復旧

Connector installation は `connected`、`needs-reauth`、`degraded`、`disconnected`、`conflict` の状態を持つ。Access token 失効や consent 変更は `needs-reauth`、一時的な provider error は `degraded`、管理者による切断は `disconnected`、双方向更新の衝突は `conflict` とする。Credential や provider response body は `lastError` に含めず、redact 済み `ApiProblem` だけを保存する。

Provider ごとの OAuth/pull/push/revoke 実装は `ConnectorAdapter` 境界の後ろに登録する。管理 API は provider token を response や log に露出せず、永続化した installation/link/conflict と current RBAC だけを扱う。

復旧手順は次のとおり。

1. `needs-reauth` では再認証 flow を開始し、短時間有効な state と callback を照合する。成功後に同じ installation ID を `connected` へ戻す。
2. `degraded` では provider の `Retry-After` と backoff に従って checkpoint から同期を再開する。
3. `conflict` では local/external revision と field 差分を表示し、`use-local`、`use-external`、`merge`、`ignore` の明示操作で解決する。解決時も両 revision を再検証する。
4. `disconnected` からの接続は新しい authorization として扱う。保存済み link は削除せず paused 状態で保持し、再接続または別 installation への移行を可能にする。

Open conflict の link は inbound、outbound、poll の全経路から除外する。Conflict record と link の `conflict` 遷移、解決 claim、監査 event は optimistic concurrency と lease で fence し、side effect 前の validation failure では claim を解放する。

Work Item identity は `teamId + id` で扱う。External link、list filter、sync conflict は Team scope を失わず、別 Team に同じ Work Item ID が存在しても混同しない。

Public API の external link は
`/api/v1/work-items/{workItemId}/external-links?teamId={teamId}` で一覧・作成し、
個別削除は末尾に `{externalLinkId}` を追加する。Work Item と integration の両方の
scope、および対象 Team の current RBAC を必要とする。

管理 API では `PATCH /api/developer/external-links/{externalLinkId}` に
`syncDirection` を送って同期方向を変更する。`none` は link を `paused`、それ以外は
再同期待ちの `pending` にし、操作の再送時にも対象 Work Item の current RBAC を確認する。

External link の削除は link、provider identity claim、link 固有の sync state、Work Item ごとの active-link counter、監査 event、idempotency response を同じ transaction で確定する。Open conflict 中は通常の方向変更や削除を許可せず、先に resolve または ignore する。Work Item 自体を削除する場合も、すべての external link を先に解除する。削除 transaction は active-link counter を 0 条件で tombstone に置換し、並行する link 作成を同じ DynamoDB fence で直列化する。

管理 session の `GET /api/developer/work-items/{workItemId}/external-links` は現在の Work Item viewer に read-only 表示を許可する。Link の作成・方向変更・解除と connector installation 一覧は引き続き Workspace integration 管理権限を必要とする。

## CSV/JSON import と export

Import は mapping の作成、dry-run、source の再送、report 確認の順に進める。

1. UTF-8 の CSV または JSON source と、`sourceField` から canonical/custom `targetField` への mapping を送る。
2. `/api/developer/imports/dry-run` で parse、変換、required field、workflow status、custom field、Team/Project access を検証する。Dry-run は Work Item や ImportJob を保存せず、`totalRows`、`validRows`、`invalidRows`、row/field error と sample preview を返す。
3. Error を修正し、`POST /api/developer/imports` へ同じ mapping と source 全体を再送する。API は現在の管理権限を確認し、source を暗号化・versioning 済み storage に固定して durable job を queue するため、row ごとの remote validation 完了を待たない。
4. 成功時は `202 Accepted` と `queued` の import record を返す。Worker は durable queue から job を取得し、現在の Team/Project access、workflow、assignee、custom field 設定を再検証してから `running`、`completed` または `failed` へ遷移させる。実行中も row ごとに current RBAC を確認し、終了後は validation failure の場合も集計と bounded row error report を取得できる。
5. `DELETE /api/developer/imports/{importJobId}` は未完了 job に cancellation を要求する。実行中の Worker は永続化した cancellation 状態を確認し、安全な区切りで停止する。

Worker retry を使い切った job は `failed` として source を削除し、DLQ の locator は運用診断専用に保持する。再実行は修正済み source と新しい idempotency key で新規 job を作成する。

同じ request の再送は idempotency record で job の二重作成を防ぎ、修正した source の再実行には新しい idempotency key を使う。各 row の Work Item ID は Workspace、actor、idempotency key、Team、row から決まるため、Worker の retry や lease takeover でも同じ row を二重作成しない。

Worker が retry 上限に達した message は原因調査用 DLQ に保持する。DLQ の redrive で terminal job を再開せず、原因を修正した後に新しい idempotency key と source で import を作成し直す。

Export は `GET /api/developer/exports?format=csv|json` で同期 download する。現在の RBAC で閲覧可能な Work Item だけを含め、credential、internal key、secret、redact 対象 field は含めない。
