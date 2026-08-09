import { describe, expect, test } from 'bun:test'
import type { DocumentBacklink } from '../src/documents/api'
import { documentRecordFixture } from '../src/documents/fixtures'
import {
  canSubmitContextEditor,
  createActivityContextSource,
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

  test('bounds long document content at a complete UTF-16 code point', () => {
    const longDocument = {
      ...documentRecordFixture,
      blocks: [
        {
          id: 'block-long',
          text: `${'x'.repeat(19_999)}😀`,
          type: 'paragraph' as const,
        },
      ],
    }
    const draft = createRelatedDocumentContextDraft(
      backlinkFixture,
      longDocument,
    )

    expect(draft.source?.originalBody).toHaveLength(19_999)
    expect(draft.source?.quote?.endOffset).toBe(19_999)
    expect(draft.source?.originalBody?.endsWith('\ud800')).toBeFalse()
  })
})

describe('activity context drafts', () => {
  test('uses the canonical event type when an audit event has no summary', () => {
    const source = createActivityContextSource(
      {
        actorUserId: 'system:workflow',
        eventId: 'event-summaryless',
        eventType: 'work-item.updated',
        occurredAt: '2026-08-09T01:00:00.000Z',
      },
      { id: 'system:workflow', displayName: 'Workflow' },
    )

    expect(source.originalBody).toBe('work-item.updated')
    expect(source.quote).toEqual({
      endOffset: 'work-item.updated'.length,
      startOffset: 0,
      text: 'work-item.updated',
    })
  })
})

describe('context editor authorization', () => {
  test('requires current replacement permission for a create that supersedes an item', () => {
    const capabilities = {
      canCreate: true,
      canEdit: true,
      canReplace: false,
    }

    expect(
      canSubmitContextEditor('create', undefined, capabilities),
    ).toBeTrue()
    expect(
      canSubmitContextEditor('create', 'context-1', capabilities),
    ).toBeFalse()
    expect(
      canSubmitContextEditor('replace', undefined, capabilities),
    ).toBeFalse()
  })
})
