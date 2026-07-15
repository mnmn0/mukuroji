import { describe, expect, spyOn, test } from 'bun:test'
import {
  DeleteCommand,
  type DeleteCommandInput,
  type DynamoDBDocumentClient,
  PutCommand,
  type PutCommandInput,
  ScanCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  createWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
} from '../src/workspace-search'
import {
  mapCollaborationItem,
  mapProjectDirectoryItem,
  mapWorkItem,
  parseWorkItemCollaborationEntityKey,
  runBackfill,
} from './backfill-workspace-search'

function mapRunnerItem(item: Record<string, unknown>) {
  const id = typeof item.id === 'string' ? item.id : 'unknown'

  if (item.action === 'delete') {
    const entityId = `team/core-team/issue/issue-1/comment/${id}`
    return {
      action: 'delete' as const,
      workspaceId: 'workspace#mukuroji',
      recordKey: createWorkspaceSearchDocumentRecordKey('comment', entityId),
      entityType: 'comment' as const,
      entityId,
    }
  }

  return {
    action: 'put' as const,
    document: createWorkspaceSearchDocument({
      workspaceId: 'workspace#mukuroji',
      entityType: 'work-item',
      entityId: `team/core-team/issue/${id}`,
      title: `Work Item ${id}`,
      url: `/teams/core-team/issues?issueId=${encodeURIComponent(id)}`,
      teamId: 'core-team',
    }),
  }
}

