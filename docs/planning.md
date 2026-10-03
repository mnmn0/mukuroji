# Planning domain

Issue #27 の Planning domain は、短期の Cycle と中長期の Portfolio / Roadmap / Initiative / Goal、Project phase / Milestone / Release を一つの Workspace graph として扱います。Canonical Work Item 自体に計画フィールドを重複保存せず、Planning table の link row を正本にします。

## 永続化と並行更新

`PlanningTable` は `workspaceId` / `recordKey` を primary key とし、次の row を保存します。

- `META`（`workspaceId = FENCE#<workspaceId>`）: planning storage schema version と Workspace graph revision
- `ENTITY#<id>`: planning entity
- `DEPENDENCY#<id>`: directed scheduling dependency
- `WORK_ITEM_DEPENDENCY#<id>`: Team-qualified Work Item 間の canonical schedule dependency
- `LINK#<teamId>#<workItemId>`: Work Item から Cycle / Milestone / Goal への link
- `UPDATE_TARGET#PROJECT#<teamId>#<projectId>` / `UPDATE_TARGET#INITIATIVE#<entityId>`: update owner、cadence、次回期限、latest version の bounded projection
- `UPDATE#<target>#<zero-padded-version>`: structured health update の append-only 正本
- `UPDATE_ID#<target>#<updateId>`: target 内で update ID の再利用を防ぐ immutable marker
- `UPDATE_COMMENT#<target>#<version>#...`: immutable update に対する append-only comment
- `UPDATE_COMMENT_ID#<target>#<version>#<commentId>`: update version 内で comment ID の再利用を防ぐ immutable marker
- `UPDATE_REACTION#<target>#<version>#...`: immutable update に対する member reaction

Planning API snapshot は `schemaVersion: 2` を返し、Web は現在の schema version の snapshot だけを受け付けます。DynamoDB の storage schema version 1 は API contract から独立しています。Revision の正本は、graph row の `<workspaceId>` partition から分離した `FENCE#<workspaceId>` partition の `META` row だけです。

### Revision fence

Planning client は FENCE `META` だけを強整合 read し、row がなければ revision 0 として扱います。FENCE `META` の作成・更新は常に DynamoDB transaction 内の revision CAS（初回は `attribute_not_exists`、以降は `revision = expectedRevision`）で行います。Runtime の DynamoDB document client は、transaction 外の Put / Update / Delete による FENCE `META` への直接書き込みと、PartiQL / BatchWrite による書き込みを `PLANNING_REVISION_FENCE_BARRIER_REQUIRED` で fail-closed に拒否します。Canonical Work Item を書く worker には、`FENCE#*` partition の revision 属性を `TransactWriteItems` 内でだけ更新できる IAM 権限を付与します。

すべての mutation は snapshot の `expectedRevision` を必須とし、認可に使った snapshot と mutation の revision を一致させたうえで、`META` の revision CAS と対象 row を同じ DynamoDB transaction で更新します。Stale write は `409 PlanningRevisionConflict` で拒否し、階層、dependency、link の部分更新を残しません。Canonical Work Item projection は強整合 read で取得します。Workspace member の role / status 更新と Planning scope が参照する Team / Project の archive は、事前検査した `META` revision を directory mutation と同じ transaction で一つ進めます。並行する Planning create / move とは一方だけが成功し、競合側は最新 snapshot で再検査します。

1 Workspace の graph projection は metadata を含め 2,000 row、1 row は安全余裕を含む 300 KB、1 transaction は 100 item / 3 MB、API snapshot は4 MBを上限とします。Versioned update、comment、reaction は graph snapshot に展開せず、target-prefix の cursor API で取得します。Graph read は META の強整合 read を前後 barrier にし、mutable graph の5 prefixだけを強整合 Queryするため、増え続ける update history / annotation rowを物理的に走査しません。Entity description は UTF-8 で 20 KB、legacy status update は1件 8 KB・entity ごとに新しい順で32件までです。Legacy status update は read compatibility のため残し、新しい Project / Initiative report は上限32件のない versioned update を正本にします。上限超過は commit 前に `413` で拒否し、response だけ失敗して revision が進む状態を作りません。

