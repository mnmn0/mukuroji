# Canonical Work Item

## 目的

Mukuroji の task / issue は、`WorkItemsTable` を正本とする Team-owned Work Item に統合する。
canonical Work Item は Workspace / Team の Work Item configuration で定義された workflow と custom field を必ず使用する。

```text
PK directoryTeamId = <workspaceId>#team#<teamId>
SK issueId          = <workItemId>
entityId            = team/<teamId>/issue/<workItemId>
```

API/UI contract は `@mukuroji/contracts` の `WorkItem`、`CreateWorkItemInput`、`WorkItemPatch`、`UpdateWorkItemInput` を共有し、server と Web に同じ DTO を再定義しない。

## Schema v2

Canonical row は次の field を持つ。

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Work Item contract の schema version。現在は `2`。 |
| `revision` | yes | 作成時 `1`。state update が成功するたびに `1` 増える。 |
| `directoryId` | yes | Workspace ID。 |
| `directoryTeamId` | yes | Primary partition key。 |
| `teamId` | yes | Work Item を所有する Team。 |
| `issueId` | yes | Physical sort key と公開 `id`。 |
| `assignedProjectId` / `directoryProjectId` | no | 遂行先 project と project GSI key。未割当 Work Item では持たない。 |
| `title` | yes | Literal title。canonical row は `titleKey` を持たない。 |
| `description` | no | 詳細説明。 |
| `assigneeUserId` | yes | 最終責任者（accountable owner）である Workspace member の安定 ID。Work Item ごとに 1 人だけ。 |
| `contributorAssignments` | no | 作業を分担する Contributor の配列。空の場合は属性を持たない。詳細は「責任者と Contributor」を参照。 |
| `creatorMemberKey` | yes | Work Item を作成した Workspace member key。 |
| `sourceTriageEntryId` | no | Team Triage から作成された場合の source Entry ID。 |
| `sourceRequestId` | no | Form source から作成された場合の Request submission ID。 |
| `workflowSchemaVersion` | yes | 値を検証した Work Item configuration schema version。現在は `1`。 |
| `workflowStatusId` | yes | 解決済み workflow の status ID。 |
| `statusCategory` | yes | status 定義から確定した `backlog`、`unstarted`、`started`、`completed`、`canceled` のいずれか。 |
| `customFieldValues` | yes | configuration に対して検証済みの field ID / value map。値がなくても `{}` を保存する。 |
| `relationIds` | yes | Relation Graph から導出した `type:targetWorkItemId` の辞書順・重複なし配列。最大100件で、relation がなくても `[]` を保存する。 |
| `priority` | yes | `low`、`medium`、`high`。 |
| `priorityUpdatedAt` | no | `priority` の値が最後に変わった UTC ISO 8601 timestamp。新規 row は `createdAt` と同時に設定する。 |
| `schedule` | yes | 日付の意味、予定工数、timezone、稼働曜日、祝日を固定する canonical schedule。 |
| `dueDate` | yes | `schedule` から導出する projection。`unscheduled` では空文字、それ以外は `YYYY-MM-DD`。 |
| `dueDateUpdatedAt` | no | 導出済み `dueDate` の値が最後に変わった UTC ISO 8601 timestamp。新規 row は `createdAt` と同時に設定する。 |
| `sortOrder` | yes | Team/project list の安定表示順。 |
| `createdAt` / `updatedAt` | yes | UTC ISO 8601 timestamp。 |

Canonical row と API response は旧固定 `status`、`titleKey`、`assignee`、`assigneeKey` を持たない。API response は上記に `id` と `source=dynamodb` を加える。

Strict reader は必須 workflow field がない row、未知の schema version、型が不正な status/custom field、不正または欠落した `relationIds`、不正な `schedule`、`dueDate` と schedule の不一致を canonical Work Item として返さない。field-specific timestamp がある場合は canonical UTC で `createdAt` 以上 `updatedAt` 以下であることも検証する。現在の configuration との整合は configuration 更新時の usage 検証と mutation 時の再検証で保証し、read 時に configuration は取得しない。

Schema v1 row の read-time upcast や自動補完は行わない。未知の version と v2 の必須 field を欠く row は fail-closed とする。field-specific timestamp 導入前の v2 row は互換のため保持し、内部 canonical response は `createdAt` を保守的な occurrence fallback として返す。汎用 `updatedAt` は priority や期限の発生時刻として代用しない。

### Schedule state

Create は完全な `schedule` を必須とし、update は完全な `schedule` の置換だけを受け付ける。`dueDate` は request input として受け付けず、server が schedule から導出する。`schedule` は次の4状態を明示し、欠落日付から別の状態を推測しない。

