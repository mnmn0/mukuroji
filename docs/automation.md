# Automation・template・recurring work・bulk operation

## 目的

この文書は、定型的な Work Item 操作を安全に自動化するための正本契約を定義する。対象は versioned automation rule、再利用可能な template、timezone を持つ recurring work、複数 Work Item に対する bulk operation、および管理者向け実行履歴である。

Automation は `AuditEventsTable` の immutable event/outbox を入力にする。現在状態だけを再走査して event を推測してはならない。各 rule version と action は元 event ID に束縛した durable receipt を持ち、Audit stream の at-least-once 配送で同じ action を二重実行しない。

## Rule model

Rule は `schemaVersion`、論理 `id`、単調増加 `version` / `revision`、`enabled` 状態、trigger、conditions、actions、retry、rate limit、loop guard を保持する。編集は既存 version の意味を上書きせず、新しい version を作る。停止は version を削除せず `enabled=false` にする。

Template を参照する create action は保存時点の enabled Work Item template version を server が固定する。Client が送る version は信用しない。Actions を明示更新した場合だけ current template へ再固定し、名前・停止など actions と無関係な更新では既存の固定 version を保持する。

Trigger は次を扱う。

- status
- assignee
- due date
- custom field
- comment
- form
- webhook
- schedule

Action は assign、move、update、create、comment、notify、approval、webhook を扱う。Webhook の secret 本文は rule response や実行履歴へ返さず、`[A-Za-z0-9._-]{1,128}` の secret alias だけを保存する。実体は Workspace ID の SHA-256 hash と alias から `mukuroji/automation-webhooks/{workspaceHash}/{alias}` を導出し、Secrets Manager から実行時に取得する。

Approval action は event が指す canonical Work Item 自体を承認対象にし、通常の file approval と同じ main row、reviewer Inbox projection、summary、decision/cancel API、audit transaction を利用する。作成前に owner Team と assigned Project が active であること、全 reviewer が active Workspace member かつ対象 Work Item を閲覧できること、指定した完了 workflow status が現在の configuration で遷移可能であることを強整合 read で再検証する。Requester は `service` identity の `automation:<ruleId>` として保存し、人間 requester と誤認して cancel/notification の対象にはしない。

Condition は event snapshot と現在の Work Item snapshot のどちらを読むかを field path で明示する。Field path の namespace、比較 operator、値の型と condition tree の深さは保存前に検証し、実行時に存在しない field は `not-exists` 以外では一致しない。

## 実行と冪等性

実行 ID は Workspace、論理 rule ID、元 event ID から決定的に作り、最初に予約した immutable rule version を execution に固定する。Rule 編集後に同じ event が再配信されても新 version の action は重複実行せず、途中の execution は固定済み version で再開する。実行開始は status と attempt の条件付き更新、および期限付き runner lease で一つの worker だけが取得する。同じ event が並行再配信された場合、後続 worker は保存済み execution を返して action を開始しない。

各 action receipt は execution ID と action index を一意 key にし、成功した action だけを記録する。途中失敗後の retry は receipt がある action を skip し、未完了 action から再開する。Retryable failure と期限切れ runner lease は `ScheduleDueIndex` に sparse 登録し、minute worker が保存済み rule version と trigger event だけを使って回収する。

Approval ID と request fingerprint は action の deterministic idempotency key に固定する。期限はまだ永続化されていない action attempt 時刻ではなく、保存済み immutable `execution.startedAt + dueInHours` から計算する。Approval transaction の commit 後、receipt 保存前に応答が失われても retry は同じ ID・期限・payload を照合して既存 request を返し、reviewer projection、summary、audit event を重複させない。

非 schedule rule は current rule version の `updatedAt` より前に発生した backlog event を新規実行しない。Rule の編集で新 version を作った場合は、その version が保存された時刻が新しい cutoff になる。ただし既に予約済みの execution は、元 event が古くても固定済み rule/event snapshot から再開する。一時障害は HTTP 408/429/5xx、DynamoDB throttling/internal error code、AWS SDK の retry metadata を retryable とし、permission、validation、revision conflict などの 4xx は自動 retry しない。

Event consumer の current rule 一覧は strongly consistent に読み、停止成功後の旧 enabled row を実行しない。Schedule due index は GSI のため、worker は side effect 前に base table の current rule/recurring definition を strongly consistent に再取得し、停止・削除・次回時刻変更済みの stale due entry を実行しない。

内部 Work Item action は deterministic な resource/event ID を使い、状態更新と automation source の audit event を既存の DynamoDB transaction で確定する。Action receipt 保存前に応答が失われても、再実行は同じ resource/event を照合して成功済み mutation として扱う。Webhook には同じ deterministic idempotency key を送る。外部 endpoint が idempotency を実装していない場合、応答消失時の exactly-once は保証できない。

