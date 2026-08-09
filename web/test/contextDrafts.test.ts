import { describe, expect, test } from 'bun:test'
import type { DocumentBacklink } from '../src/documents/api'
import { documentRecordFixture } from '../src/documents/fixtures'
import {
  createRelatedDocumentContextDraft,
  createRelatedDocumentSourceBody,
} from '../src/issues/model/contextDrafts'

const backlinkFixture = {
  documentId: documentRecordFixture.id,
  documentTitle: documentRecordFixture.title,
  relation: {
    createdAt: '2026-08-09T00:30:00.000Z',
    createdByUserId: 'demo-user',
    id: 'relation-document-context',
    source: { kind: 'document' },
    target: { kind: 'work-item', workItemId: 'work-item-one' },
  },
} satisfies DocumentBacklink

describe('related Document context drafts', () => {
  test('projects authorized block content into a selectable continuous quote', () => {
    const originalBody = createRelatedDocumentSourceBody(
      documentRecordFixture,
    )
    const draft = createRelatedDocumentContextDraft(
      backlinkFixture,
      documentRecordFixture,
    )

    expect(originalBody).toContain('Context before execution')
    expect(originalBody).toContain('Quiet progress\tShow the next decision')
    expect(draft.source?.originalBody).toBe(originalBody)
    expect(draft.source?.quote).toEqual({
      endOffset: originalBody.length,
      startOffset: 0,
      text: originalBody,
    })
    expect(draft.source?.capturedRevision).toBe(
      documentRecordFixture.revision,
    )
  })
})