日付範囲と working-day duration の計算は、入力だけで過大な反復処理を起こさないよう最大 36,600 calendar days（約100年）の planning horizon に制限する。

| `mode` | Dates and duration | `dueDate` projection |
| --- | --- | --- |
| `unscheduled` | 日付と duration を持たない。 | `""` |
| `due-date` | `dueDate` だけを持つ。 | schedule の `dueDate` |
| `date-range` | 両端含む `startDate` / `endDate` と正の `durationDays`。 | schedule の `endDate` |
| `milestone` | 同一の `startDate` / `endDate` と `durationDays=0`。 | schedule の `endDate` |

Interactive な schedule 操作は、保存前に server preview を取得する。PlanningTable の canonical Work Item dependency が downstream にある場合、preview は各 Work Item の revision-bound before / after と signed date delta を返す。保存には preview の Planning revision を含む明示 confirm が必要で、server は graph と対象 Work Item revisions を再読して impact を再計算する。Constraint conflict、cycle、権限不足、stale revision がある場合は cascade 全体を拒否する。

Work Item Relation Graph の `blocks` / `blockedBy` は意味上の blocker であり、単独では schedule を変更しない。自動 reschedule が必要な関係は PlanningTable の qualified Work Item schedule dependency として別に作成する。

日付は `1000-01-01` から `9999-12-31` までの実在する `YYYY-MM-DD` に正規化する。`date-range.durationDays` は開始・終了を含む範囲で `calendarPolicy.workingWeekdays` に属し、`calendarPolicy.holidays` に含まれない日の数と完全に一致させる。`calendarPolicy.timeZone` は IANA timezone、稼働曜日は1件以上7件以下、祝日は重複のない local calendar date として最大512件まで保存する。通知と Web の due/overdue 判定は、現在時刻をこの time zone の local calendar date へ変換して同じ期限境界を使用する。`plannedEffortMinutes` は任意の非負の整数（分）であり、calendar duration とは別に扱う。

Relation の正本は `WorkItemConfigurationTable` の Relation Graph row であり、Work Item row の `relationIds` は検索と backfill のための派生 projection である。Relation の作成・削除 transaction は、graph metadata と reciprocal row に加えて source / target 両方の `relationIds` を同時に更新する。この projection 更新では Work Item の `revision` と `updatedAt` を進めない。

## Configuration と mutation

Work Item configuration は Workspace default、Team override、built-in default の順で解決する。作成時に `workflowStatusId` を省略した場合は、解決済み workflow の `initialStatusId` を使用する。指定した status ID と custom field value は同じ解決済み configuration に対して検証する。

更新では `workflowStatusId` を patch し、server が status 定義から `statusCategory` を再計算する。Client が category を直接指定することはできない。priority と schedule は値が実際に変わった場合だけ対応する field-specific timestamp を進め、title や description など無関係な変更では保持する。dependency-aware schedule cascade も各 Work Item の導出済み `dueDate` が変わった行だけ `dueDateUpdatedAt` を進める。

```json
{
  "workflowStatusId": "approval-complete",
  "expectedRevision": 7
}
```

Work Item update は `expectedRevision` を必須にする。State update、activity event、audit event は同じ DynamoDB transaction で確定し、state condition は読み込み時の revision と一致する場合だけ成功する。成功 response は `revision=8` を返す。競合を timestamp や last-write-wins で隠さない。

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `InvalidWorkItemRevision` | `expectedRevision` が正の整数でない。 |
| `404` | `TeamIssueNotFound` | 対象 row が削除済み、または存在しない。 |
| `409` | `WorkItemRevisionConflict` | 読み込み後に別 mutation が revision を進めた。 |
| `503` | `InvalidTeamIssue` | Canonical table の row が strict schema を満たさない。 |

Web は list/detail response の revision を mutation body に含める。`WorkItemRevisionConflict` では optimistic state を戻して再取得し、新しい revision で明示的に再試行する。

## 責任者と Contributor

`assigneeUserId` は Work Item の最終責任者で、常に 1 人である。複数人で作業する場合も責任者を複数にせず、作業の分担は `contributorAssignments` に分けて保存する（#239）。

各 Contributor は次の値を持つ。