Outbound webhook は HTTPS の既定 port のみを許可し、credential 付き URL、private/reserved address、redirect を拒否する。Hostname は実行時に一度だけ解決し、すべての A/AAAA answer が public であることを検証してから、その address へ socket を固定する。DNS 解決を含む request 全体を 10 秒で timeout する。Secret alias や secret 本文は外部へ送らず、Unix timestamp と raw JSON body を `timestamp.body` として HMAC-SHA256 署名し、`X-Mukuroji-Timestamp` / `X-Mukuroji-Signature` で送る。Signature 値は `sha256=<hex digest>` とし、同じ execution/action の retry では同じ `Idempotency-Key` を送る。

## Signed inbound webhook

Inbound webhook は server-issued endpoint と signing secret を Workspace 管理者が発行する。管理 API が使う論理 `endpointId` と、sender が URL で使う推測不能な `opaqueEndpointId` は分離する。Endpoint は `provisioning`、`active`、`paused`、`revoked` の状態を持つ。

- `provisioning`: create/rotate の secret を確定中。Public delivery からは存在しない endpoint として扱う。処理が完了しない場合は Workspace 管理者が revoke して abort できる。Rotate 途中の abort でも endpoint 全体が終端失効するため、Rule と sender は新しい endpoint へ再設定する。
- `active`: 署名済み delivery を受け付ける。
- `paused`: Metadata と secret は保持するが delivery を `423 AutomationInboundWebhookPaused` で拒否する。
- `revoked`: 終端状態。Opaque lookup と Secrets Manager resource を削除し、public API は `404 AutomationInboundWebhookNotFound` を返す。

Create と rotate は `Idempotency-Key` を必須にし、actor、operation、endpoint、入力 fingerprint に束縛する。同じ key と同じ入力の retry は予約済み secret generation を回収し、異なる入力への key 再利用は `409 IdempotencyConflict` とする。応答消失時に同じ key で plaintext secret を回収できる recovery window は operation 予約から 24 時間だけとし、期限後は `409 AutomationInboundWebhookSecretRecoveryExpired` を返す。Create/rotate response の `signingSecret` はその応答でだけ返し、list/detail、rule、audit、execution、DynamoDB row には保存または再表示しない。Client は応答直後に安全な保管先へ移し、UI は React の一時 state 以外へ保持しない。一度正常に受領した secret の再表示手段として recovery retry を使ってはならない。

Secret 実体は outbound webhook secret と別の Secrets Manager prefix に隔離する。既定 resource ID は `mukuroji/automation-inbound-webhooks/{sha256(workspaceId)}/{endpointId}` で、各 generation は deterministic な immutable version ID に固定する。Rotate 完了後は新 generation だけを検証に使い、revoke は endpoint の全 generation を削除する。Revoke transaction は durable cleanup intent も同時に保存し、即時の `DeleteSecret` に加えて Automation schedule Lambda が 5 分間隔で recovery window の 24 時間とその後の 5 分間の grace が終わるまで削除を反復する。Grace は recovery 期限直前に開始済みの provisioning write も最終削除の対象に含める。これにより、provisioning と revoke が競合して revoke の最初の削除後に Secrets Manager write が遅延確定しても回収する。Schedule Lambda の IAM は inbound-only prefix に対する `secretsmanager:DeleteSecret` だけを追加で許可する。

管理 API の list/detail は secret metadata を除いた endpoint と発行済み `endpointUrl` だけを返す。PATCH は表示名、pause/resume/rotate/revoke は読み込み時点の `expectedRevision` を要求する。Rotate は active/paused endpoint だけに許可し、revoke 後の endpoint ID と opaque URL は再利用しない。発行する public endpoint URL は HTTPS を必須とし、HTTP は `localhost`、`127.0.0.1`、`[::1]` の loopback development host だけに許可する。

Public delivery は Cognito access token ではなく次の header と raw request bytes で認証する。

```text
Content-Type: application/json[; charset=utf-8]
Idempotency-Key: <sender-defined delivery key>
X-Mukuroji-Timestamp: <10-digit Unix epoch seconds>
X-Mukuroji-Signature: sha256=<64 lowercase hex characters>
```

Sender は body を JSON 化した後の**送信するそのままの bytes**を使い、`HMAC-SHA256(signingSecret, timestamp + "." + rawBodyBytes)` を計算する。Server は parse や再 serialize より前に raw bytes で検証するため、空白や key 順序を変えると署名は一致しない。Timestamp は server 時刻の前後 5 分以内だけを許可する。Body は UTF-8 JSON value、最大 256 KiB とし、`Content-Length` の有無にかかわらず stream 読み取り中にも上限を強制する。

