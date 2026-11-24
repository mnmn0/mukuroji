import useSWR from 'swr'
import { getDocumentApprovals, getDocumentVersion } from '../api/versions'

/** SWR options for immutable version snapshots and their approvals. */
const versionReviewQueryConfig = {
  dedupingInterval: 30_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Reads one version's read-only snapshot.
 *
 * @param accessToken - Documents API token; omission skips the read.
 * @param documentId - Document that owns the version.
 * @param versionId - Version to read; omission skips the read.
 * @returns The SWR state of the version detail.
 */
export function useDocumentVersionDetail(
  accessToken: string | undefined,
  documentId: string | undefined,
  versionId: string | undefined,
) {
  return useSWR(
    accessToken && documentId && versionId
      ? ['document-version-detail', accessToken, documentId, versionId] as const
      : null,
    ([, token, selectedDocumentId, selectedVersionId]) =>
      getDocumentVersion(token, selectedDocumentId, selectedVersionId),
    versionReviewQueryConfig,
  )
}

/**
 * Reads the approvals requested for the Document's pinned versions.
 *
 * @param accessToken - Documents API token; omission skips the read.
 * @param documentId - Document whose approvals are read.
 * @returns The SWR state of the approvals, newest first.
 */
export function useDocumentApprovals(
  accessToken: string | undefined,
  documentId: string | undefined,
) {
  return useSWR(
    accessToken && documentId
      ? ['document-approvals', accessToken, documentId] as const
      : null,
    ([, token, selectedDocumentId]) => getDocumentApprovals(token, selectedDocumentId),
    { ...versionReviewQueryConfig, dedupingInterval: 5_000 },
  )
}