| Field | Required | Description |
| --- | --- | --- |
| `assignmentId` | yes | Work Item 内で安定する 32 桁 hex ID。server が採番する。 |
| `memberUserId` | no | 担当メンバーの Workspace user ID。未定なら持たない。 |
| `jobRoleId` | no | Work Item configuration の `jobRoles` の stable ID。 |
| `plannedEffortMinutes` | no | 予定工数（分）。0 以上 60,000 以下の整数。 |
| `status` | yes | `planned`、`in-progress`、`done`。 |

- `memberUserId` と `jobRoleId` の少なくとも一方が必要である。ロールだけの Contributor は、担当者が未定の段階の計画に使う。
- 同じメンバーは 1 つの Work Item に 1 回だけ設定できる。Contributor は最大 20 件。
- 更新では `contributorAssignments` に完全な置換リストを送る。既存の Contributor は `assignmentId` を付けて残し、新規の Contributor は `assignmentId` を省略する。存在しない `assignmentId` は拒否する。フィールドを省略した更新は保存済みの Contributor を変更しない。
- 新しく追加するメンバーは active な non-guest member でなければならない。検証時に読んだ member row の version・status・role を Work Item 書き込みと同じ transaction の `ConditionCheck` で固定するため、検証後 commit 前に無効化されたメンバーは保存せず `409 WorkItemAuthorizationChanged` を返す。追加後に無効化されたメンバーは、元の `assignmentId` を付けて送れば他の変更をしても残せる。`assignmentId` を省略して同じメンバーを送り直した場合や、既存の `assignmentId` に別のメンバーを設定した場合は新しい割り当てとして再検証する。再割り当ては別の flow で扱う。
- archive 済みのジョブロールは既存の Contributor に残せるが、新しく設定できない。
- Contributor の変更は `work-item.updated` audit event の `contributorAssignments` field change として記録する。
- Public API は `contributorAssignments` を受け付けず、返さない。
- ジョブロールは archive で廃止する。名称変更と archive は Contributor が参照中でも保存でき、保存済み Contributor は `id` で参照するため影響を受けない。Contributor が参照しているジョブロールを設定から削除する保存は `409 WorkItemConfigurationInUse` で拒否する。Contributor を変更する作成・更新は、ジョブロールの検証に使った configuration revision と `CONFIG_WRITE_LOCK` を同じ transaction で guard するため、設定保存の usage 検証と並行して削除予定のジョブロールを割り当てることはできない（[Work Item configuration](./work-item-configuration.md) の lock 手順を参照）。
- 保存済み contributor の member ID は trim・小文字化済み・256 文字以内・制御文字なし、ジョブロール ID は設定 ID の文法に従う必要があり、外れた row は読み取り時に失敗する。
- contributor を変更する更新で `expectedRevision` が古い場合は、assignment ID の検証より先に `409 WorkItemRevisionConflict` を返す。

個人向けの画面では、責任者の仕事と参加している仕事を分けて扱う。

