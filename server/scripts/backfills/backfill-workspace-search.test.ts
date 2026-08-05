import { describe, expect, spyOn, test } from 'bun:test'
import {
  type DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type DocumentDetail,
} from '@mukuroji/contracts'
import {
  createWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
} from '../../src/modules/workspace-search'
import {
  loadWorkspaceSearchBackfillServerConfig,
  mapCollaborationItem,
  mapDocumentItem,
  mapProjectDirectoryItem,
  mapWorkItem,
  parseWorkItemCollaborationEntityKey,
  runBackfill,
} from './backfill-workspace-search'

describe('Workspace search backfill configuration', () => {
  test('does not invent a local endpoint for an AWS dry-run', () => {
    const config = loadWorkspaceSearchBackfillServerConfig({
      AWS_REGION: 'ap-northeast-1',
    })

    expect(config.dynamoDbEndpoint).toBeUndefined()
  })

  test('isolates the documented shared local endpoint to DynamoDB', () => {
    const config = loadWorkspaceSearchBackfillServerConfig({
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_REGION: 'us-east-1',
    })

    expect(config.dynamoDbEndpoint).toBe('http://localhost:4566')
    expect(config.secretsManagerEndpoint).toBeUndefined()
    expect(config.environment.AWS_ENDPOINT_URL).toBeUndefined()
  })
})

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

