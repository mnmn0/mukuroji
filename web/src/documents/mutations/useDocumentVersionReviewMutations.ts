import { useRef } from 'react'
import { useSWRConfig } from 'swr'
import type { CreateDocumentVersionApprovalInput } from '@mukuroji/contracts'
import {
  createMutationRequestContext,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { pinDocumentVersion, requestDocumentVersionApproval } from '../api/versions'

/**
 * Request identity kept for one logical mutation until it succeeds, so a retry after a lost
 * response replays the same request instead of creating a second approval.
 */
type PendingRequest = {
  /** Serialized input the context belongs to. */
  fingerprint: string
  /** Idempotency context shared by every attempt. */
  context: MutationRequestContext
}

/**
 * Pins Document versions and requests their approval, then refreshes the version history and
 * the approvals shown for the Document.
 *
 * @param accessToken - Documents API token.
 * @param documentId - Document whose versions are reviewed.
 * @returns Mutations for pinning a version and requesting its approval.
 */
export function useDocumentVersionReviewMutations(
  accessToken: string | undefined,
  documentId: string,
) {
  const { mutate } = useSWRConfig()
  const pendingRef = useRef(new Map<string, PendingRequest>())

  /**
   * Reuses the idempotency context of an unfinished request with the same input.
   *
   * @param key - Logical mutation key.
   * @param fingerprint - Serialized input.
   * @returns The context to send.
   */
  const resolveContext = (key: string, fingerprint: string) => {
    const pending = pendingRef.current.get(key)
    if (pending?.fingerprint === fingerprint) return pending.context
    const context = createMutationRequestContext()
    pendingRef.current.set(key, { fingerprint, context })
    return context
  }

  /**
   * Refreshes every cached version history, version detail, and approval list of the Document.
   */
  const refresh = async () => {
    await mutate(
      (key) =>
        Array.isArray(key) &&
        (
          key[0] === 'document-versions' ||
          key[0] === 'document-version-detail' ||
          key[0] === 'document-approvals'
        ) &&
        key[2] === documentId,
    )
  }

  /**
   * Names a version and keeps it beyond the retention period.
   *
   * @param versionId - Version to pin.
   * @param name - Name of the pinned version.
   */
  const pinVersion = async (versionId: string, name: string) => {
    if (!accessToken) throw new Error('Missing access token.')
    const key = `pin:${versionId}`
    const context = resolveContext(key, name)
    await pinDocumentVersion(accessToken, documentId, versionId, name, context)
    pendingRef.current.delete(key)
    await refresh()
  }

  /**
   * Requests approval of a pinned version on a Work Item.
   *
   * @param versionId - Pinned version to approve.
   * @param input - Work Item, reviewers, and due date.
   */
  const requestApproval = async (versionId: string, input: CreateDocumentVersionApprovalInput) => {
    if (!accessToken) throw new Error('Missing access token.')
    const key = `approval:${versionId}`
    const context = resolveContext(key, JSON.stringify(input))
    await requestDocumentVersionApproval(accessToken, documentId, versionId, input, context)
    pendingRef.current.delete(key)
    await refresh()
  }

  return { pinVersion, requestApproval }
}