Delivery receipt は endpoint と `Idempotency-Key` に束縛し、endpoint guard、署名 replay receipt、audit outbox event と同じ DynamoDB transaction で確定する。Delivery idempotency receipt の保持期間は作成から 400 日とし、その期間内の同じ key と同じ raw body の再送は保存済み `eventId` を返して event を再作成しない。これは audit outbox の 365 日保持より長く、同じ deterministic `eventId` が既存 audit row と衝突し得る期間全体を receipt で覆うためである。400 日を超える retry は新しい delivery として扱われ得るため、sender は response-loss retry を保持期間内に完了する。同じ key で body が異なる場合は `409 AutomationInboundWebhookIdempotencyConflict`、同じ署名を別 key へ流用した場合は `409 AutomationInboundWebhookSignatureReplay` とする。署名・timestamp 不正は `401 AutomationInboundWebhookSignatureInvalid`、不正 UTF-8/JSON は `400 AutomationInboundWebhookJsonInvalid`、256 KiB 超過は `413 AutomationInboundWebhookBodyTooLarge`、検証中の endpoint version/secret generation 変更は `409 AutomationInboundWebhookVersionConflict`、Secrets Manager 障害は `503 AutomationInboundWebhookSecretUnavailable` とする。

次の guard を適用する。

- `source=automation` の event は rule が明示的に再入を許可しない限り再度処理しない。
- correlation chain に同じ論理 rule ID がある場合は loop として停止する。
- chain depth 上限を超えた event は実行しない。
- rate limit 超過は action を開始せず、`AutomationRateLimitExceeded` の skip として履歴へ残す。
- retryable failure は backoff 後に自動再実行し、retry 上限到達後は `dead-letter` として管理 UI から明示的に再実行できる。

## Template と複製

Template は Work Item、Project、Workflow の 3 種類を持つ。論理 template ID と immutable version を分離し、作成後の kind 変更は許可しない。複製は current version の payload を新しい論理 template として保存する。Server は kind ごとの top-level field と payload field を allowlist で厳格に検証する。Work Item は `title` と通常の create field、Project は localized name と tone、Workflow は status、transition、initial status の完全な definition を受け付ける。Template を無効化しても既存の recurring definition、固定済み application、実行履歴は削除しない。

Rule/recurring execution は current template ではなく保存済み `templateId` / `templateVersion` から immutable payload を読む。後から template を編集・停止しても、既に固定済みの実行や retry の payload は変わらない。

Project/Workflow template の適用は必須 `Idempotency-Key` と actor、template ID、target を束縛した durable application receipt を最初に予約し、その時点の immutable template version を固定する。同じ key の再送は current template が編集・停止・削除済みでも先に receipt を返す。Pending または期限切れ running receipt だけが runner lease を条件付き取得できるため、並行再送で複数 worker が mutation を開始しない。

Project 適用は application ID を Project ID として使い、Team、localized name、tone が同じ既存 Project だけを強整合 read で成功 replay と認める。Project row、作成者 manager row、Workspace member guard、audit event、application 成功 receipt は同じ DynamoDB transaction で確定する。Workflow 適用は target configuration の expected revision を要求し、既存 `customFields` を保持したまま workflow definition だけを置換する。参照整合性と既存 Work Item usage guard、configuration row、write lock 解放、application 成功 receipt を同じ transaction で確定する。これにより mutation commit 後の応答消失でも、同一 key の retry は別 resource や別 revision を作らず成功 receipt を返す。一時的な 5xx/通信失敗は receipt を再開可能な pending に戻し、検証・権限・revision など確定的な 4xx だけを failed として保存する。

## Recurring work

Recurring definition は Work Item template、Team、IANA timezone、local wall-clock time、日次/週次/月次 cadence、catch-up policy を保持する。`nextRunAt` は UTC instant として保存し、`ScheduleDueIndex` で期限到来分だけを取得する。

DST の扱いは次で固定する。

- spring-forward で local time が存在しない場合は同日の最初の有効時刻へ進める。
- fall-back で local time が 2 回存在する場合は早い instant を選び、同じ local slot を 1 回だけ生成する。
- catch-up `skip` は過去分を生成せず次回へ進める。
- catch-up `latest` は直近 1 slot だけ生成する。
- catch-up `all` は設定上限まで古い順に生成し、残りは次の schedule invocation へ持ち越す。

各 slot は recurring ID と scheduled instant から version に依存しない deterministic execution/receipt を作る。Work Item 作成も同じ receipt 由来の deterministic ID を使い、作成後の応答消失を安全に再開する。Slot 完了後は definition の revision 条件付きで `nextRunAt` を進めるため、並行実行や definition 編集と競合しても同じ slot を別 version として再作成しない。

Slot event は Team、template ID/version、scheduled instant を固定して保存する。失敗中に definition の Team、template、schedule を編集しても、その slot は古い snapshot で完了し、完了後の次回だけを新 schedule から計算する。Schedule を変更しない更新は常に現在の `nextRunAt` を保持し、schedule 変更時も pending/running/retryable failure の slot があれば古い `nextRunAt` を保護する。Definition を `enabled=false` にすると新規 slot とその retry は停止し、再度有効化されるまで pause する。Recurring の Team は template payload の `teamId` より優先する。