## 階層と roll-up

許可する基本階層は `Portfolio → Roadmap → Initiative → Goal/OKR` で、OKR は `Objective → Key Result` を表現できます。その下に `Phase → Milestone/Release` を配置します。Project 計画の実用性のため、Phase は Roadmap / Initiative の直下、Milestone / Release は Roadmap / Initiative / Goal の直下にも配置できます。Cycle と Portfolio は root です。Self reference、存在しないまたは archive 済みの親、循環は保存しません。親を archive する前に active な子を移動または archive する必要があり、dependency と Work Item link は履歴として保持します。

Automatic progress は、関連 Work Item と子孫の現在状態から on-read で決定します。`completed` は 100、`started` は 50、`backlog` / `unstarted` は 0 とし、`canceled` は分母から除外します。同じ Work Item が複数経路から辿れる場合も、ancestor ごとに一度だけ数えます。Manual progress を指定した entity は 0〜100 の保存値を使います。Health は entity 自身の risk で補正し、`high` / `critical` は `off-track`、`medium` は少なくとも `at-risk`、`none` / `low` は報告された health を effective health とします。`rollupHealth` は自身と active な子孫の effective health のうち最も悪い値を返します。

## Cycle rollover

Cycle は date-only の baseline / forecast、cadence、Work Item 件数単位の整数 capacity、carry-over policy を持ちます。Link と rollover は capacity 超過を commit 前に拒否します。Rollover は source / target Cycle が同じ Team / Project scope と cadence で、target の baseline / forecast が source より後に始まることを確認し、source を `completed` にします。

- `move-incomplete`: `completed` / `canceled` 以外の Work Item link を target Cycle へ移動
- `keep-incomplete`: 未完了 link を source Cycle に保持

Response は再計算済み snapshot と `movedWorkItemIds` / `retainedWorkItemIds` を返すため、同じ入力と revision から結果を再現できます。

Rollover は canonical Work Item revision を Planning META と同じ DynamoDB transaction で条件検証します。Transaction の100 item上限に合わせ、一度に検証できる source link は49件までです。削除済み・閲覧不能の Work Item が link された場合は rollover を fail-closed にし、Workspace owner / admin が既存の DELETE API で stale link を清掃してから再実行します。Work Item の Project が変わった link は snapshot / roll-up から除外し、新しい Project scope へ明示的に再 link するまで rollover を拒否します。

Cycle を archive できるのは、残っている link の canonical Work Item がすべて `completed` / `canceled` の場合だけです。未完了なら先に rollover または unlink が必要で、canonical Work Item が削除済み・閲覧不能なら fail-closed に拒否します。archive 時も対象 Work Item の revision を Planning META と同じ transaction で条件検証します。

## Project / Initiative health update

### Update Feed read model (Issue #241, first slice)

`GET /api/planning/update-feed?view=recent&limit=50` returns a live, permission-aware aggregate of the latest Project / Initiative summaries. Supported views are `recent`, `for-me`, `at-risk` (including off-track), `missing`, `stale`, and `overdue`. Health remains independent from submission state. Matches contribute to one target entry, not duplicate entries. The fourth slice below defines the current explainable relevance and attention ranking. Recent excludes targets without a report; submission views include them with unknown health.

The reader uses the existing bounded Planning graph (maximum 2,000 rows / 4 MB), without loading Work Items, history, comments, or reactions. No update body, canonical row, or feed copy is written. Each request revalidates active directory hierarchy, current target permissions, and the latest summary's captured scope, reusing request-local directory and ACL reads across targets. Archived and revoked targets are excluded. Moved-scope or unprovable legacy summaries are removed while their currently authorized targets retain submission state and owner relevance with unknown health. Infrastructure errors fail the request rather than returning a partial success. Responses whitelist public summary fields and retain target identity plus immutable version for existing history/detail APIs, which continue to authorize their own reads. Duplicate `view` or `limit` query parameters are rejected as ambiguous.

