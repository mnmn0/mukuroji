import { expect, test } from 'bun:test'
import type { DocumentDetail } from '@mukuroji/contracts'
import {
  collectDocumentRelationTargets,
  reduceDocumentOperations,
  renderDocumentExport,
  validateDocumentPayload,
} from './document-content'

test('reduces independent stale-base operations without mutating the input snapshot', () => {
  const original = createPage()
  const reduced = reduceDocumentOperations({
    document: original,
    elementRevisions: {
      'block:block-a': 1,
      'block:block-b': 1,
    },
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      type: 'update-block',
      operationId: 'operation-a',
      blockId: 'block-a',
      block: {
        id: 'block-a',
        type: 'paragraph',
        text: 'A2',
      },
    }],
  })

  expect(original.blocks[0]?.text).toBe('A1')
  expect(reduced.document.revision).toBe(2)
  expect(reduced.document.blocks[0]).toMatchObject({
    id: 'block-a',
    text: 'A2',
  })
})

test('validates, renders, and collects relations without AWS or Hono dependencies', () => {
  const page = createPage({
    relations: [{
      id: 'relation-1',
      source: { kind: 'document' },
      target: {
        kind: 'work-item',
        workItemId: 'team/team-1/issue/issue-1',
      },
      createdByUserId: 'owner@example.com',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
  })

  expect(() => validateDocumentPayload(page)).not.toThrow()
  expect(renderDocumentExport(page, 'markdown').content).toContain('# Document')
  expect(collectDocumentRelationTargets(page)).toEqual([{
    kind: 'work-item',
    workItemId: 'team/team-1/issue/issue-1',
  }])
})

/**
 * Creates a valid page snapshot for pure domain tests.
 *
 * @param overrides - Fields to replace in the canonical fixture.
 * @returns A valid page document.
 */
function createPage(
  overrides: Partial<Extract<DocumentDetail, { kind: 'page' }>> = {},
): Extract<DocumentDetail, { kind: 'page' }> {
  return {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Document',
    position: 'a',
    revision: 1,
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
    createdByUserId: 'owner@example.com',
    updatedByUserId: 'owner@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [
      { id: 'block-a', type: 'paragraph', text: 'A1' },
      { id: 'block-b', type: 'paragraph', text: 'B1' },
    ],
    ...structuredClone(overrides),
  }
}
