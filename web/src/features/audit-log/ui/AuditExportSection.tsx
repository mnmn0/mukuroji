import type { AuditExportStatus, AuditExportView } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { formatAuditByteLength, formatAuditTime } from '../model/auditEventDisplay'
import { formatAuditEventType } from '../model/auditEventTypes'
import type { IssuedAuditExportLinks } from '../mutations/useAuditExportActions'

/** Message keys of each export state. */
const exportStatusKeys: Record<AuditExportStatus, MessageKey> = {
  queued: 'auditLog.export.status.queued',
  running: 'auditLog.export.status.running',
  completed: 'auditLog.export.status.completed',
  failed: 'auditLog.export.status.failed',
}

/** Badge class of each export state. */
const exportStatusBadges: Record<AuditExportStatus, string> = {
  queued: 'workbench-badge',
  running: 'workbench-badge-primary',
  completed: 'workbench-badge-success',
  failed: 'workbench-badge-danger',
}

/** Props of the export section. */
type AuditExportSectionProps = {
  /** Display locale. */
  readonly locale: Locale
  /** IANA time zone; undefined uses the browser's. */
  readonly timeZone?: string
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Recent exports, undefined while loading. */
  readonly exports?: readonly AuditExportView[]
  /** Whether the export list could not be read. */
  readonly exportsFailed: boolean
  /** Whether an export request is in flight. */
  readonly isRequestingExport: boolean
  /** Export whose links are being issued. */
  readonly issuingExportId?: string
  /** Links issued per export ID. */
  readonly exportLinks: Readonly<Record<string, IssuedAuditExportLinks>>
  /** Message of the last failed export action. */
  readonly exportActionError?: string
  /** Requests an export of the form's filters. */
  readonly onRequestExport: () => void
  /** Reloads the export list. */
  readonly onRetryExports: () => void
  /** Issues download links of one export page. */
  readonly onIssueExportLinks: (exportId: string, fromPart?: number) => void
}

/**
 * Renders the export request button and the recent exports with their download links.
 *
 * @param props - Export list, action state, and callbacks.
 * @returns The export section of the audit log panel.
 */
export function AuditExportSection(props: AuditExportSectionProps) {
  const { t } = props
  return (
    <section className="border-t border-[var(--workbench-border)] px-5 py-5 sm:px-7" data-testid="audit-export-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('auditLog.export.title')}</h3>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('auditLog.export.description')}</p>
        </div>
        <button
          className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
          disabled={props.isRequestingExport || props.issuingExportId !== undefined}
          onClick={props.onRequestExport}
          type="button"
        >
          {t(props.isRequestingExport ? 'auditLog.export.requesting' : 'auditLog.export.request')}
        </button>
      </div>
      {props.exportActionError ? (
        <p className="mt-3 text-sm font-semibold text-fg-9e3d27" role="alert">{props.exportActionError}</p>
      ) : null}
      <div className="mt-4">
        <AuditExportList {...props} />
      </div>
    </section>
  )
}

/**
 * Renders the recent exports, or the state that stands in for them.
 *
 * @param props - Export section props.
 * @returns Export list or its empty, loading, or failure state.
 */