`limit` accepts 1–100 (default 50); `total` counts only authorized matches and `truncated` explicitly reports omitted matches. This remains a bounded top-N API rather than cursor pagination. Personal state, saved definitions, activity signals and manual digest previews are described below. Live daily/weekly Inbox delivery remains unimplemented; Issue #241 stays open.

### Update Feed screen and personal state (second slice)

The Workspace `/updates` screen keeps the six standard views in its URL and links authorized target titles to existing Planning history/evidence panes. Target titles come from the current authorized directory/Planning graph, with `locale` passed from the active UI and included in its cache key. Health, submission freshness, ranking reasons, and personal read status remain separate. Refreshes occur every 15 seconds and on focus; failed refreshes suppress cached rows. Permission denial has a dedicated non-retry state; guests can read authorized reports but cannot mutate personal state and see no mutation controls. Loading, empty, retry, conflict, and narrow-screen states are supported in Japanese and English. Inbox continues to show its existing event timeline.

`PUT /api/planning/update-feed/read-state` accepts `{target, version, read, expectedRevision}` and returns `{read, revision}`. Authentication precedes JSON parsing; the member and Workspace are resolved exclusively from the authenticated session. Only the currently readable latest immutable version may be changed; archived, revoked, moved-scope, and obsolete reports return unavailable. A Planning revision is captured before fresh authentication/directory checks and compared with the loaded graph; the commit checks that same revision, active Workspace membership/version for human callers, Enterprise CONTROL revision when configured, and personal state CAS in one transaction. Service accounts require the Enterprise control guard and omit the nonexistent human membership row. Conditional-only conflicts return 409; mixed/transient transaction failures return a stable retryable 503, while unknown/malformed persistence failures return a stable 502. Conflicts require a refresh before another explicit choice. This does not change canonical report content or Planning revision. Read-state writes do not create events or send notifications.

The existing Planning table stores compact `UPDATE_FEED_READ#<member hash>#<target/version hash>` rows in the owning Workspace partition, containing only schema version, boolean state, and state revision. They are excluded from bounded graph/history prefixes. There is no body copy or scan. At most 100 exact, strongly consistent `GetItem` reads run in groups of ten using existing permissions; missing rows are unread, corrupt rows/errors fail closed. State survives sessions and a new report version starts unread. Old state may remain stored after permission loss, but it is neither returned nor writable until that exact report is currently accessible. Existing Workspace export/deletion can identify the owning partition. No table, IAM, credential, or delivery configuration is changed.

### Saved custom feeds (third slice)

`GET /api/planning/update-feed/saved` loads the current member's personal collection. `PUT` on the same route replaces that collection with `{expectedRevision, feeds}`, supporting create, edit and delete without changing reports or read state. Each definition has a name, standard base view and independent Team, Team-qualified Project, Portfolio, Initiative, health and submission-state filters. Values within a dimension use OR; dimensions and the base view use AND. Empty dimensions impose no restriction. Collections allow at most 20 definitions, 80-character names, 20 values per dimension and 64 KB of serialized definitions. Unknown fields are discarded. Guests cannot write.

Definitions use one compact `UPDATE_FEED_DEFINITIONS#<member hash>` row in the existing Workspace partition and one strongly consistent exact read. A single transaction checks personal revision plus current member/version and Enterprise control guards. Missing authorization guards fail closed; conflicts return 409, known transient failures 503 and malformed persistence 502. Concurrent editing never silently overwrites another device: the screen retains the draft on conflict and requires reopening with fresh state. No graph/history scan, update body copy, new table or IAM change is introduced.

`GET /api/planning/update-feed?feedId=<id>` resolves only the caller's own definition, then reapplies current target and captured-scope authorization before filtering and before the top-N limit. An explicit incompatible base view returns 409; an unknown personal ID returns 404. Saved opaque conditions do not grant access. `GET /api/planning/update-feed/options?locale=en` derives current readable labels from the bounded graph and active directory, without returning report bodies. A Project belongs to a Portfolio filter when a currently readable, active Planning entity in its exact Project scope has that Portfolio as a readable active ancestor; an Initiative uses its own ancestry. No Work Item membership scan is used. Archived or inaccessible hierarchy paths contribute no Portfolio match. Duplicate target projections fail closed.