describe('Workspace search backfill mapping', () => {
  test('keeps Team context in Team and shared Project document IDs', () => {
    const team = mapProjectDirectoryItem({
      directoryId: 'workspace#mukuroji',
      entryKey: '000010#000000#TEAM#core-team',
      entryType: 'team',
      teamId: 'core-team',
      teamSortOrder: 10,
      nameJa: 'コアチーム',
      nameEn: 'Core team',
    })
    const project = mapProjectDirectoryItem({
      directoryId: 'workspace#mukuroji',
      entryKey: '000020#000010#PROJECT#shared-launch',
      entryType: 'project',
      teamId: 'design-team',
      teamSortOrder: 20,
      projectId: 'shared-launch',
      projectSortOrder: 10,
      nameJa: '共通ローンチ',
      nameEn: 'Shared launch',
      tone: 'blue',
    })

    if (team?.action !== 'put' || project?.action !== 'put') {
      throw new Error('Expected Team and Project search documents.')
    }

    expect(team.document).toEqual(expect.objectContaining({
      entityId: 'team/core-team',
      entityType: 'team',
      teamId: 'core-team',
      title: 'コアチーム',
    }))
    expect(team.document.subtitle).toBe('Core team')
    expect(project.document).toEqual(expect.objectContaining({
      entityId: 'team/design-team/project/shared-launch',
      entityType: 'project',
      projectId: 'shared-launch',
      teamId: 'design-team',
      title: '共通ローンチ',
    }))
    expect(project.document.subtitle).toBe('Shared launch')
  })

  test('uses different document keys for the same Work Item ID in different Teams', () => {
    const first = mapWorkItem({
      schemaVersion: 1,
      revision: 3,
      directoryId: 'workspace#mukuroji',
      directoryTeamId: 'workspace#mukuroji#team#core-team',
      teamId: 'core-team',
      issueId: 'release-check',
      sortOrder: 10,
      title: 'Release check',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'creator@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'review',
      statusCategory: 'started',
      customFieldValues: { effort: 8, approved: true },
      dueDate: '2026/07/20',
      priority: 'high',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      relationIds: ['blocks:launch'],
    })
    const second = mapWorkItem({
      schemaVersion: 1,
      revision: 1,
      directoryId: 'workspace#mukuroji',
      directoryTeamId: 'workspace#mukuroji#team#design-team',
      teamId: 'design-team',
      issueId: 'release-check',
      sortOrder: 20,
      title: 'Release check',
      assigneeUserId: 'suzuki@example.com',
      creatorMemberKey: 'creator@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026/08/01',
      priority: 'medium',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    })

    if (first?.action !== 'put' || second?.action !== 'put') {
      throw new Error('Expected Work Item search documents.')
    }

    expect(first.document.entityId).toBe('team/core-team/issue/release-check')
    expect(second.document.entityId).toBe('team/design-team/issue/release-check')
    expect(first.document.recordKey).not.toBe(second.document.recordKey)
    expect(first.document.subtitle).toBe('release-check')
    expect(first.document.customFields).toEqual({ effort: 8, approved: true })
    expect(first.document.status).toBe('review')
    expect(first.document.relationIds).toEqual(['blocks:launch'])
    expect(second.document.relationIds).toEqual([])
    expect(first.document.dueDate).toBe('2026-07-20')
  })

  test('accepts the backlog workflow status category', () => {
    const operation = mapWorkItem({
      schemaVersion: 1,
      revision: 1,
      directoryId: 'workspace#mukuroji',
      directoryTeamId: 'workspace#mukuroji#team#core-team',
      teamId: 'core-team',
      issueId: 'backlog-item',
      sortOrder: 10,
      title: 'Backlog item',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'creator@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'backlog',
      statusCategory: 'backlog',
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026/08/01',
      priority: 'medium',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    })

    expect(operation?.action).toBe('put')
    if (operation?.action !== 'put') {
      throw new Error('Expected a backlog Work Item search document.')
    }
    expect(operation.document.status).toBe('backlog')
  })

  test('skips malformed canonical Work Item rows before indexing their Team scope', () => {
    const baseItem = {
      schemaVersion: 1,
      revision: 1,
      directoryId: 'workspace#mukuroji',
      directoryTeamId: 'workspace#mukuroji#team#core-team',
      teamId: 'core-team',
      issueId: 'release-check',
      sortOrder: 10,
      title: 'Release check',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'creator@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'review',
      statusCategory: 'started',
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026/07/20',
      priority: 'high',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }

    expect(mapWorkItem({ ...baseItem, schemaVersion: 0 })).toBeUndefined()
    expect(mapWorkItem({ ...baseItem, revision: 0 })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      directoryTeamId: 'workspace#mukuroji#team#another-team',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      title: undefined,
      titleKey: 'tasks.releaseCheck',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      workflowSchemaVersion: undefined,
      status: 'review',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      workflowStatusId: undefined,
      status: 'review',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      statusCategory: undefined,
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      customFieldValues: undefined,
      customFields: { effort: 8 },
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      customFieldValues: { effort: null },
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      creatorMemberKey: undefined,
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      relationIds: undefined,
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      relationIds: ['related:z', 'blocks:a'],
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      relationIds: ['blocks:a', 'blocks:a'],
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      relationIds: ['unknown:a'],
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      status: 'review',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      customFields: { effort: 8 },
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      assignee: '佐藤 花子',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      assigneeKey: 'tasks.assignee.sato',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      source: 'dynamodb',
    })).toBeUndefined()
    expect(mapWorkItem({
      ...baseItem,
      migrationSourceKey: 'workspace#mukuroji#project#refero#task#release-check',
    })).toBeUndefined()
  })

  test('strictly parses comment scope and deletes soft-deleted projections', () => {
    const entityKey =
      'workspace#mukuroji-local#work-item#team/core-team/issue/release-check'
    const comment = mapCollaborationItem({
      entityKey,
      recordKey: 'COMMENT#comment-1',
      entryType: 'comment',
      id: 'comment-1',
      rootCommentId: 'comment-1',
      authorMemberKey: 'sato@example.com',
      bodyMarkdown: '確認しました。\n\n次の手順へ進めます。',
      version: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:10:00.000Z',
    })
    const deleted = mapCollaborationItem({
      entityKey,
      recordKey: 'COMMENT#comment-1',
      entryType: 'comment',
      id: 'comment-1',
      rootCommentId: 'comment-1',
      authorMemberKey: 'sato@example.com',
      bodyMarkdown: '',
      version: 2,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:20:00.000Z',
      deletedAt: '2026-07-12T00:20:00.000Z',
    })

    if (comment?.action !== 'put' || deleted?.action !== 'delete') {
      throw new Error('Expected comment put and delete operations.')
    }

    expect(parseWorkItemCollaborationEntityKey(entityKey)).toEqual({
      workspaceId: 'workspace#mukuroji-local',
      teamId: 'core-team',
      issueId: 'release-check',
    })
    expect(comment.document).toEqual(expect.objectContaining({
      entityId: 'team/core-team/issue/release-check/comment/comment-1',
      parentId: 'team/core-team/issue/release-check',
      creatorUserId: 'sato@example.com',
      subtitle: 'sato@example.com',
      teamId: 'core-team',
      title: '確認しました。',
    }))
    expect(deleted.entityId).toBe(comment.document.entityId)
    expect(deleted.recordKey).toBe(comment.document.recordKey)
  })

  test('rejects non-comment rows and malformed or mismatched comment keys', () => {
    expect(mapCollaborationItem({
      entityKey: 'workspace#mukuroji#work-item#team/core-team/issue/release-check',
      recordKey: 'WATCHER#demo@example.com',
      entryType: 'watcher',
    })).toBeUndefined()
    expect(mapCollaborationItem({
      entityKey: 'workspace#mukuroji#work-item#team/core-team/issue/release-check',
      recordKey: 'COMMENT#different-id',
      entryType: 'comment',
      id: 'comment-1',
      rootCommentId: 'comment-1',
      authorMemberKey: 'sato@example.com',
      bodyMarkdown: 'Mismatch',
      version: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    })).toBeUndefined()
    expect(parseWorkItemCollaborationEntityKey(
      'workspace#mukuroji#work-item#team/core-team/issue/release/check',
    )).toBeUndefined()
  })
})

