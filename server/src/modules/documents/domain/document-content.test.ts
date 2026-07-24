import { expect, test } from 'bun:test'
import type { DocumentDetail } from '@mukuroji/contracts'
import { DocumentError } from '../errors'
import {
  collectDocumentRelationTargets,
  reduceDocumentOperations,
  renderDocumentExport,
  validateDocumentPayload,
} from './document-content'

test('reduces independent stale-base operations without mutating the input snapshot', () => {
  const original = createPage({ revision: 2 })
  const reduced = reduceDocumentOperations({
    document: original,
    elementRevisions: {
      'block:block-a': 1,
      'block:block-b': 1,
    },
    baseRevision: 1,
    nextRevision: 3,
    operations: [
      {
        type: 'update-block',
        operationId: 'operation-a',
        blockId: 'block-a',
        block: {
          id: 'block-a',
          type: 'paragraph',
          text: 'A2',
        },
      },
      {
        type: 'update-block',
        operationId: 'operation-b',
        blockId: 'block-b',
        block: {
          id: 'block-b',
          type: 'paragraph',
          text: 'B2',
        },
      },
    ],
  })

  expect(original.blocks[0]).toMatchObject({
    id: 'block-a',
    type: 'paragraph',
    text: 'A1',
  })
  expect(original.blocks[1]).toMatchObject({
    id: 'block-b',
    type: 'paragraph',
    text: 'B1',
  })
  expect(reduced.document.revision).toBe(3)
  expect(reduced.document.kind).toBe('page')
  if (reduced.document.kind !== 'page') {
    throw new Error('Expected the reduced document to remain a page.')
  }
  expect(reduced.document.blocks[0]).toMatchObject({
    id: 'block-a',
    text: 'A2',
  })
  expect(reduced.document.blocks[1]).toMatchObject({
    id: 'block-b',
    text: 'B2',
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

test('rejects malformed document payloads with domain errors', () => {
  const missingBlocks = createPage()
  Reflect.deleteProperty(missingBlocks, 'blocks')
  const duplicateRelations = createPage({
    relations: [
      createRelation('relation-1'),
      createRelation('relation-1'),
    ],
  })
  const invalidRevision = createPage({ revision: 0 })
  const oversizedPosition = createPage({
    position: 'a'.repeat(1_001),
  })

  for (const document of [
    missingBlocks,
    duplicateRelations,
    invalidRevision,
    oversizedPosition,
  ]) {
    expect(() =>
      validateDocumentPayload(document)
    ).toThrow(DocumentError)
  }
})

test('rejects slash and backslash protocol-relative embed URLs', () => {
  for (const url of [
    '//evil.example/path',
    '/\\evil.example/path',
  ]) {
    const page = createPage({
      blocks: [{
        id: 'embed-1',
        type: 'embed',
        url,
      }],
    })

    expect(() =>
      validateDocumentPayload(page)
    ).toThrow(DocumentError)
  }
})

/**
 * Creates a valid relation for payload validation tests.
 *
 * @param id - Stable relation identifier.
 * @returns A valid document relation.
 */
function createRelation(
  id: string,
): DocumentDetail['relations'][number] {
  return {
    id,
    source: { kind: 'document' },
    target: {
      kind: 'work-item',
      workItemId:
        'team/team-1/issue/issue-1',
    },
    createdByUserId: 'owner@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
  }
}

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