The editor opens current selector metadata on demand and supports narrow screens, keyboard focus restoration, loading, authorization denial and explicit deletion confirmation. Filter IDs whose targets become unavailable are retained as conditions, without re-exposing their old labels. Each dimension shows only an unavailable-condition count; editing another dimension preserves those conditions, while editing that dimension replaces them.

### Current relevance and compact activity (fourth slice)

Clients opt into expanded reasons with `relevance=2`; missing this parameter preserves the original owner (2) / author (1) reasons, scores and response shape, without signal reads. This keeps older cached Web clients working during deployment; the updated Web requests version 2 and also accepts legacy responses during server rollback. Unsupported or repeated versions return 400. Known watcher failures retain their stable error code and retryable 503 status at the Feed boundary.

The current `for-me` ranking extends the first slice: ownership contributes 8 points, explicit current Project membership 4, a current target watch 3, interaction within 30 days 2, and authorship 1. Workspace/admin visibility alone is not Project membership. Reasons are returned individually and explained in Japanese and English. Multiple matches produce one entry. Attention breaks relevance ties with comment activity (2) and reaction activity (1) within 7 days, then latest publication time and qualified target identity. Attention alone does not add an unrelated target to `for-me`. Other standard views remain chronological; health, submission and read state remain independent.

After current target authorization, the server reads only the caller's exact qualified watch keys, in strongly consistent batches of at most 100, bounded to 2,000 targets and three attempts for unprocessed keys. It never lists other members' watches. Membership uses current explicit Project grants and qualified legacy membership, not general Workspace permissions. Revoked or archived targets do not reach watch lookup. Activity is usable only for an authorized latest summary with matching immutable version and captured scope; future or expired timestamps contribute nothing.

Source comment/reaction additions atomically write one compact `UPDATE_ACTIVITY#<qualified target>` projection alongside the canonical annotation and existing authorization/idempotency conditions. A latest-version/archive condition and independent activity revision CAS prevent stale-version and concurrent annotation races; failed transactions leave neither annotation nor signal behind and return a retryable conflict. The projection stores only timestamps and the 32 most recently active distinct members, never annotation text, reaction values or update bodies. A new version resets its activity window. Reaction removal retains historical interaction, as explained in the UI. This bounded approximation and post-rollout-only collection are explicit: older annotation history is not scanned or backfilled.

The activity prefix is independently bounded to 2,000 rows / 4 MB and 20 pages, with strongly consistent reads, strict schema validation and duplicate rejection. Feed generation performs no writes to `UPDATE`, `UPDATE_TARGET`, annotations or activity. Existing table permissions suffice. Daily/weekly Inbox delivery remains a separate unimplemented slice; Issue #241 stays open.

### Manual digest preview (partial Issue #241)

`GET /api/planning/update-feed/digest` returns the authenticated member's settings and at most twenty bodyless generation receipts. `PUT` accepts `{ expectedRevision, preferences: { enabled, frequency, views } }`; frequency is `daily` or `weekly`, and views is a nonempty union of at most six unique standard Feed views. Settings default to disabled. Enabling this preference enables manual previews only, never a live schedule. Client Workspace/member fields are ignored. Guests cannot change preferences or generate receipts.

`POST /api/planning/update-feed/digest/preview` manually generates the current UTC day or Monday-based UTC week. These are interval identities, not a publication-date filter: the preview contains the selected current unread reports, including older reports still unread. It reads at most 100 candidates per view from the existing bounded read model, deduplicates exact Team-qualified target/version identities, rechecks authorization and personal read state, and returns at most fifty entries with explicit `truncated`. Read entries in a source's top 100 may leave fewer than fifty results; no unbounded refill or history scan is attempted. Missing targets without published content are omitted.

