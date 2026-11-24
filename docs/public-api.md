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
| `work-items:read` | Work Item の取得と一覧、Work Item に link された Document の一覧と本文、credential 所有者・Team・Project・Project メンバーの参照と Work Item key の解決 |
| `work-items:write` | Work Item の作成と更新、coding agent の OpenTelemetry logs（トークン使用量）の送信（[ADR 0061](adr/0061-agent-token-usage-over-otlp.md)） |
| `work-items:delete` | Work Item の削除 |
| `webhooks:read` / `webhooks:write` | Subscription と delivery log の参照 / 管理・replay |
| `integrations:read` / `integrations:write` | Connector と external link の参照 / 管理 |
| `imports:read` / `imports:write` | Import record/report と export の参照 / dry-run・実行 |

`DELETE /api/v1/work-items/{workItemId}?teamId={teamId}` は Work Item を取り消せない形で削除する（Web には削除がなく、archive だけを出す）。子を持つ Work Item は `409 conflict` で削除しない（子を先に削除するか、別の親へ移す）。削除は Work Item の relation（相手側の row と `relationIds` を含む）と Collection の参照を同じ transaction で消し、準備の後に relation や Collection が変わった場合は `409 conflict` でやり直しを求める。relation と Collection 参照を合わせて 80 件を超える掃除は 1 transaction に収まらないため `409 conflict` で拒否し、先に一部を外してもらう。詳しくは [Work Items](work-items.md#削除と参照の掃除633)。

Credential の scope は作成後に変更しない。権限を変える場合は、新しい credential を最小 scope で作成し、利用側を移行してから旧 credential を revoke する。

## Work Item key

`GET /api/v1/work-items/{workItemId}/key?teamId={teamId}` は Work Item の `ABC-123` 形式の `key` を `{ schemaVersion, teamId, workItemId, createdAt, key }` で返します。`createdAt` は Work Item の作成時刻で、削除後に同じ ID で作り直された Work Item とを区別するのに使えます。key は Workspace 内で一意で、作成後は変わりません。key を持つ前に作られた Work Item では `key` を省きます。権限は `GET /api/v1/work-items/{workItemId}` と同じで、`work-items:read` scope が要ります。既存の `WorkItem` は closed schema なので `key` を含めません。操作の path には従来どおり `id` を使います。Work Item の `title` は 1〜256 文字（Unicode code point）で、超えると `400 validation_failed` を返します。

`GET /api/v1/work-item-keys/{key}` は `ABC-123` 形式の key から `{ schemaVersion, key, teamId, workItemId }` を返します。小文字の key も受け付け、`key` は大文字に正規化した値です。key ではない文字列、使われていない key、削除された Work Item、credential 所有者が読めない Work Item は、どれも同じ `404 not_found` です。Web の `GET /api/work-items/keys/{key}` と同じ判定で、`work-items:read` scope が要ります。

## 参照用の directory

API キーだけで、接続先の Team・Project・メンバーを調べられます。どれも `work-items:read` scope で、request ごとに credential 所有者の現在の権限で評価します。

- `GET /api/v1/me` は credential 所有者を `{ schemaVersion, workspaceId, memberId, name?, email }` で返します。`memberId` は Work Item の `assigneeUserId` に使う値です。
- `GET /api/v1/teams?locale=ja|en` は、所有者が閲覧できる Project と、その Project を持つ Team（Enterprise RBAC で Team を直接与えられた場合はその Team も）を Web の Project directory と同じ規則で返します。Project には `lifecycleState` と charter の要約（`code`、責任者の `ownerMemberId`、`plannedStartDate`、`plannedEndDate`）を含めます。
- `GET /api/v1/projects/{projectId}/members?teamId={teamId}` は Project の active なメンバーと Project 内の role を返します。Web の担当者選択と同じく、所有者にその Project の member 以上の権限が要ります。Workspace から外れたメンバーは含めません。
- `GET /api/v1/projects/{projectId}/raid-log?teamId={teamId}` は Project のリスク・課題・変更要求を、クローズ済みも含めて新しい順に返します。各登録には Web と同じ規則で決めた `severity`（`low`〜`critical`）、担当者の `ownerMemberId`、関連する `relatedWorkItemIds` を含めます。Web の登録簿と同じく、所有者にその Project の viewer 以上の権限が要り、Workspace の guest には返しません。

## Work Item の作成と稼働カレンダー

`POST /api/v1/work-items` の `schedule` は省略できます。省略すると server が作成先の Team・Project の稼働カレンダー（Workspace の
稼働曜日・会社の休日・日本の祝日に Team・Project の上書きを重ねたもの、`calendarSource: 'shared'` 付き）を `calendarPolicy` に付け、`dueDate`（`YYYY-MM-DD`）があればその日が期限の `due-date`、なければ `unscheduled` の
Work Item を作ります。Web で作る Work Item と同じ日で稼働日数を数えるには、こちらを使います。`schedule` を送った場合は、その
`calendarPolicy` をそのまま保存し、その Work Item は個別のカレンダーを持つものとして扱います（Team・Project のカレンダー変更で書き換えない）。
v1 の schema は `calendarSource` を持たないので、応答の `calendarPolicy` にも出しません。更新で送った `calendarPolicy` の規則が
保存済みの共有カレンダーと同じなら、共有カレンダーに従うまま保存します。`schedule` と `dueDate` は同時に送れず、`400 validation_failed` になります。
詳しくは [稼働カレンダーと日本の祝日](workspace-calendar-holidays.md) を参照してください。

## Work Item の階層

`GET /api/v1/work-items/{workItemId}/hierarchy?teamId={teamId}` は Work Item の親と子を `{ schemaVersion, teamId, workItemId, parentWorkItemId, childWorkItemIds, wbsNumber? }` で返します（`WorkItemHierarchy`）。`childWorkItemIds` は読める子だけを兄弟の順に並べます。`wbsNumber` は Team の木の中の番号（`1.2.3`）です。`parentWorkItemId` は、親がない場合と、credential が親を読めない場合に `null` です。Team の Work Item が階層の上限（1,000 件）を超える場合は木を作らず、この Work Item の relation から親と子を返します。このときは `wbsNumber` を省き、`childWorkItemIds` は ID 順です。archive 済みの Work Item は、どちらの場合も階層の外として親 `null`・子なしを返します。権限は `GET /api/v1/work-items/{workItemId}` と同じで、`work-items:read` scope が要ります。

## Work Item Type catalog

`GET /api/v1/work-item-types?teamId={teamId}` は権限内の作成用schemaを返します。
任意query `assignedProjectId` を指定すると、そのProjectへの閲覧権限を確認し、
全Project共通のfieldと指定Projectに適用されるfieldだけを返します。
この追加制約は管理者にも適用し、他Projectだけのfield名・選択肢・既定値・必須条件は返しません。

## Cursor pagination

### Work Item comments

`GET /api/v1/work-items/{workItemId}/comments?teamId={teamId}` は、現在の閲覧権限で
canonicalコメントと返信を新しい順に取得します。`limit`/`cursor` と通常のsigned paginationを使い、
削除済みコメントは返しません。legacy eventコメントの未移行fallbackは含みません。
移行前のCollaboration索引が残る場合も、rootとreplyを新しい順に統合します。
旧索引は日時順ではないため1回の取得で最大20ページ（100行/ページ）を読みます。
互換用の索引行も読み取り件数に含み、上限を超える履歴では順序を崩して返さず `503` になります。
継続位置は索引世代をまたぐ共通の日時・コメントkeyで保持します。

同じpathへの `POST` は `work-items:write` と `Idempotency-Key` を要求し、
`{ "body": "進捗、検証結果、PRリンクなど" }`（1–4096文字）を受け付けます。
作成者はcredentialから解決し、Team/Projectの現在権限、canonical親row、監査、
コメントの冪等作成には既存Collaborationのtransactionを使います。
保存したコメントはWebのタスク詳細にも表示されます。

GET/POSTの任意query `assignedProjectId` は、指定したProjectから移動したタスクへのアクセスを拒否します。
GETは読み取り前後、POSTは保存transactionとreceipt再送時に検証します。
POSTは任意query `assigneeUserId` でも担当者を固定できます。これらは権限を付与する値ではなく、
現在のcredentialの権限に追加する制約です。queryはcursorおよび冪等request fingerprintに含まれます。

一覧要素・作成応答は `{ id, actorUserId, body, createdAt }` です。

### Agent Runs

コーディングエージェントによる Work Item の claim は Agent Run として扱います。契約と状態遷移の正本は
[Software factory](software-factory.md#agent-run) です。

- `POST /api/v1/work-items/{workItemId}/agent-runs?teamId={teamId}` は `Idempotency-Key` を要求し、
  Run の開始と started 遷移を一つの transaction で確定します。応答は `{ run, workItem }` です。
  Team の Agent settings が `readyStatusIds` を持つ場合、Work Item がそのいずれかの status にないと
  `409 conflict` と `errors[].code` の `not_ready` を返します。
- Work Item の受け入れ条件は `GET /api/v1/work-items/{workItemId}/acceptance-criteria?teamId={teamId}` で読みます。
  応答は `{ schemaVersion, teamId, workItemId, revision, items }` で、`items` は `{ id, text, satisfied }` の一覧
  （最大 20 件、`text` は最大 1,024 文字）です。`WorkItem` の response schema は閉じた object のため、条件は含めません。
  PATCH では `acceptanceCriteria` に置き換え後の一覧全体を送り、既存の条件は `id` を、新しい条件は `id` を省いて送ります。
  `id` は読んだ一覧を指すため、`expectedRevision` が古い場合は `409` です。`agentInstanceId` で Agent Run に fence された
  PATCH は、既存の条件の `satisfied` だけを変えられ、追加・削除・並べ替え・文言変更は `403 forbidden` です。
  一覧を送り直さずに条件を満たした・満たしていないにするには、`acceptanceCriteriaMarks: [{ id, satisfied }]` を送ります。
  server は保存済みの一覧に印を重ねるため、応答を失った後に同じ body と `Idempotency-Key` で再送すると、その間に
  一覧が変わっていても replay になります。`acceptanceCriteria` と同時には送れません。
  Agent context の `requireAcceptanceCriteria` が `true` の場合、受け入れ条件（または `acceptanceCriteriaFieldId` の
  custom field の値）がない Work Item の Run start は `not_ready` です。
- 見積の正本は `WorkItem` の `schedule.plannedEffortMinutes` です。残工数と手入力の進捗率は
  `GET /api/v1/work-items/{workItemId}/effort?teamId={teamId}` で読みます。応答は
  `{ schemaVersion, teamId, workItemId, revision, plannedEffortMinutes?, remainingEffortMinutes?, progressPercent? }` で、
  記録されていない値は省きます。`WorkItem` の response schema は閉じた object のため、残工数と進捗率は含めません
  （export の行にも含めません）。PATCH は `remainingEffortMinutes`（分）/ `progressPercent`（0〜100）を受け付け、`null` で
  消します。見積は `schedule` の置換で変えるか、`plannedEffortMinutes`（分、`null` で消す）だけを送って変えます。
  `plannedEffortMinutes` は server が保存済みの schedule に書き込むため、body が読み込んだ日付に依存せず、同じ
  idempotency key の再試行は途中で日付が動いても同じ request として replay されます。最新の revision が必要で、
  `schedule` とは同時に送れません。見積だけの変更は dependency の確認を必要としません。不正な値は
  `400 validation_failed` です。詳細は [Work Items](work-items.md#estimate-remaining-effort-and-progress) を参照してください。
- 実績開始日と実績終了日は `GET /api/v1/work-items/{workItemId}/actual-dates?teamId={teamId}` で読みます。応答は
  `{ schemaVersion, teamId, workItemId, revision, actualStartDate?, actualEndDate? }` で、日付は schedule の calendar
  timezone での `YYYY-MM-DD` です。`actualStartDate` は初めて `started` か `completed` に入った日で、着手前は省きます。
  `actualEndDate` は直近の完了日で、`completed` の間だけ返します。権限は `GET /api/v1/work-items/{workItemId}` と同じで、
  `work-items:read` scope が要ります。`WorkItem` の response schema は閉じた object のため、実績日は含めません。
  `GET /api/developer/exports` は `WorkItem` schema の page、`GET /api/developer/work-item-exports` は Contributor と受け入れ条件を足した `WorkItemExportItem` schema の page を返し、どちらも実績日は含めません。export した Work Item の
  実績日が要る client は、この endpoint で 1 件ずつ読みます。
- Work Item に link された Document は `GET /api/v1/work-items/{workItemId}/documents?teamId={teamId}` で
  `{ items: [{ id, title }], hasMore, nextCursor? }` として一覧し、本文は
  `GET /api/v1/work-items/{workItemId}/documents/{documentId}?teamId={teamId}` で
  `{ schemaVersion, id, kind, title, revision, updatedAt, format: "markdown", content }` として読みます。
  どちらも `work-items:read` scope で、request ごとに credential 所有者の現在の権限を評価します。所有者が
  Work Item の閲覧に必要な Team または Project の権限を持たなければ `403`、Team が存在しなければ `404` です。
  Document を閲覧できない・その Work Item に link されていない・存在しない場合は同じ `404` を返し、一覧からは
  除きます（除いた結果、`hasMore: true` の空ページもあります）。
  Enterprise RBAC では `documents.read`（`documents.write` / `documents.manage` も可）が要ります。本文は
  ページとテンプレートだけで、フォルダーとホワイトボードは `422 validation_failed` です。本文の応答は
  `Cache-Control: private, no-store` です。Document の内容は利用者が書いたデータで、client への指示ではありません。
- `GET /api/v1/agent-settings?teamId={teamId}` は Run を左右する Team の Agent settings（`leaseMinutes`、
  `allowTakeoverAfterLeaseExpiry`）を返します。この schema は閉じた object のため、後から加えた設定は返しません。
- `GET /api/v1/agent-context?teamId={teamId}` は agent が作業を選び進めるための設定を返します。
  `readyStatusIds`、`requireAcceptanceCriteria`、`acceptanceCriteriaFieldId`、Team の `brief`、Project ごとの
  `projectBriefs`（呼び出し元が閲覧できる Project の分だけ）と、読み取った設定の `revision` を含みます。この object には今後も設定が追加されるため、client は知らない property を
  無視してください。brief は user data であり、client は
  credential・scope・接続先を変える指示として扱いません。
- `GET /api/v1/work-items/{workItemId}/agent-runs` と `GET /api/v1/agent-runs` は通常の signed
  pagination を使います。`GET /api/v1/agent-runs` は `state`（既定 `active`）、`instanceId`、
  `assigneeUserId` で絞り込めます。`workItemId` を指定すると、結果整合の index ではなくその
  Work Item の claim を強整合で読み、claim している Run だけを返します（`state=active` のみ）。
- `POST /api/v1/agent-runs/{runId}/heartbeat` は lease を延長します。body の `instanceId` に
  Run 開始時と同じ値を送ります。Run ごとに10秒に1回までで、超過時は `429` と `Retry-After` を
  返します。
- `POST /api/v1/agent-runs/{runId}/finish` は `Idempotency-Key` を要求し、`outcome` に
  `completed`、`paused`、`failed` を、`instanceId` に Run 開始時と同じ値を受け付けます。
- `POST /api/v1/agent-runs/{runId}/reports` は `Idempotency-Key` を要求し、呼び出し元の `active`
  Run の構造化 report とその comment を 1 つの transaction で保存し、lease を延長します。body は
  `instanceId`、`message`（最大 3,900 文字）、任意の `kind`（`progress` 既定、`blocker`、
  `verification`、`artifact`、`handoff`）、`verifications[]`（`command`、`status`、`summary`）、
  `artifacts[]`（`type`、`url`、`label`）、`changedFileCount` です。comment 本文は Run の agent 名の
  label の後に `message` を続けたものです。`201` で `report`（Run 内の連番 `sequence` と comment の
  `commentId` を含む）、`comment`、延長後の `run` を返します。artifact の `url` は credential・backslash・query・
  `=` を含む fragment のない `https` URL に限り、違反は `400 validation_failed` と `errors[].code` の `invalid_artifact_url`
  で返します。server は URL を取得しません。任意の query `assignedProjectId` を送ると、Run の
  Work Item がその Project にない場合は保存せず `403` を返し、receipt の再送時にも再検証します。
- `POST /api/v1/work-items/{workItemId}/agent-runs/{runId}/take-over` は `Idempotency-Key` を
  要求し、同じメンバーの別 instance が持つ停滞 Run（lease 切れ）を `superseded` にして、呼び出し元
  instance の新しい Run を開始します。body は `runtime`、`agentName`、`instanceId` です。Team の
  Agent settings で `allowTakeoverAfterLeaseExpiry` が `true` の場合だけ成功し、許可されていない
  場合は `403` と `agent_run_takeover_disabled`、lease が切れていない場合は `agent_run_conflict`
  を返します。start・resume と同じく、認可の後に呼び出し元の member や Team・Project の権限が
  変わった場合は確定しません。このとき server は認可をやり直し、権限を失った呼び出し元には新しい
  request と同じ `403` を、権限を保ったまま member・Team・Project・Enterprise
  の設定が変わった場合は `409 conflict` を返します。
- Agent Run の request の `agentName` は文字（任意の言語）、数字、半角スペース、`.`、`_`、`-` だけで、
  前後にスペースを置けません（例: `Codex/CLI` は不可）。`instanceId` と `agentInstanceId` は前後の空白と
  制御文字（U+0000〜U+001F、U+007F）を含められません（例: 先頭に空白のある `" laptop"` は不可）。違反は
  `400 validation_failed` です。OpenAPI ではこの規則を `description` に書き、`pattern` は付けていません。
  既存 schema への `pattern` 追加は互換性検査で破壊的変更と判定されるうえ、`\p{L}` を解釈できない
  生成ツールでは有効な名前まで拒否されるためです。
- 同じメンバーの別 instance は、他 instance の Run を heartbeat・report・finish できません。`active` な
  Run には `agent_run_conflict`、終了済みの Run には `agent_run_not_active` を返します。
- `PATCH /api/v1/work-items/{workItemId}` とコメントの `POST` は任意の `agentRunId` と
  `agentInstanceId` を受け付けます。どちらも送らない既存 client の挙動は変わりません。
- Run 固有の拒否理由は problem の `errors[].code`（`agent_run_conflict`、`agent_run_not_active`、
  `agent_run_forbidden`、`invalid_transition`、`agent_run_takeover_disabled`、`invalid_artifact_url`、
  `not_ready`）で
  返し、`code` は既存の `conflict` / `forbidden` / `validation_failed` です。
[Coding Agent MCP](coding-agent-mcp.md)はこのAPIで作業報告を保存します。

### Pagination contract

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

Actor は API key では key ごと、OAuth access token では発行元の OAuth app ごとに決まる。同じ OAuth app から発行し直した token で同じ `Idempotency-Key` を再送しても replay され、二重に作成されない。

Connector の authorization / reauthorization は内部 operation ID から OAuth state と PKCE verifier を導出し、未失効の同一 flow を再利用する。Response receipt 保存前に process が停止しても、同じ idempotency key の再送で provider authorization flow を増殖させない。

## Error と rate limit

Error は `application/problem+json` の `ApiProblem` に統一する。`code` は client 分岐用の安定値、`requestId` は support 照合用、`retryable` は同じ intent を再試行できる可能性を表す。Field 位置を特定できる入力 error は JSON Pointer、field code、message を `errors` に含める。

すべての API response は次の header で quota を通知する。

- `RateLimit-Limit`: 現在 window の上限
- `RateLimit-Remaining`: window 内の残数
- `RateLimit-Reset`: quota 回復までの秒数
- `Retry-After`: `429` または一時的な `503` で待つ秒数

Credential の quota は API key では key ごと、OAuth access token では発行元の OAuth app ごとに数える。同じ app の token はすべて 1 つの quota を共有し、token を発行し直しても残数は戻らない。

Client は `Retry-After` を優先し、値が無い retryable error では full jitter 付き exponential backoff を使う。`401`、`403`、validation error、idempotency conflict は自動 retry しない。

Token endpoint（`POST /v1/oauth/token`）は 2 種類の 1 分 window で制限する。

- IP 単位（60 回）: client secret の確認前に、すべての request を数える。IP は CloudFront 経由なら origin secret で検証した viewer address（`x-mukuroji-viewer-address`）、HTTP API を直接呼んだ場合は Lambda event の `requestContext.http.sourceIp` を使う。信頼できる address がない request（Bun server など）は 1 つの bucket を共有する。Internet client が指定できる `Forwarded`、`X-Forwarded-For`、`X-Real-IP` は rate-limit identity に使わない。例外として、`MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES` に登録した proxy から届いた request に限り、`X-Forwarded-For` の先頭の値を使う。この proxy は client が送った転送 header を捨てるか上書きし、自分が見た接続元だけを先頭に置く必要がある。
- Client 単位（30 回）: client secret と OAuth app の状態を確認できた request だけを数える。公開値の `client_id` を知っているだけの第三者が、誤った secret でその client の token 取得を止めることはできない。誤った secret の試行は IP 単位の制限で抑える。そのため、同じ IP（Bun server では送信元が分からない request 全体）から誤った secret で 60 回試行されると、その window の間は正しい secret を持つ client の request も IP 単位の制限で `429` になる。

## Signed webhook

Webhook body は `WebhookEventEnvelope` で、retry と手動 replay の間も同じ event ID を保つ。Delivery request には次の header を付ける。

購読できる event type は `WebhookEventType`（contracts の `WEBHOOK_EVENT_TYPES`）で、Work Item の作成・更新・削除、[Work Item relation の event](./event-audit.md#work-item-relation-の-event)（`work-item.parent-changed`、`work-item.blocker-removed` など 10 種）、external link、同期競合、import の event を含む。Work Item の event はすべて `work-items:read` scope を要求する。event type は今後も追加するので、consumer は知らない `type` の delivery を `2xx` で受けて無視する（[ADR 0045](./adr/0045-relation-events-for-automation-and-webhooks.md)）。

Relation の event は変更を記録した側の Work Item 1 件の event で、`data.entity.id` が `team/<teamId>/issue/<issueId>`、`data.metadata` が `teamId` と（Project に割り当てられていれば）`projectId` を持つ。相手の Work Item は subscription 作成者が見られない Project にあることがあるので、相手の ID・title は payload に含めない。配信の可否は、ほかの Work Item event と同じく記録した側の Team と Project に対する作成者の現在の権限で決める。Project の記録を持たない古い relation event（`metadata.projectScopeRecorded` がないもの）は配信しない。

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

Provider の OAuth callback（`GET /api/developer/connector-oauth/callback`）は Mukuroji の認証情報を持たないため flow を完了しない。state と code（provider が拒否した場合は `cancelled=true`）を URL fragment に載せて Web の `/settings/connectors/oauth-callback` へ 303 で引き渡し、Web が利用者の Bearer token で `POST /api/developer/connector-oauth/complete` を呼ぶ。Server は state を consume したあと、flow を開始した Workspace と user が呼び出し元と一致しなければ 403 を返し、state は再利用できなくなる。Provider の redirect URI が Web と別 origin の API を指す場合は、API の `CONNECTOR_OAUTH_WEB_ORIGIN` に Web の origin を設定する。判断の経緯は [ADR 0014](adr/0014-bind-connector-oauth-callback-to-initiator.md)。

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
管理 API の削除は
`DELETE /api/developer/external-links/{externalLinkId}?teamId={teamId}&workItemId={workItemId}`
を使い、保存済み receipt の replay 時にも同じ Team / Work Item の current write RBAC を
再評価する。

External link の削除は link、provider identity claim、link 固有の sync state、Work Item ごとの active-link counter、監査 event、idempotency response を同じ transaction で確定する。Open conflict 中は通常の方向変更や削除を許可せず、先に resolve または ignore する。Work Item 自体を削除する場合も、すべての external link を先に解除する。削除 transaction は active-link counter を 0 条件で tombstone に置換し、並行する link 作成を同じ DynamoDB fence で直列化する。

管理 session の `GET /api/developer/work-items/{workItemId}/external-links` は現在の Work Item viewer に read-only 表示を許可する。Link の作成・方向変更・解除と connector installation 一覧は引き続き Workspace integration 管理権限を必要とする。

## CSV/JSON import と export

Import は mapping の作成、dry-run、source の再送、report 確認の順に進める。1 回の source は 10,000 行・4 MiB まで（#394。以前は 1,000 行・2 MB）。4 MiB は、受け取った `source.content` の文字列を request body の JSON と Lambda event の JSON で 2 回 escape した後の UTF-8 の大きさで数える（`"` は 4 byte、改行は 3 byte。API の request は 6 MB の Lambda payload に収める必要があるため）。数え方は contracts の `measureWorkItemImportContentBytes` と同じ。client が非 ASCII を `\uXXXX` に escape して送っても数え方は変わらないが、送る request はそのぶん大きくなる。`source.content` が 4 MiB を超えると dry-run・import とも `400 validation_failed`。10,000 行を超えると、dry-run は `413 validation_failed`（detail は `Import cannot contain more than 10000 rows.`）、import は `202` で受け付けた後、worker の検証で job が `failed`（`validation_failed`）になる。request body 全体が 6 MB を超えると、API に届く前に Lambda の payload 上限で `413` になる。

1. UTF-8 の CSV または JSON source と、`sourceField` から canonical/custom `targetField` への mapping を送る。`schedule` に `calendarPolicy` がない行は Workspace の稼働カレンダーを使い、`date-range` で `durationDays` もない行はその稼働カレンダーで稼働日数を数える。
2. `/api/developer/imports/dry-run` で parse、変換、required field、workflow status、custom field、Team/Project access を検証する。Dry-run は Work Item や ImportJob を保存せず、`totalRows`、`validRows`、`invalidRows`、row/field error と sample preview を返す。
3. Error を修正し、`POST /api/developer/imports` へ同じ mapping と source 全体を再送する。API は現在の管理権限を確認し、source を暗号化・versioning 済み storage に固定して durable job を queue するため、row ごとの remote validation 完了を待たない。
4. 成功時は `202 Accepted` と `queued` の import record を返す。Worker は durable queue から job を取得し、現在の Team/Project access、workflow、assignee、custom field 設定を再検証してから `running`、`completed` または `failed` へ遷移させる。実行中も row ごとに current RBAC を確認し、終了後は validation failure の場合も集計と bounded row error report を取得できる。
5. `DELETE /api/developer/imports/{importJobId}` は未完了 job に cancellation を要求する。実行中の Worker は永続化した cancellation 状態を確認し、安全な区切りで停止する。
6. `GET /api/developer/imports/{importJobId}/progress` は `{ jobId, status, totalRows?, processedRows, totalLinks?, processedLinks }`（`ImportJobProgress`）を返す。Worker は全行を作ってから親子・依存・relation・受け入れ条件の link を付けるので、行と link を分けて数える。総数は Worker が source を検証するまで省く。Web の Developer Platform 画面は job が終わるまで 3 秒ごとに読み、「5,000 行中 1,200 行を作成」のように出す。権限は `GET /api/developer/imports/{importJobId}` と同じ。

大きな import は 1 回の Worker 実行で終わらせない。Worker は job を claim してから 10 分（`WORK_ITEM_IMPORT_SLICE_SECONDS`）を過ぎると、次の行か link に進む前に lease を外し、同じ job の message を queue に積んで今の message を終える（ADR 0071）。次の実行は checkpoint の次から続け、そのたびに source を読み直して現在の権限と設定で全行を再検証する。message を積めなかったときは今の message を retry にする。

### 階層・依存・Contributor・受け入れ条件の import

Mapping の `targetField` には Work Item の項目に加えて、行どうしの関係を表す次の項目を指定できる（#339）。どれも省略でき、省略した import の動作と report の形はこれまでと変わらない。

| `targetField` | 値 | 意味 |
| --- | --- | --- |
| `importKey` | 256 文字以内の文字列 | 他の行がこの行を参照するキー。export の `key` 列（別の Team に同じ ID があるときは `<teamId>/<id>`）を割り当てると再 import で同じ構造になる。`id` 列は Team をまたぐと重なることがあるため使わない。必須にした mapping では、空白だけの値も欠けているものとして扱う。 |
| `wbsNumber` | `1.2.3` など | WBS 番号。`parentKey` がない行は、最後の `.` より前（`1.2`）を WBS 番号に持つ行を親にする。`importKey` がない行の参照キーにもなる。 |
| `outlineLevel` | 1〜100 の整数 | アウトラインの深さ（MS Project の OutlineLevel）。`parentKey` と `wbsNumber` がない行は、直前にある 1 段浅い行を親にする。空欄は 1。 |
| `parentKey` | 他の行のキー | 親の行。`wbsNumber` と `outlineLevel` より優先する。 |
| `dependencies` | `1.2FS+2d, 3SS-1`、`a1 SS +2` または `[{ "key", "type", "lagDays", "constraint" }]` | この行の先行タスク。JSON の `constraint`（省略可）は後続の日付制約 `{ "anchor": "start" \| "finish", "kind": "on" \| "not-before" \| "not-after", "date": "YYYY-MM-DD" }` で、取り込む日程が満たさないと dry-run の error になる。種類は `FS`・`SS`・`FF`・`SF`（省略は `FS`）、ラグは暦日。件数の上限はない（Planning が持てる依存に合わせる）。空白を挟まない形では種類を大文字で書き、項目全体が他の行のキーと一致すればそのキーとして読む。キーの末尾が種類やラグに見える場合は空白で区切る。 |
| `relations` | `blocks:2, related:3` または `[{ "type", "key" }]` | 親子以外の relation。種類は `blocks`・`blockedBy`・`related`・`duplicate`。1 行 100 件まで（Work Item が持てる relation の数）。両方の行に書いた同じ relation は 1 つにまとめる。 |
| `contributors` | `member:<userId> effort:2h; role:<jobRoleId>` または `contributorAssignments` と同じ JSON 配列 | Contributor。`;` か改行で区切り、`member:`・`role:`・`effort:`（分、または `2h`・`30m`）・`status:` を空白で並べる。接頭辞のない値は member。member の後の接頭辞のない語は名前の続きとして読む（`member:Yamada Hanako effort:2h`）。1 つの Contributor に member を 2 つ書くと error。 |
| `acceptanceCriteria` | 1 行 1 条件、または `[{ "text", "satisfied" }]` | 受け入れ条件。行頭の `[x]` は達成済み、`[ ]` と `- ` は取り除く。20 件まで。 |

参照は同じ file の行だけを指し、`importKey` を先に、見つからなければ `wbsNumber` を探す。Dry-run は次を row error として返し、1 行でも error があれば import を開始できない。

- 参照先がない、自分自身を指す、キーが重複する、親の参照が循環する、依存が循環する（循環の上にある行だけに出し、循環の前後や二つの循環をつなぐだけの行には出さない）、`blocks` の relation が循環する、同じ先行タスクを 2 回書いた（`ImportReferenceInvalid`、`ImportKeyDuplicate`、`ImportHierarchyCycle`、`ImportDependencyCycle`、`ImportRelationCycle`、`ImportDependencyDuplicate`）
- 他の行が書いた relation の相手側と親（`parent:<id>`）を合わせて、1 行の relation が 100 件を超える（`ImportRelationLimitExceeded`。relation は両端に書かれるため）。import が足す親子と relation に Team に既にある link を足すと、Team が持てる 10,000 件を超える場合も同じ code（上限を超える最初の link の行に出す。Team にある link を数えるのは dry-run だけで、worker の再検証では数えない。worker が付け終えた link を二重に数えないため）
- 親の Work Item Type が子の Type を許可しない（`WorkItemChildTypeDenied`）
- 依存の両端に Team と Project の manager 権限がない（Enterprise のロールでは、各行の Team か Project で `planning.manage`。worker が依存を作るときと同じ確認）、どちらかの行に日程がない、取り込む日程が依存を満たさない（`ImportDependencyScheduleConflict`。依存は作成時に日程を満たす必要があるため）
- Contributor の member が有効な Workspace member でない、ジョブロールがない・archive 済み

Worker は全行を作成した後に、親子、依存、relation、受け入れ条件の順で 1 件ずつ付ける。各 link の完了も row と同じ durable receipt に記録するため（番号は `totalRows` の次から続く）、retry や lease takeover では残りの link から再開し、既にある link は作り直さない。Link の前にも cancellation、tenant 状態、現在の権限を確認し、そのとき読んだ Workspace member と Planning の版を link の書き込みと同じ transaction で確かめる。依存の ID は job と link の位置から決まる。依存は、Planning の版を読んでから両端の権限を確かめるため、確認の後に端の Work Item が移ると作成は版の競合で失敗する。Import の途中で誰かが受け入れ条件を付けた Work Item は上書きせず、job を `ImportAcceptanceCriteriaChanged` で止める。Link で止まった job の report では、作成済みでも link を付け終えていない行を `invalidRows` に数える。

Worker retry を使い切った job は `failed` として source を削除し、DLQ の locator は運用診断専用に保持する。再実行は修正済み source と新しい idempotency key で新規 job を作成する。

同じ request の再送は idempotency record で job の二重作成を防ぎ、修正した source の再実行には新しい idempotency key を使う。各 row の Work Item ID は Workspace、actor、idempotency key、Team、row から決まるため、Worker の retry や lease takeover でも同じ row を二重作成しない。

Worker が retry 上限に達した message は原因調査用 DLQ に保持する。DLQ の redrive で terminal job を再開せず、原因を修正した後に新しい idempotency key と source で import を作成し直す。

Export は `GET /api/developer/exports?format=csv|json` で同期 download する。`teamId`・`assignedProjectId`・`assigneeUserId`・`workflowStatusId`・`workItemTypeId`・`updatedAfter`（ISO 8601）で絞り込める（`/api/developer/work-item-exports` も同じ）。絞り込みは cursor に束縛され、別の条件で cursor を使うと `400` になる。閲覧できない Team・Project を指定すると、存在を明かさないよう空の page を返す。現在の RBAC で閲覧可能な Work Item だけを含め、credential、internal key、secret、redact 対象 field は含めない。この page の Work Item は閉じた `WorkItem` schema のままにする。Web の export は `GET /api/developer/work-item-exports?format=csv|json` を使い、Workspace 管理者（`canExport`）に限るため、この page の Work Item（`WorkItemExportItem` schema）は Contributor（`contributorAssignments`）と受け入れ条件（`acceptanceCriteria`）も含む。残工数（`remainingEffortMinutes`）と手入力の進捗（`progressPercent`）は含めない。

Web の export file は CSV・JSON・Excel（`.xlsx`）・MS Project XML から選べる。Excel と MS Project XML は JSON の export page から browser で作る。各 Work Item の Team の階層（`GET /api/teams/{teamId}/work-item-hierarchy`）と Planning の依存（`GET /api/planning`）を読み、次の列を足して WBS の順に並べる。

| 列 | 内容 |
| --- | --- |
| `key` | ほかの行が参照に使うキー。Work Item ID。ただし同じ ID の Work Item が export の別の Team にもあるときは `<teamId>/<id>`。`parentId`・`dependencies`・`relations` と MS Project の Task もこのキーで指す。import の mapping では `importKey` に当てる |
| `wbsNumber` | export 全体で階層の順に振り直した番号（`1`、`1.1`、`2` など）。Team ごとの WBS 番号ではないので、複数 Team の export でも重ならず、import の参照キーにそのまま使える |
| `outlineLevel` | export に含まれる Work Item の中での階層の深さ（1 から） |
| `parentId` | export に含まれる最も近い祖先の `key` |
| `workItemTypeId` | Work Item Type の ID |
| `dependencies` | 先行 Work Item を `<id> FS +2` の形で `;` 区切り。日付制約のある依存を含む cell は `{ key, type, lagDays, constraint }` の JSON 配列。JSON では同じ形の配列 |
| `relations` | parent・child 以外の relation を `blocks:<id>` の形で `;` 区切り。JSON では `{ type, key }` の配列 |
| `contributors` | `member:<id> role:<id> effort:<分> status:<状態>` を `;` 区切り。JSON では配列 |
| `acceptanceCriteria` | 1 行に 1 条件、達成済みは `[x]`、未達成は `[ ]` で始まる。改行を含む条件や `[`・`-`・`*`・`・` で始まる条件があるときは `[{ "text", "satisfied" }]` の JSON 配列。JSON では `{ text, satisfied }` の配列 |

依存と relation は、相手も同じ export に含まれるものだけを書く。Planning か、いずれかの Team の階層を読めない場合は export が失敗する（依存や親の列が空の file を import し直すと、依存や階層が失われるため）。どの形式も上の import の書き方に合わせているため、export した file をそのまま import すると同じ階層・依存・relation・Contributor・受け入れ条件で作り直せる（ID は新しくなる）。Excel の `dueDate` は日付 cell、ほかは文字列 cell で書く。MS Project XML は Task の `UID`・`OutlineNumber`（`wbsNumber` と同じ番号）・`OutlineLevel`・`PredecessorLink`（lag は暦日）と、責任者と Contributor の Assignment を書き、Resource の名前は user ID にする。Assignment に入らないジョブロールだけの Contributor と、ジョブロール・状態は、Task の Text1（別名 `mukuroji contributors`）に JSON 配列で書き、import はこの項目があれば Assignment より優先して読む。親子でも依存でもない relation は Text2（別名 `mukuroji relations`、相手は Task の `UID`）、受け入れ条件と達成状態は Text3（別名 `mukuroji acceptance criteria`）に JSON 配列で書き、import は `Relations`・`AcceptanceCriteria` の列として読む。項目は別名で探すため、MS Project で保存し直して番号が変わっても読める。依存の日付制約は MS Project の link に対応する項目がないため、MS Project XML には書かず、制約のある依存を MS Project XML で import し直すと制約はなくなる（CSV・JSON・Excel には残る）。API の export page 自体は追加の列を持たない。

Web の import は CSV・JSON に加えて Excel（`.xlsx`）と MS Project XML を選べる。どちらも browser で JSON の row に変換してから同じ dry-run と import に送るため、Public API の format は CSV・JSON のままである。

- Excel は最初の 20 行から header 行を探し、その sheet の表を読む。cell は文字列にして送り、日付の書式の cell は `YYYY-MM-DD` にする。file は 10 MB まで、ZIP64・暗号化した file は読まない。
- MS Project XML は Task ごとに `UID`、`Name`、`WBS`、`OutlineLevel`、`Owner`（最初の Assignment の Resource の e-mail か名前）、`Contributors`（ほかの Assignment と作業時間）、`Predecessors`（`<UID> SS -1` の形、lag は作業日 8 時間か暦日で日数に直す）、`Schedule`、`Notes` の列を作る。`Schedule` は、マイルストーンの Task を終了日の milestone、開始日と終了日のある Task を期間（1 日の Task も含む）、終了日だけの Task を期日にする。依存には両側の開始日と終了日が要るため、期日だけの Task は依存に使えない。export は期日の Work Item を終了日だけで、milestone をマイルストーンとして書く。Resource はメールアドレスか表示名で Workspace member に照合する（下の「責任者と Contributor の書き方」）。document type 宣言のある XML は読まない。
- JSON の file は全行から列を集め、`customFieldValues` の中は `customFieldValues.<fieldId>` の列として扱う。
- file を選んだときに mapping が空なら、mukuroji の export の列名と MS Project の列名から mapping を提案する。親の列があるときは WBS 番号と階層の深さは提案しない。

責任者と Contributor の書き方: import の `assigneeUserId` と Contributor の member は、user ID（member のメールアドレス）か Workspace member の表示名で書ける。メールアドレスは小文字にして user ID として扱う。`@` を含まない値は表示名として、大文字小文字・前後の空白・全角半角の違いを無視して active な member と照合し、1 人だけに一致したときにその user ID にする。一致しない場合は `ImportMemberUnknown`、2 人以上に一致する場合は `ImportMemberAmbiguous` を row error で返す。表示名を使う row があるときだけ Workspace の member 一覧を読む。
