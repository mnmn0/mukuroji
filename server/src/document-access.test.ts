import { expect, test } from 'bun:test'
import type { DocumentDetail, DocumentPermission, DocumentScope } from '@mukuroji/contracts'
import { resolveDocumentCapabilities } from './document-access'

test('maps inherited Workspace and Project roles to Document capabilities', () => {
  const workspaceDocument = createPage()
  const projectDocument = createPage({
    scope: { type: 'project', projectId: 'project-1' },
  })

  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'member@example.com',
      workspaceRole: 'member',
      isSystemAdmin: false,
    },
    document: workspaceDocument,
  })).toMatchObject({
    canView: true,
    canEdit: true,
    canManagePermissions: false,
  })
  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'member@example.com',
      workspaceRole: 'member',
      isSystemAdmin: false,
    },
    document: projectDocument,
    projectRole: 'viewer',
  })).toMatchObject({
    canView: true,
    canEdit: false,
  })
  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'member@example.com',
      workspaceRole: 'member',
      isSystemAdmin: false,
    },
    document: projectDocument,
    projectRole: 'manager',
  })).toMatchObject({
    canEdit: true,
    canManagePermissions: true,
  })
})

test('caps an explicitly shared guest at read-only access', () => {
  const document = createPage({
    permission: {
      mode: 'inherit',
      memberGrants: [{ memberKey: 'guest@example.com', role: 'editor' }],
    },
  })

  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'guest@example.com',
      workspaceRole: 'guest',
      isSystemAdmin: false,
    },
    document,
  })).toEqual({
    canView: true,
    canEdit: false,
    canComment: false,
    canShare: false,
    canManagePermissions: false,
    canArchive: false,
    canRestore: false,
    canExport: true,
  })
})

test('does not retain creator access after Project membership is removed', () => {
  const document = createPage({
    scope: { type: 'project', projectId: 'project-1' },
    createdByUserId: 'former-member@example.com',
  })

  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'former-member@example.com',
      workspaceRole: 'member',
      isSystemAdmin: false,
    },
    document,
  })).toEqual(deniedCapabilities)
})

test('stops inherited access at a private ancestor without leaking to Workspace admins', () => {
  const document = createPage()
  const privateFolder = createFolder({
    id: 'folder-1',
    permission: {
      mode: 'private',
      memberGrants: [],
    },
  })

  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'admin@example.com',
      workspaceRole: 'admin',
      isSystemAdmin: false,
    },
    document,
    ancestors: [privateFolder],
  }).canView).toBe(false)
  expect(resolveDocumentCapabilities({
    principal: {
      memberKey: 'system@example.com',
      workspaceRole: 'member',
      isSystemAdmin: true,
    },
    document,
    ancestors: [privateFolder],
  }).canManagePermissions).toBe(true)
})

test('keeps archived Documents readable while only allowing restore', () => {
  const document = createPage({
    archivedAt: '2026-07-18T02:00:00.000Z',
    createdByUserId: 'owner@example.com',
  })
  const capabilities = resolveDocumentCapabilities({
    principal: {
      memberKey: 'owner@example.com',
      workspaceRole: 'owner',
      isSystemAdmin: false,
    },
    document,
  })

  expect(capabilities).toMatchObject({
    canView: true,
    canEdit: false,
    canComment: false,
    canShare: false,
    canManagePermissions: false,
    canArchive: false,
    canRestore: true,
  })
})

function createPage(
  overrides: Partial<DocumentDetail> & {
    permission?: DocumentPermission
    scope?: DocumentScope
  } = {},
): DocumentDetail {
  return {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Document',
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: deniedCapabilities,
    createdByUserId: 'creator@example.com',
    updatedByUserId: 'creator@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [],
    ...overrides,
  } as DocumentDetail
}

function createFolder(
  overrides: Partial<DocumentDetail> & {
    permission?: DocumentPermission
    scope?: DocumentScope
  } = {},
): DocumentDetail {
  return {
    schemaVersion: 1,
    id: 'folder',
    kind: 'folder',
    scope: { type: 'workspace' },
    title: 'Folder',
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: deniedCapabilities,
    childCount: 0,
    createdByUserId: 'creator@example.com',
    updatedByUserId: 'creator@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  } as DocumentDetail
}

const deniedCapabilities = {
  canView: false,
  canEdit: false,
  canComment: false,
  canShare: false,
  canManagePermissions: false,
  canArchive: false,
  canRestore: false,
  canExport: false,
} as const
