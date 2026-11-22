import { useRef, useState } from 'react'
import type { AuditEventFilters, AuditExportDownloadView } from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { AuditLogApiError } from '../api/auditLogRequest'
import { getAuditExportDownload, requestAuditExport } from '../api/auditExports'
import type { AuditLogRequestGuard } from '../queries/useAuditEvents'

/** Download links issued for one export, with the time they were issued. */
export type IssuedAuditExportLinks = {
  /** Links returned by the server. */
  readonly download: AuditExportDownloadView
  /** Epoch milliseconds when the links were issued. */
  readonly issuedAt: number
}

/** Inputs of the export actions. */
type UseAuditExportActionsOptions = {
  /** Bearer token of the signed-in member. */
  readonly accessToken: string
  /** Session-policy guard of the Workspace shell. */
  readonly guardRequest: AuditLogRequestGuard
  /** Reloads the export list after a new export was requested. */
  readonly refreshExports: () => Promise<unknown>
}

/**
 * Requests audit exports and issues their download links, one action at a time.
 *
 * @param options - Token, session guard, and export list refresh.
 * @returns Action state and entry points.
 */
export function useAuditExportActions({ accessToken, guardRequest, refreshExports }: UseAuditExportActionsOptions) {
  const [isRequesting, setIsRequesting] = useState(false)
  const [issuingExportId, setIssuingExportId] = useState<string>()
  const [error, setError] = useState<unknown>()
  const [links, setLinks] = useState<Readonly<Record<string, IssuedAuditExportLinks>>>({})
  const busy = useRef(false)
  // Keeps the idempotency key of a request whose outcome is unknown, so pressing the button
  // again with the same filters recovers that export instead of starting another.
  const [requestRunner] = useState(createMutationRequestRunner)

  /**
   * Requests an export of the events that match the filters.
   *
   * @param filters - Filters of the export; empty exports every retained event.
   * @returns Whether the request was accepted.
   */
  const requestExport = async (filters: AuditEventFilters): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    setIsRequesting(true)
    setError(undefined)
    try {
      await requestRunner.run(
        'audit-export',
        JSON.stringify(filters),
        (context) => guardRequest(requestAuditExport(accessToken, filters, context)),
        isUncertainExportFailure,
      )
      await refreshExports()
      return true
    } catch (requestError) {
      setError(requestError)
      return false
    } finally {
      busy.current = false
      setIsRequesting(false)
    }
  }

  /**
   * Issues download links for one page of a completed export's parts.
   *
   * @param exportId - Completed export.
   * @param fromPart - First part of the page.
   */
  const issueLinks = async (exportId: string, fromPart = 0): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setIssuingExportId(exportId)
    setError(undefined)
    try {
      const download = await guardRequest(getAuditExportDownload(accessToken, exportId, fromPart))
      setLinks((current) => ({ ...current, [exportId]: { download, issuedAt: Date.now() } }))
    } catch (issueError) {
      setError(issueError)
    } finally {
      busy.current = false
      setIssuingExportId(undefined)
    }
  }

  return { error, isRequesting, issuingExportId, issueLinks, links, requestExport }
}

/**
 * Tells whether an export request may have reached the server, so a retry must reuse its key.
 *
 * @param error - Error thrown by the request.
 * @returns True for network failures and server errors, false for a definite rejection.
 */
function isUncertainExportFailure(error: unknown): boolean {
  return !(error instanceof AuditLogApiError) || error.status >= 500
}
