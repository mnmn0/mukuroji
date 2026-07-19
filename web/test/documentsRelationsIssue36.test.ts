import { describe, expect, test } from 'bun:test'
import type {
  DocumentOperation,
  DocumentRelation,
} from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import { applyDocumentOperationsLocally } from '../src/documents/model'
import {
  createCanonicalWorkItemId,
  parseCanonicalWorkItemId,
} from '../src/documents/relations'

describe('Canonical Work Item relation IDs', () => {
  test('round-trips Team and Issue IDs and rejects ambiguous raw IDs', () => {
    const canonical = createCanonicalWorkItemId('team-a', 'issue-42')

    expect(canonical).toBe('team/team-a/issue/issue-42')
    expect(parseCanonicalWorkItemId(canonical!)).toEqual({
      issueId: 'issue-42',
      teamId: 'team-a',
    })
    expect(parseCanonicalWorkItemId('issue-42')).toBeUndefined()
    expect(createCanonicalWorkItemId('team/a', 'issue-42')).toBeUndefined()
  })
})

describe('Document relation operation reducer', () => {
  test('upserts a canonical relation without mutating the document or operation', () => {
    const existingRelation: DocumentRelation = {
      createdAt: '2026-07-18T00:00:00.000Z',
      createdByUserId: 'creator@example.com',
      id: 'relation-1',
      source: { kind: 'document' },
      target: { kind: 'goal', goalId: 'goal-before' },
    }
    const replacementRelation: DocumentRelation = {
      ...existingRelation,
      target: { kind: 'project', projectId: 'project-after' },
    }
    const document = {
      ...documentRecordFixture,
      relations: [existingRelation],
    }
    const operation: DocumentOperation = {
      operationId: 'operation-upsert-relation',
      relation: replacementRelation,
      type: 'upsert-relation',
    }
    const originalDocument = structuredClone(document)
    const originalOperation = structuredClone(operation)

    const updated = applyDocumentOperationsLocally(document, [operation])

    expect(updated.relations).toEqual([replacementRelation])
    expect(document).toEqual(originalDocument)
    expect(operation).toEqual(originalOperation)
  })

  test('deletes a canonical relation without mutating the source document', () => {
    const relation: DocumentRelation = {
      createdAt: '2026-07-18T00:00:00.000Z',
      createdByUserId: 'creator@example.com',
      id: 'relation-delete',
      source: { blockId: 'paragraph-context', kind: 'block' },
      target: { kind: 'work-item', workItemId: 'work-item-1' },
    }
    const document = {
      ...documentRecordFixture,
      relations: [relation],
    }
    const operation: DocumentOperation = {
      operationId: 'operation-delete-relation',
      relationId: relation.id,
      type: 'delete-relation',
    }
    const originalDocument = structuredClone(document)

    const updated = applyDocumentOperationsLocally(document, [operation])

    expect(updated.relations).toEqual([])
    expect(document).toEqual(originalDocument)
  })
})