function AuditExportList(props: AuditExportSectionProps) {
  const { t } = props
  if (props.exportsFailed) {
    return (
      <div className="grid justify-items-start gap-2" role="alert">
        <p className="text-sm font-semibold text-fg-9e3d27">{t('auditLog.export.listFailed')}</p>
        <button className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50" onClick={props.onRetryExports} type="button">{t('auditLog.list.retry')}</button>
      </div>
    )
  }
  if (!props.exports) {
    return <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('auditLog.export.listLoading')}</p>
  }
  if (props.exports.length === 0) {
    return <p className="text-sm text-[var(--workbench-muted)]">{t('auditLog.export.empty')}</p>
  }
  return (
    <ul className="grid gap-2" aria-label={t('auditLog.export.listAria')}>
      {props.exports.map((job) => {
        const issued = props.exportLinks[job.exportId]
        return (
          <li className="rounded-lg border border-[var(--workbench-border)] bg-surface px-4 py-3" data-testid="audit-export-row" key={job.exportId}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid min-w-0 gap-1 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-[var(--workbench-text)]">
                  <span className={exportStatusBadges[job.status]}>{t(exportStatusKeys[job.status])}</span>
                  <span>{formatAuditTime(job.createdAt, props.locale, props.timeZone)}</span>
                  <span className="font-medium text-[var(--workbench-muted)]">{job.requestedBy.displayName}</span>
                </p>
                <p className="text-[var(--workbench-muted)]">{describeExportFilters(job, props)}</p>
                <p className="text-xs text-[var(--workbench-muted)]">
                  {t('auditLog.export.counts')
                    .replace('{events}', String(job.eventCount))
                    .replace('{parts}', String(job.partCount))}
                  {' · '}
                  {t('auditLog.export.expiresAt').replace('{time}', formatAuditTime(job.expiresAt, props.locale, props.timeZone))}
                </p>
                {job.failure ? <p className="text-xs font-semibold text-fg-9e3d27">{job.failure.message}</p> : null}
              </div>
              {job.status === 'completed' && job.partCount > 0 ? (
                <button
                  className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50"
                  disabled={props.isRequestingExport || props.issuingExportId !== undefined}
                  onClick={() => props.onIssueExportLinks(job.exportId)}
                  type="button"
                >
                  {t(props.issuingExportId === job.exportId ? 'auditLog.export.issuing' : 'auditLog.export.issue')}
                </button>
              ) : null}
            </div>
            {issued ? (
              <div className="mt-3 grid gap-2 border-t border-[var(--workbench-border)] pt-3">
                <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('auditLog.export.linksExpire')}</p>
                <ul className="grid gap-1 text-sm">
                  {issued.download.parts.map((part) => (
                    <li key={part.index}>
                      <a
                        className="font-semibold text-[var(--workbench-primary-text)] underline underline-offset-2"
                        download={`mukuroji-audit-${job.exportId}-${part.index}.ndjson`}
                        href={part.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {t('auditLog.export.part').replace('{index}', String(part.index))}
                      </a>
                      <span className="ml-2 text-xs text-[var(--workbench-muted)]">
                        {t('auditLog.export.partSize')
                          .replace('{events}', String(part.eventCount))
                          .replace('{size}', formatAuditByteLength(part.byteLength))}
                      </span>
                    </li>
                  ))}
                </ul>
                {issued.download.nextPart !== undefined ? (
                  <button
                    className="workbench-button-secondary min-h-10 justify-self-start px-4 disabled:opacity-50"
                    disabled={props.isRequestingExport || props.issuingExportId !== undefined}
                    onClick={() => props.onIssueExportLinks(job.exportId, issued.download.nextPart)}
                    type="button"
                  >
                    {t('auditLog.export.nextParts')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Describes the filters an export was requested with.
 *
 * @param job - Export.
 * @param props - Locale and message resolver.
 * @returns One line naming each filter, or a note that everything was exported.
 */
function describeExportFilters(job: AuditExportView, { locale, t, timeZone }: AuditExportSectionProps): string {
  const parts: string[] = []
  const { filters } = job
  if (filters.actorId) parts.push(`${t('auditLog.filter.actor')}: ${filters.actorId}`)
  if (filters.actorKind) parts.push(`${t('auditLog.export.actorKind')}: ${filters.actorKind}`)
  if (filters.entityType) {
    parts.push(`${t('auditLog.event.entity')}: ${filters.entityType}${filters.entityId ? ` / ${filters.entityId}` : ''}`)
  }
  if (filters.eventTypes?.length) {
    parts.push(`${t('auditLog.filter.eventType')}: ${filters.eventTypes.map((type) => formatAuditEventType(type, locale)).join(', ')}`)
  }
  if (filters.targetType) {
    parts.push(`${t('auditLog.filter.targetType')}: ${filters.targetType}${filters.targetId ? ` / ${filters.targetId}` : ''}`)
  }
  if (filters.from || filters.to) {
    const from = filters.from ? formatAuditTime(filters.from, locale, timeZone) : ''
    const to = filters.to ? formatAuditTime(filters.to, locale, timeZone) : ''
    parts.push(`${t('auditLog.export.period')}: ${from} – ${to}`)
  }
  return parts.length > 0 ? parts.join(' · ') : t('auditLog.export.allEvents')
}
