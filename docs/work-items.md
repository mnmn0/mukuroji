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

## Schema v1

Canonical row は次の field を持つ。

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Work Item contract の schema version。現在は `1`。 |
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
| `workflowSchemaVersion` | yes | 値を検証した Work Item configuration schema version。現在は `1`。 |
| `workflowStatusId` | yes | 解決済み workflow の status ID。 |
| `statusCategory` | yes | status 定義から確定した `backlog`、`unstarted`、`started`、`completed`、`canceled` のいずれか。 |
| `customFieldValues` | yes | configuration に対して検証済みの field ID / value map。値がなくても `{}` を保存する。 |
| `relationIds` | yes | Relation Graph から導出した `type:targetWorkItemId` の辞書順・重複なし配列。最大100件で、relation がなくても `[]` を保存する。 |
| `priority` | yes | `low`、`medium`、`high`。 |
| `dueDate` | yes | `YYYY/MM/DD` または `YYYY-MM-DD` 形式の UTC calendar day。 |
| `sortOrder` | yes | Team/project list の安定表示順。 |
| `createdAt` / `updatedAt` | yes | UTC ISO 8601 timestamp。 |

Canonical row と API response は旧固定 `status`、`titleKey`、`assignee`、`assigneeKey` を持たない。API response は上記に `id` と `source=dynamodb` を加える。

Reader は必須 workflow field がない row、未知の schema version、型が不正な status/custom field、不正または欠落した `relationIds` を canonical Work Item として返さない。現在の configuration との整合は configuration 更新時の usage 検証と mutation 時の再検証で保証し、read 時に configuration は取得しない。旧 row の read-time upcast、固定 status への fallback、更新時の補完は行わない。

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

開発中の schema は既存 row を自動変換しない。schema を変更した環境は保持済みの開発データを削除し、現行 application/CDK の seed または API で strict canonical row を作り直す。

Deploy 前後では次を確認する。

1. `cdk diff` で canonical table の replacement/deletion がないことを確認する。
2. Demo seed が `creatorMemberKey`、`workflowSchemaVersion`、`workflowStatusId`、`statusCategory`、`customFieldValues`、空の `relationIds` を保存することを確認する。
3. Team/project/Workspace list、detail update、任意の workflow status transition を確認する。
4. 古い revision の更新が `409 WorkItemRevisionConflict` になることを確認する。
5. Strict schema を満たさない canonical row が黙って補完されず、診断可能な error になることを確認する。

Production data を保持する必要が生じた後の schema migration は、対象 version と移行仕様を定めた別の変更として設計・検証する。