- Focus は [Focus queue の「責任者と参加」](./focus.md#責任者と参加) のとおり `involvement` で区別する。
- My Tasks は、利用者が責任者の Work Item に加えて、`contributorAssignments` に member として入っている Work Item を表示する。後者のカードにだけ「参加」の badge を付け、担当者の表示はこれまでどおり責任者を示す。対象の判定は Focus と同じで、責任者が Contributor の一覧にも入っている場合は責任者として扱い、自分の分担が `done` の Contributor は進行中の Work Item から外れ、完了・キャンセル済みの Work Item には残る。ロールだけの分担はどの利用者の My Tasks にも入らない。判定は Web が取得済みの Work Item から行い、状態の移動などの操作可否はこれまでどおり Work Item の書き込み権限で決まる。

まだ実装していない範囲は次のとおり。

- workload / capacity への planned effort の集計
- automation、template、bulk action からの設定
- member 無効化や Team 移動時の再割り当て
- 通知の分離
- Work Item の CSV export / import（Contributor は出力・取り込みしない）

## Read model

- Team list/detail と project list は同じ canonical store を読む。
- `GET /api/work-items` は現在ユーザーが閲覧できる active Team の canonical Work Item を集約し、project 未割当も返す。詳細は次の「Workspace 横断の読み取り」を参照する。
- board、calendar、gantt、Workspace Home、My Tasks、Inbox、reports は canonical response と解決済み configuration を共有する。
- `/api/teams/{teamId}/issues` と `/api/projects/{projectId}/issues` は canonical store を参照する API alias である。
- 新規 Workspace と demo seed は最初から strict canonical schema の Work Item だけを作成する。

## Workspace 横断の読み取り

閲覧できる Work Item が数千件、Team が数十あっても Home、Dashboard、My Tasks、Focus、Planning、Project 一覧が開けるように、Workspace 横断の読み取りは次の 3 種類に分けている。

| 読み取り | 用途 | 上限（超えると `413 WorkItemListLimitExceeded`） |
| --- | --- | --- |
| `GET /api/work-items?limit=…&cursor=…` | 画面に必要な範囲だけを読む（My Tasks、Team 概要、Team メンバー） | 1 page 最大 200 件。page 数の上限なし |
| `GET /api/work-items/summary` | 件数と進捗だけを使う画面（Home、Dashboard、Project 一覧） | 評価 20,000 件、Team 100 |
| server 内部の全件読み取り | Focus、Planning snapshot、AI assistance | 保持 10,000 件、Team 100 |

どの読み取りも Team partition を最大 8 並列、1 回 500 件ずつ base table の強整合 Query で最後まで読む。以前の「全体 200 件、Team 20、partition あたり 1,000 件」の上限は、`limit` も `cursor` も付けない旧来の `GET /api/work-items` の 200 件だけを残している。

### `GET /api/work-items` の page と filter

- `limit`（1〜200、既定 100）または `cursor` を付けると `{ workItems, nextCursor? }` を返す。`nextCursor` が無くなるまで同じ filter で読み続ける。
- 1 request が評価する row は 2,000 件まで（archive 済みなど filter で落ちる row も数える）なので、絞り込みが強いと `workItems` が `limit` 未満（0 件もある）でも `nextCursor` が付く。件数が少ないことを終端と見なさない。
- 順序は Team ID、次に Work Item ID。cursor は filter と `includeArchived` に結び付いており、別の filter で使うと `400 InvalidWorkItemPageCursor` になる。
- filter はどれも閲覧できる範囲を狭めるだけで広げない。
  - `involvement=mine`: 責任者（`assigneeUserId`）または Contributor が自分の Work Item
  - `teamId`: その Team の partition だけを読む
  - `projectId`: その Project に割り当てた Work Item
  - `statusCategory`: 繰り返し指定またはカンマ区切り（`backlog` / `unstarted` / `started` / `completed` / `canceled`）
  - `open=true`: completed と canceled を除く
- 不正な値は `400 InvalidWorkItemListQuery` / `InvalidWorkItemPageLimit`。

### `GET /api/work-items/summary`

Team と Project ごとの bucket（Project 未割当は `projectId` なし）に `total`、`open`、`completed`、`highPriorityOpen`、`overdueOpen`、`attentionOpen`、`inReview`、`assignees` を返し、`totals` に全体の `total` / `open` / `completed` を返す。archive 済みは数えない。期限切れは各 Work Item の schedule の timezone で今日より前の期限を指す。Work Item 本体は返さないので response は Work Item 数に比例して大きくならない。

### 既存の `{ workItems }` client の移行手順

`limit` も `cursor` も付けない request は互換のために残しているが、閲覧できる Work Item が 200 件を超えると `413` になる。移行は次の順で行う。

1. 件数や進捗だけを使っているなら `GET /api/work-items/summary` に置き換える。
2. 一覧が必要なら、画面の範囲に合う filter（`involvement=mine`、`teamId` など）を付ける。
3. `limit=200` を付け、`nextCursor` が返る間は `cursor=<nextCursor>` を付けて同じ filter で読み続ける。response の `workItems` を連結したものが従来の `workItems` に当たる。
4. `413 WorkItemListLimitExceeded` は「範囲を絞る必要がある」という意味なので、generic error ではなく原因を表示する。Web は `tasks.error.limitExceeded` を表示し、API の message を「原因」として併記する。

Web の `loadWorkspaceWorkItems(accessToken, includeArchived, filter)`（`web/src/issues/queries/workspaceWorkItemLoader.ts`）は 3 の手順を実装しており、集めた Work Item が 10,000 件を超えると同じ `413` 相当の error にする。絞り込みが強いと空の page が続くので、page 数では打ち切らない（一度返った `nextCursor` がまた返る、または 500 page を超えたときだけ読み取り停止の error にする）。

## Team / Project の一覧

`GET /api/teams/{teamId}/issues` と `GET /api/projects/{projectId}/issues` も 1 response の件数に上限がある。

- `limit`（1〜200、既定 100）または `cursor` を付けると、Team は `{ teamId, issues, nextCursor? }`、Project は `{ projectId, issues, canReadCustomerImpact, nextCursor? }` を返す。`nextCursor` が無くなるまで同じ条件で読み続ける。
- 順序は並び順の GSI（Team は `TeamIssueSortOrderIndex`、Project は `AssignedProjectIssueIndex`）の `sortOrder`。cursor が指す位置は「page が返した最後の Work Item の直後」か「ある `sortOrder` 以下をすべて評価し終えた境界」のどちらかで、返していない Work Item（archive 済み・別 type・閲覧できない Project のもの）の ID は cursor に入らない。server は呼び出し元の directory で GSI の key を組み立て直し、cursor に directory や DynamoDB の key は入らない。
- DynamoDB は 1 回の Query で最大 500 row を読み、1 row ずつ評価する。page が埋まった時点で返した Work Item の直後から再開するので、除外される row が続いても Query は数回で済む。
- cursor は Team / Project の ID、`includeArchived`、`workItemTypeId` に結び付いており、別の一覧や条件で使うと `400 InvalidWorkItemPageCursor` になる。Team の一覧では別 Team の Work Item を指す cursor も拒否する。
- 1 request が評価する row は 2,000 件まで。archive 済み・別 type・閲覧できない Project の Work Item は評価後に除くので、`issues` が `limit` 未満（0 件もある）でも `nextCursor` が付くことがある。2,000 件のうち 100 件は同じ `sortOrder` の読み切り用に取っておき、通常の評価は 1,900 件で止める。1,900 件目が返さない Work Item だった場合は、同じ `sortOrder` の row を残りの 100 件の範囲で読み終えてから境界の cursor を返し、読み終えられなければ `503 WorkItemListReadStalled` にする。Query の `Limit` は残りの評価予算を超えないので、DynamoDB が 1 request で評価する row は常に 2,000 件以下。
- page をまたいで読む間に並び順を変えると、同じ Work Item が 2 回返る・1 回も返らないことがある。Web は Team ID と Work Item ID で重複を 1 件にまとめ（上限の 10,000 件も重複を除いて数える）、変更後に一覧を読み直す。
- `limit` も `cursor` も付けない旧来の request は互換のために残しているが、閲覧できる Work Item が 1,000 件を超えると `413 WorkItemListLimitExceeded` になる。移行手順は `GET /api/work-items` と同じく、`limit=200` を付けて `nextCursor` を追う。

Web の `loadTeamIssues` / `loadProjectIssues`（`web/src/issues/queries/scopedWorkItemLoader.ts`）は `limit=200` で cursor を最後まで追い、`loadWorkspaceWorkItems` と同じく 10,000 件を超えると `413`、cursor が進まないと `503 WorkItemListReadStalled` 相当の error にする。Team / Project 画面はこの 2 つを原因付きで表示する（`tasks.error.scopeLimitExceeded` / `tasks.error.readStalled` と `tasks.error.reason`）。

### 大きな一覧の表示

読み込んだ Work Item は検索・絞り込み・並び替え・件数表示のすべてに使い、描画だけを段階的に行う。

- テーブル（Team / Project）と期限順リストは最初の 200 行、ボードは列ごとに最初の 50 枚を描画し、「さらに N 件を表示（未表示 M 件）」で同じ件数ずつ追加する。
- 詳細を開いている Work Item と、Team のテーブル・ボードでキーボード focus がある行・カードは、段階表示の範囲外でも描画する。
- 期限順リストの依存関係の線は、描画済みの行の間だけに引く。
- 期限カレンダーは日付ごとに表示するので段階表示しない。
- 2,000 件の Team / Project で、本番 build の初回表示とボード・期限順・期限カレンダー・テーブルの切り替えはそれぞれ約 2 秒以内（`web/e2e/tasks.spec.ts` の Issue #458 の test で、cursor の読み切りと段階表示を確認している）。

### まだ残している上限

- Web の Team / Project 画面は、表示に使う範囲（期限カレンダーの月、期限順の期間など）ではなく一覧全体を cursor で読み切る。1 一覧 10,000 件を超えると読み込めない。期間で絞って読む API は無い。
- Planning publish は 20 Team と partition あたり 1,000 件、Task view の relation 解決は 20 Team の上限のまま。
- Work Item 作成は ID と `sortOrder` を決めるために Team partition 全件を読む。

## 運用

開発中の schema は既存 row を自動変換しない。Schema を更新した環境は保持済みの開発データを削除し、現行 application/CDK の seed または API で strict schema v2 row を作り直す。Seed には `creatorMemberKey`、`workflowSchemaVersion`、`workflowStatusId`、`statusCategory`、`customFieldValues`、空の `relationIds`、正しい `schedule`、および schedule から導出した `dueDate` が必要である。

Production data を保持する必要が生じた後の schema migration は、対象 version と移行仕様を定めた別の変更として設計・検証する。