自動 retry 上限に達した recurring slot も `dead-letter` として manual retry 可能にする。Manual retry は削除・編集された current rule/definition を引かず、execution に保存した Team、template ID/version、scheduled instant と同じ action ID/receipt を利用するため、成功済み Work Item を重複作成しない。

## Bulk operation

Bulk は UI の選択内容を直接 N 個の通常 API に fan-out しない。最初に preview を作り、対象 ID、読み込み時 revision、権限、workflow/custom field validation、undo 可否を固定する。Edit 対象 field は通常 Work Item update と同じ allowlist に限定する。Apply は item ごとの receipt と before snapshot を保存するが、before/undo payload は API response へ返さない。

Operation 状態は `running`、`succeeded`、`partial`、`failed`、`undone` を持つ。部分失敗時は item ごとに success、conflict、validation failure、permission failure、infrastructure failure を表示する。Retry は失敗 item だけを処理し、成功 receipt がある item を再実行しない。Undo は期限内かつ after revision が変わっていない item だけに before snapshot を戻し、競合 item を部分失敗として返す。

Operation ID と downstream mutation key は開始 actor に束縛する。Retry/undo は operation を開始した member だけが実行でき、管理者 override は設けない。各再実行では owner の現在の Team/Project 権限も再検証する。同じ apply の再配送で durable operation が `running` の場合は残った `ready` item から CAS 付きで再開する。Item mutation または undo の commit 後に応答が失われた場合は、保存済み before snapshot、deterministic mutation key、期待 revision のちょうど 1 増加、適用後 state の一致を確認して成功を回収する。

Archive は hard delete ではなく reversible archive metadata を Work Item に保存する。通常 list/search は archived item を除外し、audit/detail/undo は保持する。

## API

Rule/template/recurring の作成・更新と execution retry は Workspace administration 権限を要求する。Inbound webhook の list/detail を含む管理 API はすべて Workspace administration 権限を要求し、endpoint URL と opaque ID を一般 member へ開示しない。それ以外の参照 API は authenticated member、bulk API と form ingress は Workspace business-write 権限を要求する。Public inbound webhook は Cognito authentication を使わず、上記の HMAC、timestamp、idempotency guard をすべて要求する。

```text
GET|POST  /api/automation/rules
PATCH     /api/automation/rules/{ruleId}
GET|POST  /api/automation/templates
PATCH     /api/automation/templates/{templateId}
POST      /api/automation/templates/{templateId}/duplicate
POST      /api/automation/templates/{templateId}/applications
GET       /api/automation/template-applications/{applicationId}
GET|POST  /api/recurring-work
PATCH     /api/recurring-work/{recurringWorkId}
GET       /api/automation/executions
POST      /api/automation/executions/{executionId}/retry
POST      /api/automation/forms/{formId}/submissions
GET|POST  /api/automation/inbound-webhooks
GET|PATCH|DELETE /api/automation/inbound-webhooks/{endpointId}
POST      /api/automation/inbound-webhooks/{endpointId}/pause
POST      /api/automation/inbound-webhooks/{endpointId}/resume
POST      /api/automation/inbound-webhooks/{endpointId}/rotate
POST      /api/automation/inbound-webhooks/{opaqueEndpointId}  # public signed delivery
POST      /api/bulk-operations/preview
POST      /api/bulk-operations
POST      /api/bulk-operations/{operationId}/retry
POST      /api/bulk-operations/{operationId}/undo
```

Create/duplicate mutation と inbound endpoint の create/rotate は `Idempotency-Key` と `X-Correlation-Id` を受け取り、同じ論理 mutation の client retry で再利用する。同じ create key を異なる payload に再利用した場合は conflict とする。Update と inbound lifecycle は `expectedRevision`、bulk apply は preview 由来の operation token で stale mutation を拒否する。

## 運用

Automation event consumer と recurring schedule は通知 consumer から分離する。どちらも partial retry または Lambda failure destination、暗号化済み SQS DLQ、CloudWatch alarm を持つ。実行履歴は audit event で代用せず、attempt、action result、失敗理由、retry/dead-letter 状態を Automation table に保存し、correlation ID で audit timeline と関連付ける。CDK は event Lambda に outbound webhook prefix の `secretsmanager:GetSecretValue` を付与する。Schedule Lambda は同じ outbound read に加えて、期限切れ inbound secret を削除するため inbound prefix の `secretsmanager:DeleteSecret` を持つ。API Lambda は inbound prefix に対する create/read/version/delete 権限と、outbound webhook 配信に必要な `secretsmanager:GetSecretValue` を持つ。
