import { useState } from 'react'
import type {
  DocumentRelation,
  DocumentRelationTarget,
  DocumentScope,
} from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
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

  /**
   * Adds a Document-level relation from one Document to the target.
   *
   * @param documentId - Document that should link to the target.
   */
  const linkDocument = async (documentId: string) => {
    if (!accessToken || !target) return
    const document = await getDocument(accessToken, documentId)
    const relation: DocumentRelation = {
      createdAt: new Date().toISOString(),
      createdByUserId: 'current-user',
      id: createDocumentOperationId(),
      source: { kind: 'document' },
      target,
    }
    await applyDocumentOperations(
      accessToken,
      documentId,
      {
        baseRevision: document.revision,
        clientId: createDocumentOperationId(),
        operations: [{
          operationId: createDocumentOperationId(),
          relation,
          type: 'upsert-relation',
        }],
      },
      createMutationRequestContext(),
    )
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
    let createdDocumentId: string | undefined
    try {
      const scope: DocumentScope = target.kind === 'project'
        ? { type: 'project', projectId: target.projectId }
        : { type: 'workspace' }
      const document = await createDocument(
        accessToken,
        { blocks: [], kind: 'page', scope, title: normalizedTitle },
        createMutationRequestContext(),
      )
      createdDocumentId = document.id
      await linkDocument(document.id)
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
