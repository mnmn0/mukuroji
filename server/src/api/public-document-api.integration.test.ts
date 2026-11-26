import { afterEach, describe, expect, test } from 'bun:test'
import { DOCUMENT_SCHEMA_VERSION, type DocumentDetail } from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicDocumentService } from './shared/public-document-access'
import { DocumentError, type DocumentAccessContext, type DocumentClient } from '../modules/documents'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'

const {
  configureFakeProjectClients,
  createDocumentFake,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'user#demo@example.com'
const NOW = '2026-07-18T00:00:00.000Z'
const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId,
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read'],
}

/**
 * Creates a page Document that links the given Work Item relation targets.
 *
 * @param id - Document ID.
 * @param linkedWorkItemIds - Relation target IDs of the linked Work Items.
 * @param kind - Document kind.
 * @returns Document snapshot as the Documents store returns it to a viewer.
 */
function createLinkedDocument(
  id: string,
  linkedWorkItemIds: string[],
  kind: 'page' | 'whiteboard' = 'page',
): DocumentDetail {
  const base = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id,
    scope: { type: 'workspace' as const },
    title: `Spec ${id}`,
    position: 'a0',
    revision: 4,
    permission: { mode: 'inherit' as const, memberGrants: [] },
    relations: linkedWorkItemIds.map((workItemId, index) => ({
      id: `relation-${index}`,
      source: { kind: 'document' as const },
      target: { kind: 'work-item' as const, workItemId },
      createdByUserId: 'demo@example.com',
      createdAt: NOW,
    })),
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: false,
      canComment: false,
      canShare: false,
      canManagePermissions: false,
      canArchive: false,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'demo@example.com',
    updatedByUserId: 'demo@example.com',
    createdAt: NOW,
    updatedAt: NOW,
  }
  return kind === 'page'
    ? { ...base, kind, blocks: [{ id: 'heading-1', type: 'heading', level: 1, text: 'Acceptance' }, { id: 'paragraph-1', type: 'paragraph', text: 'Ship the export.' }] }
    : { ...base, kind, whiteboard: { objects: [], connectors: [], frames: [] } }
}

/**
 * Creates a whiteboard that links a Work Item only through a Work Item card.
 *
 * @param id - Document ID.
 * @param workItemId - Relation target ID of the Work Item on the card.
 * @returns Whiteboard snapshot without explicit relations.
 */
function createCardWhiteboard(id: string, workItemId: string): DocumentDetail {
  const board = createLinkedDocument(id, [], 'whiteboard')
  if (board.kind !== 'whiteboard') throw new Error('Expected a whiteboard fixture.')
  return {
    ...board,
    whiteboard: {
      ...board.whiteboard,
      objects: [{ id: 'card-1', type: 'work-item', workItemId, bounds: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0 }],
    },
  }
}

