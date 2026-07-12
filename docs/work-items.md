# Canonical Work Item

## 目的

Mukuroji の task / issue は、既存 `TeamIssuesTable` を正本とする Team-owned Work Item に統合する。project task table は migration source と read-only compatibility のためだけに保持し、新しい state mutation は書き込まない。

既存の DynamoDB key と activity / collaboration entity ID は rollback と履歴互換のため維持する。

```text
PK directoryTeamId = <workspaceId>#team#<teamId>
SK issueId          = <workItemId>
entityId            = team/<teamId>/issue/<workItemId>
```

コード上の API/UI contract は `@mukuroji/contracts` の `WorkItem`、`CreateWorkItemInput`、`WorkItemPatch`、`UpdateWorkItemInput` を共有し、server と Web に同じ DTO を再定義しない。

## Schema v1

Canonical row は次の field を持つ。

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | 現在は `1`。未知の version を暗黙に解釈しない。 |
| `revision` | yes | 作成時 `1`。state update が成功するたびに `1` 増える。 |
| `directoryId` | yes | Workspace ID。 |
| `directoryTeamId` | yes | Primary partition key。 |
| `teamId` | yes | Work Item を所有する Team。 |
| `issueId` | yes | 現在の physical sort key と公開 `id`。 |
| `assignedProjectId` / `directoryProjectId` | no | 遂行先 project と project GSI key。未割当 Work Item では持たない。 |
| `title` | yes | Literal title。`titleKey` しかない legacy row は rollback 互換のため key 文字列を安全な fallback として保存する。 |
| `description` | no | 詳細説明。 |
| `assigneeUserId` | yes | Workspace member/Cognito user の安定 ID。 |
| `status` | yes | `todo`, `in-progress`, `review`, `done`。 |
| `priority` | yes | `low`, `medium`, `high`。 |
| `dueDate` | yes | 現行 UI 互換の `YYYY/MM/DD`。時刻を持たない UTC calendar day として期限通知を判定する。format / Workspace time zone migration は別 revision で行う。 |
| `sortOrder` | yes | Team/project list の安定表示順。 |
| `createdAt` / `updatedAt` | yes | UTC ISO 8601 timestamp。 |

API response は上記に `id`, `source` を加える。`source=dynamodb` は canonical row、`source=legacy` は project task table からの read-only projection を表す。schema metadata がない旧 Team Issue row は migration window 中だけ `schemaVersion=1`, `revision=1` として upcast し、最初の正常 update または migration で永続化する。

## Optimistic concurrency

Work Item update は `expectedRevision` を必須にする。

```json
{
  "status": "done",
  "expectedRevision": 7
}
```

State update、activity event、audit event は同じ DynamoDB transaction で確定し、state condition は読み込み時の revision と一致する場合だけ成功する。成功 response は `revision=8` を返す。競合を timestamp や last-write-wins で隠さない。

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `InvalidWorkItemRevision` | `expectedRevision` が正の整数でない。 |
| `404` | `TeamIssueNotFound` | 対象 row が削除済み、または存在しない。 |
| `409` | `WorkItemRevisionConflict` | 読み込み後に別 mutation が revision を進めた。 |
| `409` | `LegacyProjectTaskReadOnly` | Legacy projection を更新しようとした。 |

Web は list/detail response の revision を mutation body に含める。`WorkItemRevisionConflict` では optimistic state を rollback し、SWR を再取得する。再取得後の mutation は新しい fingerprint / idempotency context として開始し、古い `expectedRevision` を自動再送しない。

## Read model と互換 route

- Team list/detail と project list は同じ canonical store を読む。
- `GET /api/work-items` は現在ユーザーが閲覧できる active Team の Work Item を集約し、project 未割当も返す。Workspace Home / My Tasks / Inbox / reports はこの response を共有する。
- board、calendar、gantt は project Work Item list の同じ配列を表示し、独自の task store を持たない。
- `/api/teams/{teamId}/issues` と `/api/projects/{projectId}/issues` は既存 deep link/client 向けの compatibility route として維持する。
- `/api/projects/{projectId}/tasks` は migration adapter/read compatibility に限定する。Legacy table への `Put`, `Update`, `TransactWriteItems` は API Lambda IAM でも許可しない。

