import type {
  CuratedContextItemKind,
  CuratedContextSource,
} from '@mukuroji/contracts'
import type { DocumentBacklink, DocumentRecord } from '../../documents/api'
import { createDocumentPath } from '../../shared/routing/paths'

/**
 * Human-curated item draft created from a comment, activity event, or related document.
 */
export type IssueContextDraft = {
  /** Suggested semantic category. */
  kind: CuratedContextItemKind
  /** Suggested human-authored title. */
  title: string
  /** Suggested human-authored explanation. */
  body: string
  /** Immutable source provenance resolved and captured by the server on creation. */
  source?: CuratedContextSource
  /** Optional adjacent control that should regain focus when the draft editor closes. */
  returnFocusId?: string
}

/**
 * Creates a source-backed context draft from a production related-document backlink.
 *
 * The Web prepares an editable quote from an already authorized document response. The server
 * independently resolves the same document again before saving canonical provenance.
 *
 * @param backlink - Permission-filtered document backlink adjacent to the Work Item.
 * @param document - Authorized current Document detail used to prepare the quote editor.
 * @returns Empty human-authored draft with resolvable document provenance.
 */
export function createRelatedDocumentContextDraft(
  backlink: DocumentBacklink,
  document: DocumentRecord,
): IssueContextDraft {
  const originalBody = createRelatedDocumentSourceBody(document).slice(
    0,
    20_000,
  )

  return {
    body: '',
    kind: 'context',
    source: {
      availability: 'available',
      capturedRevision: document.revision,
      containerId: backlink.documentId,
      currentRevision: document.revision,
      kind: 'document',
      occurredAt: document.updatedAt,
      ...(originalBody
        ? {
            originalBody,
            quote: {
              endOffset: originalBody.length,
              startOffset: 0,
              text: originalBody,
            },
          }
        : {}),
      permalink: createDocumentPath(backlink.documentId),
      sourceId: backlink.documentId,
    },
    title: '',
  }
}

/**
 * Mirrors the server's permission-safe Document search-body projection for quote selection.
 *
 * @param document - Already authorized Document detail returned to the current viewer.
 * @returns Plain text in the same block and canvas order used by server provenance capture.
 */
export function createRelatedDocumentSourceBody(
  document: DocumentRecord,
): string {
  if (document.kind === 'page' || document.kind === 'template') {
    return document.blocks
      .map((block) => {
        if (block.type === 'paragraph' || block.type === 'heading') {
          return block.text
        }
        if (block.type === 'table') {
          return [
            block.columns.join('\t'),
            ...block.rows.map((row) =>
              row.cells.map((cell) => cell.text).join('\t'),
            ),
          ].join('\n')
        }
        if (block.type === 'code') return block.code
        if (block.type === 'checklist') {
          return block.items.map((item) => item.text).join('\n')
        }
        if (block.type === 'embed') {
          return [block.title, block.provider, block.url]
            .filter((value) => Boolean(value))
            .join('\n')
        }
        return block.source
      })
      .filter((value) => Boolean(value))
      .join('\n')
  }

  if (document.kind === 'whiteboard') {
    return [
      ...document.whiteboard.objects.map((object) =>
        object.type === 'work-item'
          ? object.workItemId
          : object.text ?? '',
      ),
      ...document.whiteboard.connectors.map(
        (connector) => connector.label ?? '',
      ),
      ...document.whiteboard.frames.map((frame) => frame.title),
    ]
      .filter((value) => Boolean(value))
      .join('\n')
  }

  return ''
}
