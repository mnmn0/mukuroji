import { describe, expect, test } from 'bun:test'
import type { DocumentBlock, DocumentDetail } from '@mukuroji/contracts'
import { diffDocumentBlocks, diffDocumentVersions } from '../src/documents/model/versionDiff'

/**
 * Builds a paragraph block for diff fixtures.
 *
 * @param id - Block ID.
 * @param text - Paragraph text.
 * @returns The paragraph block.
 */
function paragraph(id: string, text: string): DocumentBlock {
  return { id, type: 'paragraph', text }
}

/**
 * Builds a page snapshot for diff fixtures.
 *
 * @param title - Page title.
 * @param blocks - Page blocks.
 * @returns The page snapshot.
 */
function page(title: string, blocks: DocumentBlock[]): DocumentDetail {
  return {
    schemaVersion: 1,
    id: 'doc-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title,
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: true,
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
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    blocks,
  }
}

describe('diffDocumentBlocks', () => {
  test('reports added, removed, changed, and unchanged blocks in the newer order', () => {
    const entries = diffDocumentBlocks(
      [paragraph('a', 'intro'), paragraph('b', 'old scope'), paragraph('c', 'removed')],
      [paragraph('a', 'intro'), paragraph('b', 'new scope'), paragraph('d', 'added')],
    )
    expect(entries.map((entry) => [entry.kind, entry.block.id])).toEqual([
      ['unchanged', 'a'],
      ['changed', 'b'],
      ['removed', 'c'],
      ['added', 'd'],
    ])
    const changed = entries[1]
    expect(changed?.kind === 'changed' ? changed.before : undefined).toEqual(paragraph('b', 'old scope'))
  })

  test('reports a block that left the common order as moved at its new position', () => {
    const entries = diffDocumentBlocks(
      [paragraph('a', '1'), paragraph('b', '2'), paragraph('c', '3')],
      [paragraph('c', '3'), paragraph('a', '1'), paragraph('b', '2')],
    )
    expect(entries.map((entry) => [entry.kind, entry.block.id])).toEqual([
      ['moved', 'c'],
      ['unchanged', 'a'],
      ['unchanged', 'b'],
    ])
  })

  test('ignores object key order when comparing block content', () => {
    const entries = diffDocumentBlocks(
      [{ id: 'h', type: 'heading', level: 2, text: 'Scope' }],
      [{ text: 'Scope', level: 2, type: 'heading', id: 'h' }],
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['unchanged'])
  })
})

describe('diffDocumentVersions', () => {
  test('reports a title change and no changes for identical snapshots', () => {
    const before = page('Spec v1', [paragraph('a', 'body')])
    expect(diffDocumentVersions(before, before)).toMatchObject({ hasChanges: false })
    expect(diffDocumentVersions(before, page('Spec v2', [paragraph('a', 'body')]))).toMatchObject({
      hasChanges: true,
      previousTitle: 'Spec v1',
    })
  })
})