describe('Workspace search backfill runner', () => {
  test('dry-run follows scan cursors without writing or exceeding the run limit', async () => {
    const scanInputs: ScanCommandInput[] = []
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    const documentClient = {
      async send(command: unknown) {
        if (!(command instanceof ScanCommand)) {
          throw new Error('Dry-run attempted to mutate the target table.')
        }

        scanInputs.push(command.input)
        if (!command.input.ExclusiveStartKey) {
          return {
            Items: [
              { action: 'put', id: 'issue-1' },
              { action: 'delete', id: 'comment-1' },
            ],
            ScannedCount: 2,
            LastEvaluatedKey: { cursor: 'page-2' },
          }
        }

        return {
          Items: [{ action: 'put', id: 'issue-2' }],
          ScannedCount: 1,
        }
      },
    } as unknown as DynamoDBDocumentClient

    try {
      const counters = await runBackfill(
        documentClient,
        [{ name: 'work-items', tableName: 'SourceTable', mapItem: mapRunnerItem }],
        'WorkspaceSearchTable',
        { dryRun: true, help: false, limit: 3 },
      )

      expect(scanInputs).toHaveLength(2)
      expect(scanInputs[0]).toEqual(expect.objectContaining({
        TableName: 'SourceTable',
        Limit: 3,
      }))
      expect(scanInputs[0]?.ExclusiveStartKey).toBeUndefined()
      expect(scanInputs[1]).toEqual(expect.objectContaining({
        ExclusiveStartKey: { cursor: 'page-2' },
        Limit: 1,
      }))
      expect(counters['work-items']).toEqual({
        scanned: 3,
        projected: 2,
        deleted: 1,
        skipped: 0,
      })
      expect(infoSpy).toHaveBeenCalledTimes(3)
    } finally {
      infoSpy.mockRestore()
    }
  })

  test('write run applies both put and delete projection operations', async () => {
    const putInputs: PutCommandInput[] = []
    const deleteInputs: DeleteCommandInput[] = []
    const documentClient = {
      async send(command: unknown) {
        if (command instanceof ScanCommand) {
          return {
            Items: [
              { action: 'put', id: 'issue-1' },
              { action: 'delete', id: 'comment-1' },
            ],
            ScannedCount: 2,
          }
        }
        if (command instanceof PutCommand) {
          putInputs.push(command.input)
          return {}
        }
        if (command instanceof DeleteCommand) {
          deleteInputs.push(command.input)
          return {}
        }
        throw new Error('Unexpected DynamoDB command.')
      },
    } as unknown as DynamoDBDocumentClient

    const counters = await runBackfill(
      documentClient,
      [{ name: 'work-items', tableName: 'SourceTable', mapItem: mapRunnerItem }],
      'WorkspaceSearchTable',
      { dryRun: false, help: false },
    )

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0]).toEqual(expect.objectContaining({
      TableName: 'WorkspaceSearchTable',
      Item: expect.objectContaining({
        entityId: 'team/core-team/issue/issue-1',
        entryType: 'search-document',
      }),
    }))
    expect(deleteInputs).toEqual([
      {
        TableName: 'WorkspaceSearchTable',
        Key: {
          workspaceId: 'workspace#mukuroji',
          recordKey: createWorkspaceSearchDocumentRecordKey(
            'comment',
            'team/core-team/issue/issue-1/comment/comment-1',
          ),
        },
      },
    ])
    expect(counters['work-items']).toEqual({
      scanned: 2,
      projected: 1,
      deleted: 1,
      skipped: 0,
    })
  })
})
