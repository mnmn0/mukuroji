# Planning domain

Issue #27 の Planning domain は、短期の Cycle と中長期の Portfolio / Roadmap / Initiative / Goal、Project phase / Milestone / Release を一つの Workspace graph として扱います。Canonical Work Item 自体に計画フィールドを重複保存せず、Planning table の link row を正本にします。

## 永続化と並行更新

`PlanningTable` は `workspaceId` / `recordKey` を primary key とし、次の row を保存します。

- `META`: planning schema version と Workspace graph revision
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

Planning API snapshot は `schemaVersion: 2` を返す。ローリングデプロイ中の新しい Web は v1 snapshot に不足する Work Item dependency 情報を空の既定値で補い、v2へ正規化する。DynamoDB の storage schema version 1 は API contract から独立しています。Revision の正本は移行前の `META` から、移行後の `FENCE#<workspaceId>` partition にある `META` へ移されます。読み取り時の移行は legacy row の revision を条件検証しながら FENCE row を作成または更新し、同じ transaction で legacy row を削除します。FENCE writer は legacy row が存在しないことを同じ transaction で確認するため、旧 writer と新 writer の revision CAS が同時に成立しないようにします。

### Revision fence の移行手順

FENCE-only writer を有効にする前に、旧 `META` writer を停止し、実行中の旧 Lambda invocation が排出されるまで待機します。次に、現行版を migration barrier 有効状態でデプロイし、Planning の read / mutation を通じて各 Workspace の legacy `META` を条件付きで FENCE row へ移します。legacy row が残っている間は FENCE mutation が `PLANNING_REVISION_FENCE_BARRIER_REQUIRED` で fail-closed になるため、旧 writer と新 writer の混在を許可しません。

移行監視では、対象 Workspace の legacy `META` がなくなり、FENCE `META` の revision が移行前の revision 以上であることを確認してから通常運用へ進めます。rollback で旧 writer を再開する場合も、実行中の FENCE writer を先に排出し、FENCE と legacy の両方を扱う互換版を経由します。現行版から旧 `META` writer へ直接戻すと、異なる revision fence を並行して更新するため許可しません。

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

Planning snapshot は参照可能な両 endpoint が揃う edge だけを返し、同じ `workItemDependencies` と派生 summary を Table、Board、詳細 pane、Gantt、management surface が利用する。派生 summary には Work Item critical path、constraint conflict、未解決 blocker 件数、影響する Project / Milestone を含める。影響Projectの正規表現は Team-qualified な `affectedProjects: {teamId, projectId}[]` とし、移行期間だけ unqualified な `affectedProjectIds` も返す。片側だけを参照できる user へ相手 endpoint、edge、件数を漏らさない。

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
