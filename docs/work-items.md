# Canonical Work Item

## 目的

Mukuroji の task / issue は、`TeamIssuesTable` を正本とする Team-owned Work Item に統合する。
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
| `assigneeUserId` | yes | Workspace member の安定 ID。 |
| `creatorMemberKey` | yes | Work Item を作成した Workspace member key。 |
| `sourceTriageEntryId` | no | Team Triage から作成された場合の source Entry ID。 |
| `sourceRequestId` | no | Form source から作成された場合の Request submission ID。 |
| `workflowSchemaVersion` | yes | 値を検証した Work Item configuration schema version。現在は `1`。 |
| `workflowStatusId` | yes | 解決済み workflow の status ID。 |
| `statusCategory` | yes | status 定義から確定した `backlog`、`unstarted`、`started`、`completed`、`canceled` のいずれか。 |
| `customFieldValues` | yes | configuration に対して検証済みの field ID / value map。値がなくても `{}` を保存する。 |
| `relationIds` | yes | Relation Graph から導出した `type:targetWorkItemId` の辞書順・重複なし配列。最大100件で、relation がなくても `[]` を保存する。 |
| `priority` | yes | `low`、`medium`、`high`。 |
| `schedule` | yes | 日付の意味、予定工数、timezone、稼働曜日、祝日を固定する canonical schedule。 |
| `dueDate` | yes | `schedule` から導出する projection。`unscheduled` では空文字、それ以外は `YYYY-MM-DD`。 |
| `sortOrder` | yes | Team/project list の安定表示順。 |
| `createdAt` / `updatedAt` | yes | UTC ISO 8601 timestamp。 |

Canonical row と API response は旧固定 `status`、`titleKey`、`assignee`、`assigneeKey` を持たない。API response は上記に `id` と `source=dynamodb` を加える。

Strict reader は必須 workflow field がない row、未知の schema version、型が不正な status/custom field、不正または欠落した `relationIds`、不正な `schedule`、`dueDate` と schedule の不一致を canonical Work Item として返さない。現在の configuration との整合は configuration 更新時の usage 検証と mutation 時の再検証で保証し、read 時に configuration は取得しない。

Schema v1 row の read-time upcast や自動補完は行わない。未知の version と v2 の必須 field を欠く row は fail-closed とする。

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

更新では `workflowStatusId` を patch し、server が status 定義から `statusCategory` を再計算する。Client が category を直接指定することはできない。

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

## Read model と legacy adapter

- Team list/detail と project list は同じ canonical store を読む。
- `GET /api/work-items` は現在ユーザーが閲覧できる active Team の canonical Work Item を集約し、project 未割当も返す。
- board、calendar、gantt、Workspace Home、My Tasks、Inbox、reports は canonical response と解決済み configuration を共有する。
- `/api/teams/{teamId}/issues` と `/api/projects/{projectId}/issues` は canonical store を参照する API alias である。
- `/api/projects/{projectId}/tasks` は Issue #20 の `source=legacy` read-only adapter である。Legacy response だけが固定 `status` と表示用 key を持ち、workflow field は持たない。
- `ProjectTasksTable` への `Put`、`Update`、`TransactWriteItems` は API Lambda IAM でも許可しない。

`source=legacy` は canonical schema へ変換して保存せず、canonical mutation API でも更新しない。新規 Workspace と demo seed は最初から strict canonical schema だけを作成する。

## 運用

開発中の schema は既存 row を自動変換しない。Schema を更新した環境は保持済みの開発データを削除し、現行 application/CDK の seed または API で strict schema v2 row を作り直す。Seed には `creatorMemberKey`、`workflowSchemaVersion`、`workflowStatusId`、`statusCategory`、`customFieldValues`、空の `relationIds`、正しい `schedule`、および schedule から導出した `dueDate` が必要である。

Production data を保持する必要が生じた後の schema migration は、対象 version と移行仕様を定めた別の変更として設計・検証する。