## State migration

Migration は既存 row を削除せず、同じ `TeamIssuesTable` へ additive に実行する。

1. 変更対象 account/region、3 table の名前、source/target item count を記録する。
2. `ProjectTasksTable` と `TeamIssuesTable` の PITR を確認し、on-demand backup を取得する。
3. 短い write freeze を設定する。
4. legacy task table が read-only、Work Item store が writeable な application/CDK revision を deploy する。
5. dry-run で schema 補完、owner Team、ID collision を確認する。
6. apply を checkpoint 付きで完了する。
7. verify と API checks を実行してから write を再開する。

```sh
export WORK_ITEMS_TABLE_NAME=<WorkItemsTableName>
export PROJECT_TASKS_TABLE_NAME=<ProjectTasksTableName>
export PROJECT_DIRECTORY_TABLE_NAME=<ProjectDirectoryTableName>
export AWS_REGION=<region>

bun run work-items:migrate -- --dry-run \
  --checkpoint /tmp/mukuroji-work-items.json

bun run work-items:migrate -- \
  --checkpoint /tmp/mukuroji-work-items.json

bun run work-items:migrate -- --verify
```

同じ Workspace の project が複数の active Team に表示される場合、migration は先頭 Team を暗黙に選ばず停止する。archived Team は owner 候補から除外する。運用上の owner を確認し、`<directoryId>/<projectId>=<teamId>` 形式で Workspace scoped mapping を明示する。同名 project が別 Workspace に存在しても owner 候補を混在させない。

```sh
bun run work-items:migrate -- --dry-run \
  --checkpoint /tmp/mukuroji-work-items.json \
  --project-team 'workspace#mukuroji/shared-launch=core-team'

bun run work-items:migrate -- \
  --checkpoint /tmp/mukuroji-work-items.json \
  --project-team 'workspace#mukuroji/shared-launch=core-team'

bun run work-items:migrate -- --verify \
  --project-team 'workspace#mukuroji/shared-launch=core-team'
```

dry-run、apply、verify には必ず同じ mapping 一式を渡す。異なる mapping は同じ source row の owner 判定を変えるため、段階間で追加・省略してはならない。

Migration は次を保証する。

- 既存 Team Issue row には欠けている `schemaVersion=1` / `revision=1` だけを conditional update する。
- Legacy task は owner Team の canonical key に conditional put する。
- `titleKey` しかない Legacy task は `title=titleKey` を補完し、表示用 `titleKey` も保持する。
- 再実行は `migrationFingerprint` が一致する row を成功済みとして扱う。
- 異なる payload が同じ key に存在する場合は上書きせず non-zero で終了する。
- Legacy source row は変更・削除しない。
- checkpoint は table 名、endpoint、region、`DescribeTable` で取得した各 Table ARN、mapping の hash を持ち、別 account/region/endpoint へ誤用できない。

Migration 後に過去 state の audit snapshot も必要な環境では、state verify 後に既存 `audit:backfill` を dry-run から実行する。State migration 自体は通知を発火しない。

## Rollback

Rollback window 中は `ProjectTasksTable`、migrated Work Item、旧 partition のいずれも削除しない。

1. write を停止する。
2. 直前に成功していた application/CDK revision を同じ Workspace parameter で deploy する。
3. 旧 code が既存 `TeamIssuesTable` の追加 field を無視し、migration が補完した literal `title` で team/project/detail を読めることを確認する。
4. Legacy task table が migration 前と同じ件数・fingerprintであることを確認する。
5. rollback 中に canonical store へ入った write を照合してから運用を再開する。

Migrated target row を一括削除して rollback してはならない。migration 後に作成された正規 Work Item を巻き込むため、問題は前進修正し、checkpoint/conditional write で再実行する。