The existing Planning table stores one member-scoped digest metadata row. CAS protects preference updates, a 60-second lease fences competing generators, and each interval permits at most three manual attempts. Expired or failed attempts can be retried by calling preview again. The server owns UTC interval and attempt decisions; the UI displays an exhaustion response until explicit Reload, then permits another explicit request without inferring the current server interval from the device clock. There is no automatic retry loop. Superseded workers cannot complete or release a newer claim. Completion and replay writes guard the Planning authorization revision plus current caller conditions. A changed preference or permission produces a conflict rather than returning a stale preview. Infrastructure failures propagate and leave either a bodyless failure receipt or an expiring lease if cleanup fails.

Completed receipt replay recomputes content under current permissions and read state; no historic summary, title, target identifier, error text, or notification body is retained. Receipt counts describe the original completion and can differ from a later freshly authorized preview. Generating a preview does not mark reports read or mutate canonical updates.

The Updates screen now exposes a keyboard-accessible Digest preview disclosure. It loads settings/history only when opened, supports daily/weekly and standard-view preferences with explicit save, and offers manual generation only after settings are saved. The preview-only label is always visible. Receipt statuses describe preview generation, never delivery. Permission failures remove settings and report content; conflicts offer metadata reload rather than automatic generation. Guests have read-only access.

Preview bodies stay in component-local memory, outside SWR and browser storage. They clear on edits, panel close, session/locale/view/saved-definition/Planning-revision changes, browser focus/visibility changes, or after fifteen seconds. Later previews always request fresh server authorization. Saved custom feeds remain separate from digest standard-view selection. Japanese and English copy, narrow-screen wrapping, keyboard disclosure/actions, conflict recovery and permission loss are covered by UI tests.

The public API and UI still have only the preview transport. Custom saved-feed selection for digests and live Inbox delivery remain unavailable. The following application-only delivery slice is not a production activation. Issue #241 remains open.

### Inbox digest application and scheduler ports (not activated)

`GET/PUT /api/planning/update-feed/digest/inbox` now exposes delivery consent independently of `/digest` manual previews. It uses the same bounded `{ expectedRevision, preferences }` validation and current caller transaction guards; guest writes are denied, defaults are disabled, and no endpoint invokes delivery. The Updates screen loads these settings only when its separate disclosure is opened. Explicit save supports daily/weekly cadence and standard-view selection, conflict reload, permission-loss suppression, Japanese/English labels and narrow screens. The screen explicitly says that automatic delivery is not active; saving consent does not provision or enable a worker. Disabling removes sparse due attributes when persisted by the durable adapter. Production settings composition uses the separate durable collection; test composition uses a distinct isolated collection. No completed delivery receipt can be manufactured through this API.

`deliverInboxDigest` reuses the bounded preview collector, current recipient Feed ACL, final personal read-state checks, target/version deduplication, fifty-entry cap, sixty-second lease and three-attempt interval limit. Its store is a **separate delivery opt-in collection**: wiring the manual preview collection into this port is prohibited. Enabling preview settings must never opt a member into delivery. The authorization port must resolve the current member, `planning.read`, tenant availability and Inbox channel preference, and return recipient-bound transactional guards. Denial suppresses processing; lookup failures propagate.

`DynamoDbInboxDigestStore` implements the atomic port with a single `TransactWriteCommand`: delivery metadata CAS, current caller guards, Planning revision fence (including absent revision-zero META), current Inbox preference version/absence and conditional notification creation. `UPDATE_FEED_INBOX_DIGEST#<member hash>` rows are separate from preview metadata. Completion verifies the current pending token, attempt and unexpired lease; ordinary preference/claim writes cannot manufacture completed receipts. Lost claim responses retain the lease for expiry; lost completion responses recover from the persisted receipt. Replays do not overwrite Inbox read/archive fields. Empty digests complete without an Inbox row. SDK-command-boundary tests evaluate every generated condition before applying either write; no real AWS operation was performed.

