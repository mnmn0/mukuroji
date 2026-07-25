import { describe, expect, test } from 'bun:test'
import {
  mapWorkspaceSearchMigrationRow,
  type WorkspaceSearchMigrationMappedRow,
  type WorkspaceSearchMigrationRowClassification,
} from './migration-mapper'

/**
 * Creates a canonical Project Directory Team row.
 *
 * @param overrides - Fields to replace in the fixture.
 * @returns Decoded native Team row.
 */
function createTeamRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    directoryId: 'workspace-1',
    entryKey: '000001#000000#TEAM#team-1',
    entryType: 'team',
    teamId: 'team-1',
    teamSortOrder: 1,
    nameJa: 'チーム',
    nameEn: 'Team',
    expanded: true,
    ...overrides,
  }
}

/**
 * Creates a canonical Project Directory Project row.
 *
 * @param overrides - Fields to replace in the fixture.
 * @returns Decoded native Project row.
 */
function createProjectRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    directoryId: 'workspace-1',
    entryKey: '000001#000002#PROJECT#project-1',
    entryType: 'project',
    teamId: 'team-1',
    teamSortOrder: 1,
    projectId: 'project-1',
    projectSortOrder: 2,
    nameJa: '',
    nameEn: 'Project',
    tone: 'blue',
    ...overrides,
  }
}

/**
 * Creates a strict canonical Work Item row.
 *
 * @param overrides - Fields to replace in the fixture.
 * @returns Decoded native Work Item row.
 */
function createWorkItemRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 3,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#team-1',
    directoryProjectId: 'workspace-1#project#project-1',
    teamId: 'team-1',
    assignedProjectId: 'project-1',
    issueId: 'issue-1',
    sortOrder: 10,
    title: 'Prepare migration',
    description: 'Verify the maintenance controls.',
    assigneeUserId: 'assignee@example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {
      estimate: 3,
      labels: ['migration', 'production'],
    },
    relationIds: ['blocks:issue-2'],
    dueDate: '2026/07/31',
    priority: 'high',
    createdAt: '2026-07-20T01:00:00.000Z',
    updatedAt: '2026-07-25T01:00:00.000Z',
    ...overrides,
  }
}

/**
 * Creates a canonical Collaboration comment row.
 *
 * @param overrides - Fields to replace in the fixture.
 * @returns Decoded native comment row.
 */
function createCommentRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    entityKey: 'workspace-1#work-item#team/team-1/issue/issue-1',
    recordKey: 'COMMENT#comment-1',
    entryType: 'comment',
    id: 'comment-1',
    rootCommentId: 'comment-1',
    authorMemberKey: 'author@example.com',
    bodyMarkdown: 'Maintenance window approved.\nProceed carefully.',
    version: 2,
    mentionMemberKeys: [],
    createdAt: '2026-07-24T01:00:00.000Z',
    updatedAt: '2026-07-24T02:00:00.000Z',
    ...overrides,
  }
}

/**
 * Creates a canonical page Document snapshot as an untrusted record.
 *
 * @param overrides - Fields to replace in the snapshot.
 * @returns Decoded native Document detail.
 */
function createDocumentSnapshot(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'project', projectId: 'project-1' },
    title: 'Migration runbook',
    position: 'a0',
    revision: 4,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
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
    createdByUserId: 'creator@example.com',
    updatedByUserId: 'editor@example.com',
    createdAt: '2026-07-20T01:00:00.000Z',
    updatedAt: '2026-07-25T01:00:00.000Z',
    blocks: [
      {
        id: 'block-1',
        type: 'heading',
        level: 1,
        text: 'Production procedure',
      },
      {
        id: 'block-2',
        type: 'paragraph',
        text: 'Verify rollback before apply.',
      },
    ],
    ...overrides,
  }
}

/**
 * Creates a current Documents table row.
 *
 * @param documentOverrides - Fields to replace in the nested snapshot.
 * @param rowOverrides - Fields to replace in the physical row.
 * @returns Decoded native current Document row.
 */
function createDocumentRow(
  documentOverrides: Readonly<Record<string, unknown>> = {},
  rowOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    workspaceId: 'workspace-1',
    recordKey: 'DOCUMENT#document-1',
    entryType: 'document',
    documentId: 'document-1',
    revision: 4,
    document: createDocumentSnapshot(documentOverrides),
    elementRevisions: {
      'block:block-1': 4,
      'block:block-2': 4,
    },
    ...rowOverrides,
  }
}

/**
 * Narrows a mapper result to a mapped row for readable assertions.
 *
 * @param result - Mapper classification.
 * @returns Mapped row.
 */
