import { useRef, useState } from 'react'
import type {
  DocumentRelation,
  DocumentRelationTarget,
  DocumentScope,
} from '@mukuroji/contracts'
import {
  createMutationRequestContext,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import {
  applyDocumentOperations,
  createDocument,
  getDocument,
} from '../api'
import { createDocumentOperationId } from '../model/document'

/**
 * Why creating a linked Document failed.
 *
 * `create` means nothing was written; `link` means the page exists but is not
 * linked to the target.
 */
export type RelatedDocumentCreateError = 'create' | 'link'

/**
 * Request identity kept for one logical link until it succeeds, so a retry
 * after a lost response replays the same operation instead of adding a second
 * relation.
 */
type PendingLink = {
  /** Relation sent with the operation. */
  relation: DocumentRelation
  /** Operation ID the server uses to recognize a replay. */
  operationId: string
  /** Client ID sent with the operation batch. */
  clientId: string
  /** Idempotency context shared by every attempt. */
  context: MutationRequestContext
}

/**
 * Request identity kept for one logical page creation until it is linked.
 */
type PendingCreate = {
  /** Normalized title the page is created with. */
  title: string
  /** Idempotency context shared by every create attempt. */
  context: MutationRequestContext
  /** Created page, once the server confirmed it. */
  documentId?: string
}

/**
 * Options for linking Documents to one Work Item, Project, or Goal.
 */
export type UseRelatedDocumentLinksOptions = {
  /** Workspace API token; omission disables every action. */
  accessToken?: string
  /** Target the Documents link to; omission disables every action. */
  target?: DocumentRelationTarget
  /** Refreshes every cache that lists Documents linked to the target. */
  onChanged: () => Promise<unknown>
}

/**
 * Links existing Documents to a target and creates new pages linked to it.
 *
 * @param options - Token, target, and the cache refresh to run after a change.
 * @returns Link and create actions and the create form's mutation state.
 */
export function useRelatedDocumentLinks({
  accessToken,
  onChanged,
  target,
}: UseRelatedDocumentLinksOptions) {
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] =
    useState<RelatedDocumentCreateError>()
  const pendingLinksRef = useRef(new Map<string, PendingLink>())
  const pendingCreateRef = useRef<PendingCreate | undefined>(undefined)
  const targetKey = target === undefined
    ? undefined
    : JSON.stringify(target)

  /**
   * Returns the request identity for linking one Document, reusing the one
   * from an earlier failed attempt.
   *
   * @param documentId - Document that should link to the target.
   * @param currentTarget - Target the Document links to.
   * @returns Relation, operation, and idempotency identity for the attempt.
   */
  const readPendingLink = (
    documentId: string,
    currentTarget: DocumentRelationTarget,
  ): PendingLink => {
    const key = `${targetKey}\0${documentId}`
    const existing = pendingLinksRef.current.get(key)
    if (existing) return existing
    const pending: PendingLink = {
      clientId: createDocumentOperationId(),
      context: createMutationRequestContext(),
      operationId: createDocumentOperationId(),
      relation: {
        createdAt: new Date().toISOString(),
        createdByUserId: 'current-user',
        id: createDocumentOperationId(),
        source: { kind: 'document' },
        target: currentTarget,
      },
    }
    pendingLinksRef.current.set(key, pending)
    return pending
  }

  /**
   * Adds a Document-level relation from one Document to the target.
   *
   * @param documentId - Document that should link to the target.
   */
  const linkDocument = async (documentId: string) => {
    if (!accessToken || !target) return
    const pending = readPendingLink(documentId, target)
    const document = await getDocument(accessToken, documentId)
    await applyDocumentOperations(
      accessToken,
      documentId,
      {
        baseRevision: document.revision,
        clientId: pending.clientId,
        operations: [{
          operationId: pending.operationId,
          relation: pending.relation,
          type: 'upsert-relation',
        }],
      },
      pending.context,
    )
    pendingLinksRef.current.delete(`${targetKey}\0${documentId}`)
    await onChanged()
  }

  /**
   * Creates an empty page in the target's scope and links it to the target.
   *
   * @param title - Title of the new page.
   * @returns Whether the page was created and linked.
   */
  const createLinkedDocument = async (title: string) => {
    const normalizedTitle = title.trim()
    if (!accessToken || !target || !normalizedTitle || isCreating) {
      return false
    }
    setIsCreating(true)
    setCreateError(undefined)
    const previous = pendingCreateRef.current
    const pending: PendingCreate =
      previous?.title === normalizedTitle
        ? previous
        : { context: createMutationRequestContext(), title: normalizedTitle }
    pendingCreateRef.current = pending
    let createdDocumentId = pending.documentId
    try {
      if (createdDocumentId === undefined) {
        const scope: DocumentScope = target.kind === 'project'
          ? { type: 'project', projectId: target.projectId }
          : { type: 'workspace' }
        // The same idempotency key returns the first page after a lost response.
        const document = await createDocument(
          accessToken,
          { blocks: [], kind: 'page', scope, title: normalizedTitle },
          pending.context,
        )
        createdDocumentId = document.id
        pending.documentId = document.id
      }
      await linkDocument(createdDocumentId)
      pendingCreateRef.current = undefined
      return true
    } catch {
      // A page that was created but not linked stays visible from Documents.
      setCreateError(createdDocumentId === undefined ? 'create' : 'link')
      if (createdDocumentId !== undefined) await onChanged()
      return false
    } finally {
      setIsCreating(false)
    }
  }

  return {
    createError,
    createLinkedDocument,
    isCreating,
    linkDocument,
  }
}