The Inbox row mapper uses the existing recipient/key/state format and is tested through `toNotificationItem`. It emits a generic link to `/updates`, with no report body, target ID, report title, summary, count or external delivery channel. Its generic notification title supports Japanese and English, selected by recipient composition; notification TTL is 365 days from its first claim time, retained across retries. Expired pending claims remain due at lease expiry even on the third attempt and are durably marked failed before another interval is selected. Opening the Feed uses current authorization and current content, not a stored digest snapshot.

`createInboxDigestScheduleHandler` accepts an explicit disabled-by-default configuration and a trusted clock. One call inspects at most 100 candidate recipients, deduplicates exact recipient pairs, checks current daily/Monday-week receipts, and returns failed recipients plus an opaque continuation. An orchestrator must persist both retry candidates and continuation before acknowledging an event. The durable adapter defines (but does not provision) `InboxDigestDueIndex`: string partition `inboxDigestShard` across sixteen `inbox-digest#0..15` shards and numeric epoch-millisecond sort key `inboxDigestDueAt`, projecting the Planning primary keys. Disabled settings remove index attributes; claims schedule lease expiry, failed attempts wait sixty seconds, completed/exhausted intervals advance to the next UTC day/Monday. `listDue` inspects at most 100 index rows, returns `LastEvaluatedKey`, strongly rereads each metadata row, excludes stale/not-due/disabled candidates and rejects corrupt metadata. The caller must persist per-shard continuation, rotate fairly across shards and resolve current recipient authorization; the GSI is a candidate hint, never an ACL source. No deployed candidate index, durable checkpoint/retry orchestrator, production recipient authorization resolver/worker composition or EventBridge target is installed. No canonical update/history scan is added.

Candidate discovery binds both the original scheduling time and frequency before authorization or a claim can fail. If current consent has a different frequency, the old logical attempt is acknowledged as cancelled without generating a receipt or notification; fresh discovery may then start the new cadence using its current time. Historical attempts lacking their original frequency are also cancelled rather than inferring a backdated cadence. The interval key, actual lease clock and first successful claim timestamp are separate concepts.

Continuation is a continuous discovery cursor, not a fixed-time run: each new page discovers recipients under its current clock and consent. Already identified retries carry their original time and frequency separately; freezing all later pages would incorrectly backdate newly discovered work. A tracked candidate encountering a live claim remains retryable even at exactly the same clock value after a lost claim acknowledgment. Receipt retention is ordered by logical date, with cadence as a tie breaker. Once twenty receipts fill the retained window, its oldest logical key is a durable lower boundary: earlier absent intervals are cancelled before claiming or evicting anything. Normal settings writes preserve history, and accepted generation/pruning never moves that boundary backward. This protects both empty and nonempty completed intervals after their individual receipts have been pruned.

Production activation requires separate infrastructure approval. The existing `NotificationScheduleFunction` has no Notifications table binding or Inbox-write grant. The implemented adapter requires `dynamodb:GetItem`/`PutItem`/`ConditionCheckItem` on Notifications (channel preference guard and deterministic insert); `GetItem`/`PutItem`/`ConditionCheckItem` on Planning (delivery state/CAS/fence); `ConditionCheckItem` on WorkspaceAccess and EnterpriseIdentity (caller guards); and `Query` on `${planningTableArn}/index/InboxDigestDueIndex`. The new GSI must use the schema above and project both primary keys. Recipient authorization/Feed composition additionally needs only its actual `GetItem`/`Query`/`BatchGetItem` reads on WorkspaceAccess, EnterpriseIdentity, TenantAdministration, ProjectDirectory, Planning and Collaboration; final extraction determines that separate read policy. Transaction writes require the relevant underlying item permissions with least-privilege key conditions. No wildcard scan grant is needed. EventBridge activation, bindings, checkpoint/DLQ behavior and deployment must be reviewed separately. This slice changes no IAM, credentials, infrastructure or running schedule and sends no real notifications.