function requireMapped(
  result: WorkspaceSearchMigrationRowClassification,
): WorkspaceSearchMigrationMappedRow {
  if (result.classification !== 'mapped') {
    throw new Error('Expected mapped fixture result.')
  }
  return result
}

describe('Workspace Search production migration mapper', () => {
  test('maps canonical Team and Project rows to deterministic put documents', () => {
    const team = requireMapped(
      mapWorkspaceSearchMigrationRow('project-directory', createTeamRow()),
    )
    const project = requireMapped(
      mapWorkspaceSearchMigrationRow('project-directory', createProjectRow()),
    )

    expect(team.entityType).toBe('team')
    expect(team.operation.action).toBe('put')
    if (team.operation.action !== 'put') {
      throw new Error('Expected Team put.')
    }
    expect(team.operation.document).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      entryType: 'search-document',
      entityType: 'team',
      entityId: 'team/team-1',
      title: 'チーム',
      subtitle: 'Team',
      teamId: 'team-1',
      url: '/teams/team-1/overview',
    })
    expect(team.targetKey).toEqual({
      workspaceId: team.operation.document.workspaceId,
      recordKey: team.operation.document.recordKey,
    })

    expect(project.entityType).toBe('project')
    expect(project.operation.action).toBe('put')
    if (project.operation.action !== 'put') {
      throw new Error('Expected Project put.')
    }
    expect(project.operation.document).toMatchObject({
      entityType: 'project',
      entityId: 'team/team-1/project/project-1',
      title: 'Project',
      teamId: 'team-1',
      projectId: 'project-1',
    })
  })

  test('maps canonical archived directory rows to deterministic deletes', () => {
    const activeTeam = requireMapped(
      mapWorkspaceSearchMigrationRow('project-directory', createTeamRow()),
    )
    const archivedTeam = requireMapped(mapWorkspaceSearchMigrationRow(
      'project-directory',
      createTeamRow({ archivedAt: '2026-07-25T01:00:00.000Z' }),
    ))
    const activeProject = requireMapped(
      mapWorkspaceSearchMigrationRow('project-directory', createProjectRow()),
    )
    const archivedProject = requireMapped(mapWorkspaceSearchMigrationRow(
      'project-directory',
      createProjectRow({ archivedAt: '2026-07-25T01:00:00.000Z' }),
    ))

    expect(archivedTeam.operation).toEqual({ action: 'delete' })
    expect(archivedTeam.targetKey).toEqual(activeTeam.targetKey)
    expect(archivedProject.operation).toEqual({ action: 'delete' })
    expect(archivedProject.targetKey).toEqual(activeProject.targetKey)
  })

  test('fails closed for malformed Team and Project target rows', () => {
    for (const item of [
      createTeamRow({ entryKey: 'wrong-key' }),
      createTeamRow({ directoryId: ' workspace-1 ' }),
      createTeamRow({
        teamId: 'team/ambiguous',
        entryKey: '000001#000000#TEAM#team/ambiguous',
      }),
      createTeamRow({ nameJa: '', nameEn: '' }),
      createTeamRow({ nameJa: 'x'.repeat(501) }),
      createTeamRow({ archivedAt: '2026-07-25T01:00:00Z' }),
      createTeamRow({
        createdAt: '2026-07-25T01:00:00.000Z',
        updatedAt: '2026-07-25T02:00:00.000Z',
        archivedAt: '2026-07-25T03:00:00.000Z',
      }),
      createTeamRow({ expanded: 'yes' }),
      createProjectRow({ tone: undefined }),
      createProjectRow({ projectSortOrder: 0 }),
      createProjectRow({ entryKey: 'wrong-key' }),
      createProjectRow({
        projectId: 'project/ambiguous',
        entryKey: '000001#000002#PROJECT#project/ambiguous',
      }),
    ]) {
      expect(
        mapWorkspaceSearchMigrationRow('project-directory', item),
      ).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_PROJECT_DIRECTORY_TARGET',
      })
    }
  })

  test('ignores recognized directory support rows and rejects unknown rows', () => {
    for (const entryType of [
      'email-alias',
      'planning-meta',
      'project-member',
      'webhook-team-grant',
      'webhook-team-grant-cleanup',
      'workspace-member',
      'workspace-metadata',
    ]) {
      expect(mapWorkspaceSearchMigrationRow(
        'project-directory',
        { entryType, tenantSecret: 'not-returned' },
      )).toEqual({
        classification: 'ignored',
        reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
      })
    }
    expect(mapWorkspaceSearchMigrationRow(
      'project-directory',
      {
        entryType: 'webhook-team-grant',
        entryKey: 'TEAM#core-team#PROJECT#refero',
      },
    )).toEqual({
      classification: 'ignored',
      reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
    })

    expect(mapWorkspaceSearchMigrationRow(
      'project-directory',
      { entryType: 'future-secret-row', tenantSecret: 'not-returned' },
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'UNRECOGNIZED_PROJECT_DIRECTORY_ROW',
    })
    expect(mapWorkspaceSearchMigrationRow(
      'project-directory',
      createTeamRow({ entryType: 'workspace-member' }),
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'MALFORMED_PROJECT_DIRECTORY_TARGET',
    })
  })

  test('maps active, archived, and legacy deleted canonical Work Items', () => {
    const active = requireMapped(
      mapWorkspaceSearchMigrationRow('work-items', createWorkItemRow()),
    )
    expect(active.operation.action).toBe('put')
    if (active.operation.action !== 'put') {
      throw new Error('Expected Work Item put.')
    }
    expect(active.operation.document).toMatchObject({
      entityType: 'work-item',
      entityId: 'team/team-1/issue/issue-1',
      title: 'Prepare migration',
      body: 'Verify the maintenance controls.',
      teamId: 'team-1',
      projectId: 'project-1',
      assigneeUserId: 'assignee@example.com',
      creatorUserId: 'creator@example.com',
      status: 'in-progress',
      customFields: {
        estimate: 3,
        labels: ['migration', 'production'],
      },
      relationIds: ['blocks:issue-2'],
      dueDate: '2026-07-31',
    })

    const archived = requireMapped(mapWorkspaceSearchMigrationRow(
      'work-items',
      createWorkItemRow({
        archivedAt: '2026-07-24T01:00:00.000Z',
        archivedBy: 'archiver@example.com',
      }),
    ))
    const deleted = requireMapped(mapWorkspaceSearchMigrationRow(
      'work-items',
      createWorkItemRow({
        deletedAt: '2026-07-24T01:00:00.000Z',
      }),
    ))
    expect(archived.operation).toEqual({ action: 'delete' })
    expect(deleted.operation).toEqual({ action: 'delete' })
    expect(deleted.targetKey).toEqual(archived.targetKey)
  })

  test('fails closed for every malformed Work Item target row', () => {
    for (const item of [
      createWorkItemRow({ schemaVersion: 2 }),
      createWorkItemRow({ directoryTeamId: 'workspace-1#team#other' }),
      createWorkItemRow({
        teamId: 'team/ambiguous',
        directoryTeamId: 'workspace-1#team#team/ambiguous',
      }),
      createWorkItemRow({ issueId: 'issue/ambiguous' }),
      createWorkItemRow({ title: '' }),
      createWorkItemRow({ title: 'x'.repeat(501) }),
      createWorkItemRow({ dueDate: '2026-02-30' }),
      createWorkItemRow({ relationIds: ['related:z', 'blocks:a'] }),
      createWorkItemRow({ deletedAt: '2026-07-24T01:00:00Z' }),
      createWorkItemRow({ deletedAt: '2026-07-26T01:00:00.000Z' }),
      createWorkItemRow({ deletedAt: '2026-07-19T01:00:00.000Z' }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('work-items', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_WORK_ITEM_TARGET',
      })
    }
  })

  test('rejects structured entity ID delimiter collisions', () => {
    const collidingProjects = [
      createProjectRow({
        teamId: 'a/project/b',
        projectId: 'c',
        entryKey: '000001#000002#PROJECT#c',
      }),
      createProjectRow({
        teamId: 'a',
        projectId: 'b/project/c',
        entryKey: '000001#000002#PROJECT#b/project/c',
      }),
    ]
    const collidingWorkItems = [
      createWorkItemRow({
        teamId: 'a/issue/b',
        directoryTeamId: 'workspace-1#team#a/issue/b',
        issueId: 'c',
      }),
      createWorkItemRow({
        teamId: 'a',
        directoryTeamId: 'workspace-1#team#a',
        issueId: 'b/issue/c',
      }),
    ]

    for (const item of collidingProjects) {
      expect(mapWorkspaceSearchMigrationRow('project-directory', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_PROJECT_DIRECTORY_TARGET',
      })
    }
    for (const item of collidingWorkItems) {
      expect(mapWorkspaceSearchMigrationRow('work-items', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_WORK_ITEM_TARGET',
      })
    }
  })

  test('rejects overlong Workspace IDs on active and delete paths', () => {
    const workspaceId = 'w'.repeat(1_025)
    const workItemOverrides = {
      directoryId: workspaceId,
      directoryTeamId: `${workspaceId}#team#team-1`,
      directoryProjectId: `${workspaceId}#project#project-1`,
    }
    const commentEntityKey =
      `${workspaceId}#work-item#team/team-1/issue/issue-1`

    for (const item of [
      createTeamRow({ directoryId: workspaceId }),
      createTeamRow({
        directoryId: workspaceId,
        archivedAt: '2026-07-25T01:00:00.000Z',
      }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('project-directory', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_PROJECT_DIRECTORY_TARGET',
      })
    }
    for (const item of [
      createWorkItemRow(workItemOverrides),
      createWorkItemRow({
        ...workItemOverrides,
        deletedAt: '2026-07-24T01:00:00.000Z',
      }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('work-items', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_WORK_ITEM_TARGET',
      })
    }
    for (const item of [
      createCommentRow({ entityKey: commentEntityKey }),
      createCommentRow({
        entityKey: commentEntityKey,
        bodyMarkdown: '',
        deletedAt: '2026-07-24T02:00:00.000Z',
      }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('collaboration', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_COLLABORATION_TARGET',
      })
    }
    for (const item of [
      createDocumentRow({}, { workspaceId }),
      createDocumentRow(
        { archivedAt: '2026-07-24T01:00:00.000Z' },
        { workspaceId },
      ),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('documents', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_DOCUMENT_TARGET',
      })
    }
  })

  test('maps active and deleted canonical Collaboration comments', () => {
    const active = requireMapped(
      mapWorkspaceSearchMigrationRow('collaboration', createCommentRow()),
    )
    expect(active.operation.action).toBe('put')
    if (active.operation.action !== 'put') {
      throw new Error('Expected comment put.')
    }
    expect(active.operation.document).toMatchObject({
      entityType: 'comment',
      entityId: 'team/team-1/issue/issue-1/comment/comment-1',
      title: 'Maintenance window approved.',
      body: 'Maintenance window approved.\nProceed carefully.',
      creatorUserId: 'author@example.com',
      parentId: 'team/team-1/issue/issue-1',
    })

    const deleted = requireMapped(mapWorkspaceSearchMigrationRow(
      'collaboration',
      createCommentRow({
        bodyMarkdown: '',
        deletedAt: '2026-07-24T02:00:00.000Z',
      }),
    ))
    expect(deleted.operation).toEqual({ action: 'delete' })
    expect(deleted.entityType).toBe('comment')
    expect(deleted.targetKey).toEqual(active.targetKey)
  })

  test('ignores recognized Collaboration rows and rejects unknown discriminators', () => {
    for (const entryType of ['discussion', 'presence', 'reaction', 'watcher']) {
      expect(mapWorkspaceSearchMigrationRow(
        'collaboration',
        { entryType, tenantSecret: 'not-returned' },
      )).toEqual({
        classification: 'ignored',
        reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
      })
    }
    expect(mapWorkspaceSearchMigrationRow(
      'collaboration',
      { entryType: 'future-row', tenantSecret: 'not-returned' },
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'UNRECOGNIZED_COLLABORATION_ROW',
    })
    expect(mapWorkspaceSearchMigrationRow(
      'collaboration',
      createCommentRow({ entryType: 'reaction' }),
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'MALFORMED_COLLABORATION_TARGET',
    })
  })

  test('fails closed for malformed Collaboration comment targets', () => {
    for (const item of [
      createCommentRow({ entityKey: 'not-a-work-item-key' }),
      createCommentRow({
        entityKey: 'workspace-1 #work-item#team/team-1/issue/issue-1',
      }),
      createCommentRow({ recordKey: 'COMMENT#other' }),
      createCommentRow({ id: 'comment/ambiguous' }),
      createCommentRow({ rootCommentId: 'root/ambiguous' }),
      createCommentRow({ authorMemberKey: '' }),
      createCommentRow({ bodyMarkdown: '' }),
      createCommentRow({ version: 0 }),
      createCommentRow({ mentionMemberKeys: undefined }),
      createCommentRow({
        mentionMemberKeys: Array.from(
          { length: 21 },
          (_, index) => `member-${index}@example.com`,
        ),
      }),
      createCommentRow({
        mentionMemberKeys: ['member@example.com', 'member@example.com'],
      }),
      createCommentRow({ mentionMemberKeys: ['Member@Example.com'] }),
      createCommentRow({ createdAt: '2026-07-24T01:00:00Z' }),
      createCommentRow({ deletedAt: '2026-07-24T03:00:00.000Z' }),
      createCommentRow({ resolvedAt: '2026-07-24T02:00:00.000Z' }),
      createCommentRow({ resolvedByMemberKey: 'resolver@example.com' }),
      createCommentRow({
        resolvedAt: '2026-07-24T02:00:00.000Z',
        resolvedByMemberKey: 'Resolver@Example.com',
      }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('collaboration', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_COLLABORATION_TARGET',
      })
    }
  })

  test('maps active and archived current Document rows', () => {
    const active = requireMapped(
      mapWorkspaceSearchMigrationRow('documents', createDocumentRow()),
    )
    expect(active.operation.action).toBe('put')
    if (active.operation.action !== 'put') {
      throw new Error('Expected Document put.')
    }
    expect(active.operation.document).toMatchObject({
      entityType: 'document',
      entityId: 'document-1',
      title: 'Migration runbook',
      subtitle: 'page',
      body: 'Production procedure\nVerify rollback before apply.',
      projectId: 'project-1',
      sourceRevision: 4,
      status: 'active',
    })

    const archived = requireMapped(mapWorkspaceSearchMigrationRow(
      'documents',
      createDocumentRow({
        archivedAt: '2026-07-24T01:00:00.000Z',
      }),
    ))
    expect(archived.operation).toEqual({ action: 'delete' })
    expect(archived.entityType).toBe('document')
    expect(archived.targetKey).toEqual(active.targetKey)
  })

  test('ignores every recognized Documents support row', () => {
    const entryTypes = [
      'document-authorization-revision',
      'document-backlink',
      'document-backlink-target-fence',
      'document-child',
      'document-comment',
      'document-comment-receipt',
      'document-operation',
      'document-preference',
      'document-presence',
      'document-public-link',
      'document-recent',
      'document-search-access',
      'document-search-body',
      'document-share',
      'document-tree-revision',
      'document-version',
      'document-version-delta',
      'document-version-snapshot',
    ]

    for (const entryType of entryTypes) {
      expect(mapWorkspaceSearchMigrationRow(
        'documents',
        { entryType, tenantSecret: 'not-returned' },
      )).toEqual({
        classification: 'ignored',
        reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
      })
    }

    expect(mapWorkspaceSearchMigrationRow(
      'documents',
      createDocumentRow({}, { entryType: 'document-comment' }),
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'MALFORMED_DOCUMENT_TARGET',
    })
  })

  test('fails closed for malformed or unknown Document rows', () => {
    for (const item of [
      createDocumentRow({}, { recordKey: 'DOCUMENT#other' }),
      createDocumentRow({}, { workspaceId: ' workspace-1 ' }),
      createDocumentRow({}, { revision: 3 }),
      createDocumentRow({ schemaVersion: 2 }),
      createDocumentRow({ title: '' }),
      createDocumentRow({ capabilities: { canView: true } }),
      createDocumentRow({ updatedAt: '2026-07-19T01:00:00.000Z' }),
      createDocumentRow({ createdAt: '2026-07-20T01:00:00+00:00' }),
      createDocumentRow({ updatedAt: 'not-a-timestamp' }),
      createDocumentRow({ archivedAt: '2026-07-25T01:00:00Z' }),
    ]) {
      expect(mapWorkspaceSearchMigrationRow('documents', item)).toEqual({
        classification: 'invalid',
        reasonCode: 'MALFORMED_DOCUMENT_TARGET',
      })
    }

    expect(mapWorkspaceSearchMigrationRow(
      'documents',
      { entryType: 'future-secret-row', tenantSecret: 'not-returned' },
    )).toEqual({
      classification: 'invalid',
      reasonCode: 'UNRECOGNIZED_DOCUMENT_ROW',
    })
  })

  test('never returns malformed raw identifiers in invalid classifications', () => {
    const result = mapWorkspaceSearchMigrationRow('collaboration', {
      entryType: 'comment',
      entityKey: 'tenant-secret-canary',
      recordKey: 'raw-secret-token',
    })
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      classification: 'invalid',
      reasonCode: 'MALFORMED_COLLABORATION_TARGET',
    })
    expect(serialized).not.toContain('tenant-secret-canary')
    expect(serialized).not.toContain('raw-secret-token')
  })

  test('distinguishes unexpected mapper exceptions from malformed rows', () => {
    const exceptionalComment = createCommentRow()
    Object.defineProperty(exceptionalComment, 'bodyMarkdown', {
      get() {
        throw new Error('unexpected mapper failure')
      },
    })

    expect(
      mapWorkspaceSearchMigrationRow('collaboration', exceptionalComment),
    ).toEqual({
      classification: 'invalid',
      reasonCode: 'MAPPER_EXCEPTION',
    })
  })
})
