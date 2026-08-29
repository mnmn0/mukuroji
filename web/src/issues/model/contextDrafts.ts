import type {
  CuratedContextActorSnapshot,
  CuratedContextItemKind,
  CuratedContextSource,
} from '@mukuroji/contracts'
import type { DocumentBacklink, DocumentRecord } from '../../documents/api'
import { createDocumentPath } from '../../shared/routing/paths'
import type { TeamIssueActivityEvent } from '../api/activity'

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
 * Checks the synchronous adoption fence for a feature-owned Brief assistant.
 *
 * @param activeSessionKey - Current source-and-revision key in the panel.
 * @param expectedSessionKey - Key captured by the assistant that raised the event.
 * @param currentDraft - Whether an existing human-owned draft occupies the editor.
 * @returns Whether the adoption may open a new local draft.
 */
export function isAiSummaryAdoptionCurrent(
  activeSessionKey: string | undefined,
  expectedSessionKey: string | undefined,
  currentDraft: IssueContextDraft | undefined,
): boolean {
  return activeSessionKey === expectedSessionKey && currentDraft === undefined
}

/**
 * Checks the latest capability snapshot before a context editor submits.
 *
 * Evidence-backed creates require replacement permission only after the curator selects
 * an existing item to supersede. Edit and replace sessions use their dedicated capability.
 *
 * @param mode - Mutation mode owned by the open editor.
 * @param supersedesItemId - Optional existing item selected by a create session.
 * @param capabilities - Latest context mutation capabilities from the server.
 * @returns Whether the current editor operation may be submitted.
 */
export function canSubmitContextEditor(
  mode: 'create' | 'edit' | 'replace',
  supersedesItemId: string | undefined,
  capabilities: {
    canCreate: boolean
    canEdit: boolean
    canReplace: boolean
  },
): boolean {
  if (mode === 'create') {
    return (
      capabilities.canCreate &&
      (!supersedesItemId || capabilities.canReplace)
    )
  }
  return mode === 'edit'
    ? capabilities.canEdit
    : capabilities.canReplace
}

/**
 * Creates canonical activity provenance for a human-curated draft.
 *
 * Summary-less audit events use their stable event type, matching the server-side capture
 * fallback and ensuring the quote always describes the source that will be persisted.
 *
 * @param event - Permission-filtered audit event promoted by the viewer.
 * @param actor - Resolved actor snapshot shown with the provenance.
 * @returns Activity source with a continuous full-body quote.
 */
export function createActivityContextSource(
  event: TeamIssueActivityEvent,
  actor: CuratedContextActorSnapshot,
): CuratedContextSource {
  const originalBody = event.summary?.trim() || event.eventType

  return {
    actor,
    availability: 'available',
    kind: 'activity',
    occurredAt: event.occurredAt,
    originalBody,
    permalink: `?activityEventId=${encodeURIComponent(event.eventId)}`,
    quote: {
      endOffset: originalBody.length,
      startOffset: 0,
      text: originalBody,
    },
    sourceId: event.eventId,
  }
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
  const originalBody = truncateToUtf16Boundary(
    createRelatedDocumentSourceBody(document),
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
 * Truncates text by UTF-16 code units without leaving a dangling surrogate.
 *
 * @param value - Source text to bound.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns Text no longer than the requested limit and safe to render.
 */
function truncateToUtf16Boundary(value: string, maximumLength: number): string {
  const truncated = value.slice(0, maximumLength)
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated
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