Health update の target は Project と Initiative の union です。Project は Planning entity ではないため `{teamId, projectId}` で Team-qualified に識別し、Initiative は `{entityId}` で識別します。Target ごとに update owner、週次または月次 cadence、IANA time zone、次回期限、事前 reminder、任意の期限後 escalation を設定できます。月次 cadence は設定時の local day を anchor とし、1月31日から2月末へ clamp した後も3月31日に戻します。週次 cadence は local wall-clock を維持して DST をまたぎます。

報告された health (`unknown` / `on-track` / `at-risk` / `off-track`) と提出状況 (`not-configured` / `missing` / `current` / `stale` / `overdue`) は別の値です。Cadence 未設定は `not-configured`、初回提出前かつ期限前は `missing`、reminder window 前に提出済みなら `current`、提出済みでも次の reminder window に入れば `stale`、次回期限に達すれば `overdue` とします。List、Timeline、Portfolio、Dashboard、詳細 pane は両者を別の badge / column で表示します。

Publish は人が作成した manual draft のみを正本とし、summary、health、risk、risk summary、decision、help needed、next action、evidence を保存します。Progress、scope、target date、Milestone、dependency は publish 時の canonical Planning / Work Item state から server が snapshot を生成し、直前 version との差分も server が固定します。Project の progress snapshot は Planning link の有無に依存せず、同じ `{teamId, projectId}` に属する canonical Work Item 全体から算出します。Team / Project scope の update は target と同じ visibility envelope 内の entity、Milestone、dependency、Work Item だけを snapshot / evidence に含め、scope 外 ID の固定や後続の history read による漏洩を防ぎます。現在公開できる typed evidence は Work Item、Planning entity、File、HTTPS link です。Decision evidence は canonical visibility adapter が提供されるまで公開契約と composer から除外します。File evidence は canonical File ID reverse lookup で scope と可視性を検証し、credential を含まない HTTPS permalink も必須とします。公開済み version を update / delete する API は提供しません。Comment は別の append-only row、reaction は member ごとの別 row として保存し、親 update の存在を同じ transaction で条件検証するため update 本体の不変性を崩しません。

History は target ごとに新しい順の cursor API で読み、JSON export は同じ認可と履歴正本を使います。Watch は collaboration scope を Team-qualified な Project / Initiative target へ拡張し、legacy の非修飾 Project watch から Planning 通知を fan-out しません。Cadence が有効な `UPDATE_TARGET` だけを16 shardの sparse `UpdateScheduleDueIndex`へ投影し、最初の reminder（未設定なら due）時刻までの targetをQueryするため、schedule実行時も全Planning履歴をscanしません。Notification schedule は reminder、overdue、escalation を `{workspace,target,nextDueAt,kind,recipient}` から決まる event ID で一度だけ生成します。GSI は候補発見だけに使い、base rowの強整合read、audit projection、Inbox read の各段階で current target、owner、cadence occurrence、archive、Project / Initiative scope、recipient 権限を再検証します。Owner / cadence / scope の変更、archive、permission loss 後は、すでに保存された古い通知も表示しません。

主な HTTP endpoint は次の通りです。

- `PUT /api/planning/updates/cadence`: cadence の設定または解除
- `POST /api/planning/updates`: manual structured update の publish
- `GET /api/planning/updates`: cursor-paginated immutable history
- `GET /api/planning/updates/export`: versioned JSON export
- `GET|PUT|DELETE /api/planning/update-watch`: current member の watch state
- `GET|POST /api/planning/updates/:updateVersion/comments`: append-only comments
- `GET|PUT|DELETE /api/planning/updates/:updateVersion/reactions`: member reactions

Comment / reaction mutation は caller ごとの durable `Idempotency-Key` を必須とします。Annotation row と成功 receipt を同じ transaction で確定し、lost response の retry は元の `201` / `204` を再現します。同じ key を別 payload に再利用した場合は `409` で拒否します。

## Timeline と critical path