function createDocumentRow(
  documentOverrides: Partial<Extract<DocumentDetail, { kind: 'page' }>> = {},
  rowOverrides: Record<string, unknown> = {},
) {
  const document: Extract<DocumentDetail, { kind: 'page' }> = {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'project', projectId: 'project-1' },
    title: 'Launch plan',
    position: 'a0',
    revision: 3,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [{
      id: 'relation-1',
      source: { kind: 'block', blockId: 'block-1' },
      target: { kind: 'work-item', workItemId: 'team/core/issue/launch' },
      createdByUserId: 'owner@example.com',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
    favorite: false,
    capabilities: {
      canView: false,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: false,
    },
    createdByUserId: 'owner@example.com',
    updatedByUserId: 'editor@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T01:00:00.000Z',
    blocks: [
      { id: 'block-1', type: 'heading', level: 1, text: 'Launch checklist' },
      {
        id: 'block-2',
        type: 'checklist',
        items: [{ id: 'item-1', text: 'Verify production', checked: false }],
      },
    ],
    ...structuredClone(documentOverrides),
  }

  return {
    workspaceId: 'workspace#mukuroji',
    recordKey: `DOCUMENT#${document.id}`,
    entryType: 'document',
    documentId: document.id,
    revision: document.revision,
    document,
    elementRevisions: {},
    ...rowOverrides,
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
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
      dueDate: '2026-07-20',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
      priority: 'high',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      relationIds: ['blocks:launch'],
    })
    const second = mapWorkItem({
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
      dueDate: '2026-08-01',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-01'),
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
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
      dueDate: '2026-08-01',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-01'),
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

  test('fails closed on malformed canonical Work Item rows before indexing', () => {
    const baseItem = {
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
      dueDate: '2026-07-20',
      schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
      priority: 'high',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }

    const malformedItems = [
      { ...baseItem, schemaVersion: 0 },
      { ...baseItem, revision: 0 },
      { ...baseItem, directoryTeamId: 'workspace#mukuroji#team#another-team' },
      { ...baseItem, title: undefined, titleKey: 'tasks.releaseCheck' },
      { ...baseItem, workflowSchemaVersion: undefined, status: 'review' },
      { ...baseItem, workflowStatusId: undefined, status: 'review' },
      { ...baseItem, statusCategory: undefined },
      { ...baseItem, customFieldValues: undefined, customFields: { effort: 8 } },
      { ...baseItem, customFieldValues: { effort: null } },
      { ...baseItem, creatorMemberKey: undefined },
      { ...baseItem, relationIds: undefined },
      { ...baseItem, relationIds: ['related:z', 'blocks:a'] },
      { ...baseItem, relationIds: ['blocks:a', 'blocks:a'] },
      { ...baseItem, relationIds: ['unknown:a'] },
      { ...baseItem, status: 'review' },
      { ...baseItem, customFields: { effort: 8 } },
      { ...baseItem, assignee: '佐藤 花子' },
      { ...baseItem, assigneeKey: 'tasks.assignee.sato' },
      { ...baseItem, source: 'dynamodb' },
      {
        ...baseItem,
        migrationSourceKey: 'workspace#mukuroji#project#refero#task#release-check',
      },
    ]

    for (const malformedItem of malformedItems) {
      expect(() => mapWorkItem(malformedItem)).toThrow(
        'Workspace search backfill encountered a non-canonical Work Item row.',
      )
    }
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

  test('fails closed for TTL-managed attributes on Collaboration target candidates', () => {
    const comment = {
      entityKey:
        'workspace#mukuroji#work-item#team/core-team/issue/release-check',
      recordKey: 'COMMENT#comment-1',
      entryType: 'comment',
      id: 'comment-1',
      rootCommentId: 'comment-1',
      authorMemberKey: 'sato@example.com',
      bodyMarkdown: 'TTL-managed target candidate',
      version: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }

    // Explicit undefined still creates the own property that proves the source
    // row participates in the TTL-managed schema and must fail closed.
    for (const expiresAt of [2_000_000_000, undefined]) {
      expect(() => mapCollaborationItem({
        ...comment,
        expiresAt,
      })).toThrow(
        'Workspace search backfill cannot reconcile a Collaboration target candidate that carries the TTL-managed expiresAt attribute.',
      )
    }
  })

  test('projects current Document rows with searchable content and deterministic keys', () => {
    const first = mapDocumentItem(createDocumentRow())
    const second = mapDocumentItem(createDocumentRow())

    if (first?.action !== 'put' || second?.action !== 'put') {
      throw new Error('Expected current Document search projections.')
    }

    expect(first).toEqual(second)
    expect(first.document).toEqual(expect.objectContaining({
      workspaceId: 'workspace#mukuroji',
      recordKey: createWorkspaceSearchDocumentRecordKey('document', 'document-1'),
      entityType: 'document',
      entityId: 'document-1',
      title: 'Launch plan',
      subtitle: 'page',
      body: 'Launch checklist\nVerify production',
      projectId: 'project-1',
      status: 'active',
      relationIds: ['work-item:team/core/issue/launch'],
    }))
  })

  test('deletes archived Document projections with the same deterministic key', () => {
    const archived = mapDocumentItem(createDocumentRow({
      archivedAt: '2026-07-18T02:00:00.000Z',
    }))

    expect(archived).toEqual({
      action: 'delete',
      workspaceId: 'workspace#mukuroji',
      recordKey: createWorkspaceSearchDocumentRecordKey('document', 'document-1'),
      entityType: 'document',
      entityId: 'document-1',
    })
  })

  test('skips Document version rows and malformed current snapshots', () => {
    expect(mapDocumentItem(createDocumentRow({}, {
      entryType: 'document-version',
      recordKey: 'VERSION#document-1#3',
    }))).toBeUndefined()
    expect(mapDocumentItem(createDocumentRow({}, {
      recordKey: 'DOCUMENT#another-document',
    }))).toBeUndefined()
    expect(mapDocumentItem(createDocumentRow({}, {
      revision: 4,
    }))).toBeUndefined()
    expect(mapDocumentItem(createDocumentRow({
      archivedAt: 'not-an-iso-timestamp',
    }))).toBeUndefined()
    expect(mapDocumentItem(createDocumentRow({
      blocks: [
        { id: 'duplicate', type: 'paragraph', text: 'First' },
        { id: 'duplicate', type: 'paragraph', text: 'Second' },
      ],
    }))).toBeUndefined()
  })

  test('fails closed for TTL-managed attributes on Document target candidates', () => {
    // Explicit undefined still creates the own property that proves the source
    // row participates in the TTL-managed schema and must fail closed.
    for (const expiresAtEpoch of [2_000_000_000, undefined]) {
      expect(() => mapDocumentItem(createDocumentRow({}, {
        expiresAtEpoch,
      }))).toThrow(
        'Workspace search backfill cannot reconcile a Document target candidate that carries the TTL-managed expiresAtEpoch attribute.',
      )
    }
  })
})

describe('Workspace search backfill runner', () => {
  test('documents source preserves dry-run, skip, and run limit behavior', async () => {
    const scanInputs: ScanCommandInput[] = []
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    const documentClient = {
      async send(command: unknown) {
        if (!(command instanceof ScanCommand)) {
          throw new Error('Document dry-run attempted to mutate the target table.')
        }

        scanInputs.push(command.input)
        return {
          Items: [
            createDocumentRow(),
            createDocumentRow({}, {
              entryType: 'document-version',
              recordKey: 'VERSION#document-1#3',
            }),
          ],
          ScannedCount: 2,
          LastEvaluatedKey: { cursor: 'not-followed-after-limit' },
        }
      },
    } as unknown as DynamoDBDocumentClient

    try {
      const counters = await runBackfill(
        documentClient,
        [{ name: 'documents', tableName: 'DocumentsTable', mapItem: mapDocumentItem }],
        'WorkspaceSearchTable',
        { dryRun: true, help: false, limit: 2 },
      )

      expect(scanInputs).toEqual([expect.objectContaining({
        TableName: 'DocumentsTable',
        Limit: 2,
      })])
      expect(counters.documents).toEqual({
        scanned: 2,
        projected: 1,
        deleted: 0,
        skipped: 1,
      })
      expect(infoSpy).toHaveBeenCalledTimes(1)
    } finally {
      infoSpy.mockRestore()
    }
  })

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
    const transactionInputs: TransactWriteCommandInput[] = []
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
        if (command instanceof TransactWriteCommand) {
          transactionInputs.push(command.input)
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

    expect(transactionInputs).toHaveLength(2)
    expect(transactionInputs[0]?.TransactItems?.[0]?.Put).toEqual(
      expect.objectContaining({
        TableName: 'WorkspaceSearchTable',
        Item: expect.objectContaining({
          entityId: 'team/core-team/issue/issue-1',
          entryType: 'search-document',
        }),
      }),
    )
    expect(transactionInputs[1]?.TransactItems?.[0]?.Delete).toEqual({
      TableName: 'WorkspaceSearchTable',
      Key: {
        workspaceId: 'workspace#mukuroji',
        recordKey: createWorkspaceSearchDocumentRecordKey(
          'comment',
          'team/core-team/issue/issue-1/comment/comment-1',
        ),
      },
    })
    expect(counters['work-items']).toEqual({
      scanned: 2,
      projected: 1,
      deleted: 1,
      skipped: 0,
    })
  })

  test('write reconciliation aborts before mutating TTL-managed target candidates', async () => {
    const collaborationRow = {
      entityKey:
        'workspace#mukuroji#work-item#team/core-team/issue/release-check',
      recordKey: 'COMMENT#comment-1',
      entryType: 'comment',
      id: 'comment-1',
      rootCommentId: 'comment-1',
      authorMemberKey: 'sato@example.com',
      bodyMarkdown: 'TTL-managed target candidate',
      version: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      expiresAt: 2_000_000_000,
    }
    const cases = [
      {
        name: 'collaboration' as const,
        item: collaborationRow,
        mapItem: mapCollaborationItem,
        message:
          'Workspace search backfill cannot reconcile a Collaboration target candidate that carries the TTL-managed expiresAt attribute.',
      },
      {
        name: 'documents' as const,
        item: createDocumentRow({}, { expiresAtEpoch: 2_000_000_000 }),
        mapItem: mapDocumentItem,
        message:
          'Workspace search backfill cannot reconcile a Document target candidate that carries the TTL-managed expiresAtEpoch attribute.',
      },
    ]

    for (const testCase of cases) {
      let mutationCount = 0
      const documentClient = {
        async send(command: unknown) {
          if (command instanceof ScanCommand) {
            return {
              Items: [testCase.item],
              ScannedCount: 1,
            }
          }

          mutationCount += 1
          return {}
        },
      } as unknown as DynamoDBDocumentClient

      await expect(runBackfill(
        documentClient,
        [{
          name: testCase.name,
          tableName: 'SourceTable',
          mapItem: testCase.mapItem,
        }],
        'WorkspaceSearchTable',
        { dryRun: false, help: false },
      )).rejects.toThrow(testCase.message)
      expect(mutationCount).toBe(0)
    }
  })
})