describe('public Document service', () => {
  test('lists linked Documents with the credential owner\'s current Document access', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const accesses: DocumentAccessContext[] = []
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async listBacklinks(input) {
          accesses.push(input.access)
          expect(input).toMatchObject({
            workspaceId, targetKind: 'work-item', targetId: 'team/core-team/issue/task-1', limit: 20,
          })
          const relation = createLinkedDocument('document-1', ['team/core-team/issue/task-1']).relations[0]
          if (relation === undefined) throw new Error('Expected a relation fixture.')
          return {
            backlinks: [
              { documentId: 'document-1', documentTitle: 'Spec', documentKind: 'page', relation },
              { documentId: 'document-1', documentTitle: 'Spec', documentKind: 'page', relation: { ...relation, id: 'relation-9' } },
            ],
            nextCursor: 'next',
          }
        },
      }),
    })

    const page = await runWithTestAppDependencies(() => createCanonicalPublicDocumentService()
      .listWorkItemDocuments(credential, 'core-team', 'task-1', undefined, 20))

    expect(page).toEqual({ items: [{ id: 'document-1', title: 'Spec' }], hasMore: true, nextContinuation: 'next' })
    expect(accesses).toHaveLength(1)
    expect(accesses[0]).toMatchObject({ memberKey: 'demo@example.com', workspaceRole: 'member', isSystemAdmin: false })
    expect(accesses[0]?.projectRoles).toEqual({ refero: 'viewer' })
  })

  test('refuses to list Documents of a Work Item the credential owner cannot view', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'other-project', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    let listed = false
    setTestAppDependencies({
      documents: createDocumentFake({
        async listBacklinks() {
          listed = true
          return { backlinks: [] }
        },
      }),
    })

    await expect(runWithTestAppDependencies(() => createCanonicalPublicDocumentService()
      .listWorkItemDocuments(credential, 'core-team', 'task-1', undefined, 20))).rejects.toMatchObject({ status: 403 })
    expect(listed).toBe(false)
  })

  test('reads a linked page as Markdown and hides unlinked, invisible, and non-page Documents', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const documents = new Map<string, DocumentDetail>([
      ['linked', createLinkedDocument('linked', ['team/core-team/issue/task-1'])],
      ['other-task', createLinkedDocument('other-task', ['team/core-team/issue/task-2'])],
      ['board', createLinkedDocument('board', ['team/core-team/issue/task-1'], 'whiteboard')],
      ['card-board', createCardWhiteboard('card-board', 'team/core-team/issue/task-1')],
      ['other-card-board', createCardWhiteboard('other-card-board', 'team/core-team/issue/task-2')],
    ])
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async get(input) {
          expect(input.access.memberKey).toBe('demo@example.com')
          const document = documents.get(input.documentId)
          if (document === undefined) throw new DocumentError(403, 'DocumentViewDenied', 'Document access denied.')
          return document
        },
      }),
    })
    const service = createCanonicalPublicDocumentService()
    /**
     * Reads one fixture Document through Work Item task-1.
     *
     * @param documentId - Document ID.
     * @returns The Document content.
     */
    const read = (documentId: string) => runWithTestAppDependencies(() => service.getWorkItemDocument(
      credential, 'core-team', 'task-1', documentId,
    ))

    expect(await read('linked')).toEqual({
      schemaVersion: 1,
      id: 'linked',
      kind: 'page',
      title: 'Spec linked',
      revision: 4,
      updatedAt: NOW,
      format: 'markdown',
      content: expect.stringContaining('Ship the export.'),
    })
    await expect(read('other-task')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(read('hidden')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(read('board')).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    // A whiteboard that links the task only through a Work Item card is still linked, so it is unsupported, not missing.
    await expect(read('card-board')).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    await expect(read('other-card-board')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  test('hides every Document from an owner whose Enterprise role grants Work Items but no Document permission', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const identity = new InMemoryEnterpriseIdentityClient()
    const readSnapshot = identity.getSnapshot.bind(identity)
    identity.getSnapshot = async (requestedWorkspaceId) => ({
      ...await readSnapshot(requestedWorkspaceId),
      customRoles: [{
        workspaceId,
        roleId: 'custom:work-items-only',
        name: 'Work Items only',
        permissions: ['work-items.read'],
        guestAssignable: false,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      roleAssignments: [{
        workspaceId,
        assignmentId: 'work-items-only',
        principalKind: 'member',
        principalId: 'demo@example.com',
        roleId: 'custom:work-items-only',
        scope: { workspaceId, kind: 'workspace' },
        source: 'direct',
      }],
    })
    let documentsRead = false
    setTestAppDependencies({
      enterpriseIdentity: identity,
      documents: createDocumentFake({
        async listBacklinks() {
          documentsRead = true
          return { backlinks: [] }
        },
        async get() {
          documentsRead = true
          return createLinkedDocument('linked', ['team/core-team/issue/task-1'])
        },
      }),
    })
    const service = createCanonicalPublicDocumentService()

    expect(await runWithTestAppDependencies(() => service
      .listWorkItemDocuments(credential, 'core-team', 'task-1', undefined, 20))).toEqual({ items: [], hasMore: false })
    await expect(runWithTestAppDependencies(() => service.getWorkItemDocument(
      credential, 'core-team', 'task-1', 'linked',
    ))).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(documentsRead).toBe(false)
  })

  test('creates a Project page from Markdown that links a Work Item the owner can view', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
      role: 'member',
      workspaceRole: 'member',
    })
    const created: Parameters<DocumentClient['create']>[0][] = []
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async create(input) {
          created.push(input)
          const document = createLinkedDocument('doc-new', ['team/core-team/issue/task-1'])
          return { ...document, title: input.title, scope: input.scope, revision: 1, ...(input.blocks === undefined ? {} : { blocks: input.blocks }) }
        },
      }),
    })

    const result = await runWithTestAppDependencies(() => createCanonicalPublicDocumentService().createDocument(
      { ...credential, scopes: ['work-items:write'] },
      {
        title: 'Plan',
        content: '# Plan\n\n## Goals\n\n- [ ] Ship\n\nSee **notes**.',
        projectId: 'refero',
        workItem: { teamId: 'core-team', workItemId: 'task-1' },
      },
      { requestId: 'request-1', idempotencyKey: 'key-1' },
    ))

    expect(created).toHaveLength(1)
    const input = created[0]
    expect(input).toMatchObject({ workspaceId, kind: 'page', scope: { type: 'project', projectId: 'refero' }, title: 'Plan' })
    expect(input?.access.authorizationSnapshots?.[0]).toMatchObject({ workspaceId, workspaceMemberKey: 'demo@example.com' })
    expect(input?.blocks?.map((block) => block.type)).toEqual(['heading', 'checklist', 'paragraph'])
    expect(input?.relations?.map(({ target }) => target)).toEqual([{ kind: 'work-item', workItemId: 'team/core-team/issue/task-1' }])
    expect(input?.idempotencyKey).toMatch(/^public-api:[0-9a-f]{64}$/u)
    expect(input?.auditContext).toBeDefined()
    expect(result).toMatchObject({ id: 'doc-new', kind: 'page', title: 'Plan', revision: 1 })
    expect(result).not.toHaveProperty('content')
  })

  test('answers a retried creation of a page edited since with the page as it was created', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
      role: 'member',
      workspaceRole: 'member',
    })
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async create(input) {
          // The store finds the page an earlier attempt created, which another writer changed.
          return { ...createLinkedDocument('doc-new', []), title: 'Renamed', scope: input.scope, revision: 4 }
        },
      }),
    })

    const result = await runWithTestAppDependencies(() => createCanonicalPublicDocumentService().createDocument(
      { ...credential, scopes: ['work-items:write'] },
      { title: ' Plan ', content: 'Body', projectId: 'refero' },
      { requestId: 'request-1', idempotencyKey: 'key-1' },
    ))

    expect(result).toEqual({ id: 'doc-new', kind: 'page', title: 'Plan', scope: { type: 'project', projectId: 'refero' }, revision: 1 })
  })

  test('refuses a Project page from a viewer and a link to a Work Item the owner cannot view', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    let created = false
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async create() {
          created = true
          throw new Error('not reached')
        },
      }),
    })
    const service = createCanonicalPublicDocumentService()
    const writer = { ...credential, scopes: ['work-items:write' as const] }

    await expect(runWithTestAppDependencies(() => service.createDocument(writer, {
      title: 'Plan', content: 'Body', projectId: 'refero',
    }, { requestId: 'request-1', idempotencyKey: 'key-1' }))).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(runWithTestAppDependencies(() => service.createDocument(writer, {
      title: 'Plan', content: 'Body', workItem: { teamId: 'missing-team', workItemId: 'task-1' },
    }, { requestId: 'request-2', idempotencyKey: 'key-2' }))).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    expect(created).toBe(false)
  })

  test('replaces a page body from Markdown and hides a Document the owner cannot view', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
      role: 'member',
      workspaceRole: 'member',
    })
    const replaced: Parameters<DocumentClient['replaceContent']>[0][] = []
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 1
        },
        async get(input) {
          if (input.documentId === 'linked') return createLinkedDocument('linked', [])
          throw new DocumentError(403, 'DocumentViewDenied', 'Document access denied.')
        },
        async replaceContent(input) {
          // The store reports a hidden Document as an edit denial; the service must not.
          if (input.documentId !== 'linked') throw new DocumentError(403, 'DocumentEditDenied', 'Document edit denied.')
          if (input.expectedRevision !== 4) throw new DocumentError(409, 'DocumentRevisionConflict', 'The document changed after it was read.')
          replaced.push(input)
          const document = createLinkedDocument('linked', [])
          return { ...document, revision: 5, ...(input.blocks === undefined ? {} : { blocks: input.blocks }) }
        },
      }),
    })
    const service = createCanonicalPublicDocumentService()
    const writer = { ...credential, scopes: ['work-items:write' as const] }
    const context = { requestId: 'request-1', idempotencyKey: 'key-1' }

    const result = await runWithTestAppDependencies(() => service.updateDocument(writer, 'linked', {
      expectedRevision: 4, content: '# Spec linked\n\n## Scope\n\nNew body.',
    }, context))
    await expect(runWithTestAppDependencies(() => service.updateDocument(writer, 'hidden', {
      expectedRevision: 4, title: 'Renamed',
    }, context))).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(runWithTestAppDependencies(() => service.updateDocument(writer, 'linked', {
      expectedRevision: 3, title: 'Renamed',
    }, context))).rejects.toMatchObject({ status: 409, code: 'conflict' })

    expect(replaced).toHaveLength(1)
    expect(replaced[0]?.blocks?.map((block) => block.type === 'heading' ? `h${block.level} ${block.text}` : block.type)).toEqual(['h1 Scope', 'paragraph'])
    expect(result).toMatchObject({ id: 'linked', revision: 5 })
    // Without a title, the leading # heading names the Document instead of being dropped.
    expect(replaced[0]?.title).toBe('Spec linked')
    expect(replaced[0]?.idempotencyKey).toMatch(/^public-api:[0-9a-f]{64}$/u)
    expect(replaced[0]?.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/u)
  })
})