Dependency は predecessor / successor の directed edge で、self edge、重複 edge、循環を拒否する。Scheduling type は `finish-to-start`、`start-to-start`、`finish-to-finish`、`start-to-finish` の4種である。`lagDays` は signed calendar day とし、正数を lag、負数を lead として扱う。必要な場合は successor の `start` または `finish` に `on`、`not-before`、`not-after` の明示 constraint を設定できる。

Planning entity の critical path は dependency に参加する archive されていない entity の forecast（無い場合は baseline）の inclusive calendar day 数、dependency、lead / lag から DAG の最長経路を算出する。Dependency に参加しない長期 Portfolio 等が scheduling path を隠すことはない。Timeline 上の日付や dependency の変更後は、mutation response に再計算した critical path を含める。

## Work Item schedule dependency

Work Item の意味上の relation と日程を動かす dependency は別の正本を持つ。`parent` / `child`、`duplicate`、`related`、`blocks` / `blockedBy` は WorkItemConfigurationTable の Team-scoped Relation Graph が所有し、意味 relation だけでは schedule を変更しない。日程 dependency は PlanningTable が Workspace scope で所有し、両端を `{teamId, workItemId}` で識別するため、権限のある Team / Project をまたいで作成できる。

Planning snapshot は参照可能な両 endpoint が揃う edge だけを返し、同じ `workItemDependencies` と派生 summary を Table、Board、詳細 pane、Gantt、management surface が利用する。派生 summary には Work Item critical path、constraint conflict、未解決 blocker 件数、影響する Project / Milestone を含める。影響 Project は Team-qualified な `affectedProjects: {teamId, projectId}[]` だけを返し、片側だけを参照できる user へ相手 endpoint、edge、件数を漏らさない。

Dependency の作成・更新・削除は両 endpoint の manager 権限と Planning global revision を検証する。Qualified endpoint の self edge、同じ向きの重複 edge、transitive cycle、不正な lead / lag、実在しない Work Item、矛盾する constraint は commit 前に stable error code で拒否する。Work Item を削除する場合は先に incoming / outgoing dependency を解除し、dangling edge を残さない。

Schedule の move / resize / replace は、現在の Work Item revisions と Planning revision に対して downstream DAG を topological order で評価する。Preview は direct / propagated impact ごとの before / after、signed date delta、起点 dependency、conflict、影響 Project / Milestone を返す。`unscheduled` や必要な anchor を持たない `due-date` を暗黙の期間 task に補完せず、解決不能な edge は conflict として返す。評価対象は起点を含めて24件までに制限し、保存は preview 後の明示 confirm を必須とする。Confirm 時は graph と全対象 revision を再検証し、全日程を単一 transaction で更新する。Semantic `blocks` relation は preview の注意情報にはなっても propagated date update を生成しない。Automation や通常の単一 Work Item 更新は dependency を持つ日程を迂回せず、対話的な preview / confirm を要求する。

## 権限

- active Workspace member: Planning snapshot の参照
- Project / Team member: Work Item link と status update
- Project / Team viewer: scoped versioned update history、export、watch の参照と操作
- Project / Team member: scoped update への comment、reaction の操作
- Configured update owner または Project / Team manager: manual structured update の publish
- Project / Team manager: scoped entity、Work Item schedule dependency、Cycle rollover、archive / duplicate / move
- Workspace owner / admin: Workspace scope の Portfolio / Roadmap 等の管理
- guest: mutation 不可

Move、dependency、link では起点と終点の両方を検証します。Move は対象 entity と active な全子孫の Team / Project scope を一つの transaction で変更し、archive 済み子孫は履歴上の scope を保持します。Project / Team member は、アクセス可能な Work Item を Workspace scope の戦略 Goal / OKR に link できます。Workspace scope の status update と構造変更は owner / admin に限定します。Entity owner は active Workspace member に限り、member の無効化前に所有 entity を移譲または archive する必要があります。Active entity または保存済み Work Item link が参照する Team / Project の archive は、entity を移動または archive し、link を解除するまで拒否します。権限確認に失敗した場合、Planning store の mutation は呼び出しません。
