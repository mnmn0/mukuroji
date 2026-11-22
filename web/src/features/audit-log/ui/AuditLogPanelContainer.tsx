import { useMemo, useState } from 'react'
import type { AuditEventFilters } from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../../shared/i18n/i18n'
import { AuditLogApiError } from '../api/auditLogRequest'
import {
  buildAuditLogFilters,
  emptyAuditLogFilterDraft,
  type AuditLogFilterDraft,
  type AuditLogFilterProblem,
} from '../model/auditLogFilters'
import { useAuditExportActions } from '../mutations/useAuditExportActions'
import { useAuditEvents, type AuditLogRequestGuard } from '../queries/useAuditEvents'
import { useAuditExports } from '../queries/useAuditExports'
import { AuditLogPanel, type AuditLogLoadFailure } from './AuditLogPanel'

/** Props of the audit log container. */
type AuditLogPanelContainerProps = {
  /** Bearer token of the signed-in member. */
  readonly accessToken: string
  /** Display locale. */
  readonly locale: Locale
  /** IANA time zone of the member; undefined uses the browser's. */
  readonly timeZone?: string
  /** Whether the member may request and download exports. */
  readonly canExport: boolean
  /** Session-policy guard of the Workspace shell. */
  readonly guardRequest: AuditLogRequestGuard
}

/**
 * Connects the audit search and export APIs to the audit log panel.
 *
 * Nothing is searched until the member presses Search, because every search is itself audited.
 *
 * @param props - Token, locale, time zone, export permission, and session guard.
 * @returns The audit log panel.
 */
export function AuditLogPanelContainer({
  accessToken,
  canExport,
  guardRequest,
  locale,
  timeZone,
}: AuditLogPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [draft, setDraft] = useState<AuditLogFilterDraft>(emptyAuditLogFilterDraft)
  const [filterProblem, setFilterProblem] = useState<AuditLogFilterProblem>()
  const [appliedFilters, setAppliedFilters] = useState<AuditEventFilters>()
  const search = useAuditEvents(accessToken, appliedFilters, guardRequest)
  const exports = useAuditExports(accessToken, canExport, guardRequest)
  const exportActions = useAuditExportActions({ accessToken, guardRequest, refreshExports: () => exports.mutate() })

  /**
   * Validates a draft and searches it; a search identical to the shown one reads again.
   *
   * @param nextDraft - Form values to search.
   */
  const runSearch = (nextDraft: AuditLogFilterDraft) => {
    const result = buildAuditLogFilters(nextDraft, timeZone)
    if (!result.ok) {
      setFilterProblem(result.problem)
      return
    }
    setFilterProblem(undefined)
    if (appliedFilters && JSON.stringify(appliedFilters) === JSON.stringify(result.filters)) {
      void search.refresh()
      return
    }
    setAppliedFilters(result.filters)
  }

  /**
   * Replaces some form values and searches the result at once.
   *
   * @param changes - Form values to replace.
   */
  const searchWith = (changes: Partial<AuditLogFilterDraft>) => {
    const nextDraft = { ...draft, ...changes }
    setDraft(nextDraft)
    runSearch(nextDraft)
  }

  const requestExport = () => {
    const result = buildAuditLogFilters(draft, timeZone)
    if (!result.ok) {
      setFilterProblem(result.problem)
      return
    }
    setFilterProblem(undefined)
    void exportActions.requestExport(result.filters)
  }

  return (
    <AuditLogPanel
      canExport={canExport}
      draft={draft}
      events={search.events}
      exportActionError={exportActions.error === undefined ? undefined : t(describeExportActionError(exportActions.error))}
      exportLinks={exportActions.links}
      exports={exports.data}
      exportsFailed={exports.error !== undefined}
      filterProblem={filterProblem}
      hasMore={search.hasMore}
      hasSearched={appliedFilters !== undefined}
      isLoading={search.isLoading}
      isLoadingMore={search.isLoadingMore}
      isRequestingExport={exportActions.isRequesting}
      issuingExportId={exportActions.issuingExportId}
      loadFailure={search.error === undefined ? undefined : describeLoadFailure(search.error)}
      locale={locale}
      onChangeDraft={setDraft}
      onFilterByActor={(actor) => searchWith({ actorId: actor.id })}
      onFilterByTarget={(target) => searchWith({ targetType: target.type, targetId: target.id })}
      onIssueExportLinks={(exportId, fromPart) => void exportActions.issueLinks(exportId, fromPart)}
      onLoadMore={() => void search.loadMore()}
      onRequestExport={requestExport}
      onReset={() => {
        setDraft(emptyAuditLogFilterDraft)
        setFilterProblem(undefined)
        setAppliedFilters(undefined)
      }}
      onRetry={() => void search.refresh()}
      onRetryExports={() => void exports.mutate()}
      onSearch={() => runSearch(draft)}
      t={t}
      timeZone={timeZone}
    />
  )
}

/**
 * Classifies a search failure.
 *
 * @param error - Error thrown by the search.
 * @returns `forbidden` when the member may not read the audit log, otherwise `failed`.
 */
function describeLoadFailure(error: unknown): AuditLogLoadFailure {
  return error instanceof AuditLogApiError && error.status === 403 ? 'forbidden' : 'failed'
}

/**
 * Picks the message of a failed export action.
 *
 * @param error - Error thrown by the action.
 * @returns Message key for the failure.
 */
function describeExportActionError(error: unknown): MessageKey {
  if (!(error instanceof AuditLogApiError)) return 'auditLog.export.actionFailed'
  if (error.status === 403) return 'auditLog.export.forbidden'
  if (error.code === 'AuditExportUnavailable') return 'auditLog.export.unavailable'
  if (error.code === 'InvalidAuditExportFilters' || error.status === 400) return 'auditLog.export.invalidFilters'
  return 'auditLog.export.actionFailed'
}
