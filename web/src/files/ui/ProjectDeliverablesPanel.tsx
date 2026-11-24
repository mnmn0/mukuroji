import { useMemo, useState } from 'react'
import type {
  FileScanStatus,
  ProjectDeliverable,
  ProjectDeliverableApprovalFilter,
  ProjectDeliverableApprovalState,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import {
  createProjectDeliverablesCsv,
  formatDeliverableWorkItemLabel,
} from '../model/projectDeliverables'
import type { ProjectDeliverablesController } from '../queries/useProjectDeliverables'

const approvalFilters: readonly ProjectDeliverableApprovalFilter[] = ['all', 'unapproved', 'pending', 'approved']

/**
 * Props of {@link ProjectDeliverablesPanel}.
 */
export type ProjectDeliverablesPanelProps = {
  /**
   * Deliverables list state and actions.
   */
  controller: ProjectDeliverablesController
  /**
   * Display locale.
   */
  locale: Locale
  /**
   * Base name of the exported CSV file, without the extension.
   */
  exportFileName: string
  /**
   * Offers CSV text as a file download.
   *
   * @param csv - CSV text.
   * @param fileName - Offered file name.
   */
  onDownloadCsv: (csv: string, fileName: string) => void
}

/**
 * Lists a Project's deliverables — its own files and its readable Work Items' attachments — with
 * the latest version, scan state, approval state, and unresolved review comments.
 *
 * @param props - List controller, locale, and CSV export.
 * @returns The deliverables section.
 */
export function ProjectDeliverablesPanel({
  controller,
  exportFileName,
  locale,
  onDownloadCsv,
}: ProjectDeliverablesPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [isExporting, setIsExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const { filters } = controller

  /** Reads every page with the current filters and offers them as CSV. */
  const exportCsv = async () => {
    setIsExporting(true)
    setExportFailed(false)
    try {
      const deliverables = await controller.loadAll()
      onDownloadCsv(createProjectDeliverablesCsv(deliverables, {
        headers: {
          file: t('files.deliverables.column.file'),
          owner: t('files.deliverables.column.owner'),
          version: t('files.deliverables.column.version'),
          scan: t('files.deliverables.column.scan'),
          approval: t('files.deliverables.column.approval'),
          annotations: t('files.deliverables.column.annotations'),
          updatedAt: t('files.deliverables.column.updated'),
        },
        owner: (owner) => owner.kind === 'project'
          ? t('files.deliverables.owner.project')
          : formatDeliverableWorkItemLabel(owner),
        scan: (status) => t(`files.scan.${status}`),
        approval: (state) => t(`files.deliverables.approval.${state}`),
      }), `${exportFileName}.csv`)
    } catch (error) {
      console.error('Project deliverables export failed:', error)
      setExportFailed(true)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section
      aria-labelledby="project-deliverables-title"
      className="mt-3 rounded-xl border border-[var(--workbench-border)] bg-surface"
      data-testid="project-deliverables"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--workbench-border)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="workbench-eyebrow text-[var(--workbench-muted)]" id="project-deliverables-title">
            {t('files.deliverables.title')}
          </h2>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t('files.deliverables.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]">
            {t('files.deliverables.filter.label')}
            <select
              className="workbench-input h-8 px-2 text-xs"
              onChange={(event) => {
                const next = approvalFilters.find((filter) => filter === event.target.value)
                if (next) controller.setFilters({ ...filters, approval: next })
              }}
              value={filters.approval}
            >
              {approvalFilters.map((filter) => (
                <option key={filter} value={filter}>{t(`files.deliverables.filter.${filter}`)}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
            <input
              checked={filters.unresolvedOnly}
              onChange={(event) => controller.setFilters({ ...filters, unresolvedOnly: event.target.checked })}
              type="checkbox"
            />
            {t('files.deliverables.unresolvedOnly')}
          </label>
          <button
            className="workbench-button-secondary h-8 px-3 text-xs disabled:opacity-50"
            disabled={isExporting || controller.isLoading}
            onClick={() => void exportCsv()}
            type="button"
          >
            {t(isExporting ? 'files.deliverables.exporting' : 'files.deliverables.exportCsv')}
          </button>
        </div>
      </div>
      {exportFailed ? (
        <p className="px-5 pt-3 text-sm font-semibold text-fg-red-700" role="alert">
          {t('files.deliverables.exportError')}
        </p>
      ) : null}
      <ProjectDeliverablesBody controller={controller} locale={locale} t={t} />
    </section>
  )
}

/**
 * Renders the loading, error, empty, or table state of the deliverables list.
 *
 * @param props - List controller, locale, and translator.
 * @returns The list body.
 */
function ProjectDeliverablesBody({
  controller,
  locale,
  t,
}: {
  /** Deliverables list state and actions. */
  controller: ProjectDeliverablesController
  /** Display locale. */
  locale: Locale
  /** Translator of the display locale. */
  t: ReturnType<typeof createTranslator>
}) {
  if (controller.isLoading) {
    return <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('files.deliverables.loading')}</p>
  }
  if (controller.hasError && controller.deliverables.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 px-5 py-4" role="alert">
        <p className="text-sm font-semibold text-fg-red-700">{t('files.deliverables.error')}</p>
        <button
          className="workbench-button-secondary h-8 px-3 text-xs"
          onClick={() => void controller.refresh()}
          type="button"
        >
          {t('files.deliverables.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 py-4">
      {controller.deliverables.length === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('files.deliverables.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--workbench-border)] text-xs font-semibold text-[var(--workbench-muted)]">
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.file')}</th>
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.owner')}</th>
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.version')}</th>
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.scan')}</th>
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.approval')}</th>
                <th className="py-2 pr-3" scope="col">{t('files.deliverables.column.annotations')}</th>
                <th className="py-2" scope="col">{t('files.deliverables.column.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {controller.deliverables.map((deliverable) => (
                <ProjectDeliverableRow
                  deliverable={deliverable}
                  key={`${deliverable.owner.kind === 'project' ? 'project' : deliverable.owner.issueId}:${deliverable.file.id}`}
                  locale={locale}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {controller.hasError && controller.deliverables.length > 0 ? (
        <p className="mt-3 text-sm font-semibold text-fg-red-700" role="alert">{t('files.deliverables.error')}</p>
      ) : null}
      {controller.hasMore ? (
        <div className="mt-3 flex items-center gap-3">
          <button
            className="workbench-button-secondary h-8 px-3 text-xs disabled:opacity-50"
            disabled={controller.isLoadingMore}
            onClick={controller.loadMore}
            type="button"
          >
            {t(controller.isLoadingMore ? 'files.deliverables.loadingMore' : 'files.deliverables.loadMore')}
          </button>
          <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('files.deliverables.moreHint')}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders one deliverable row.
 *
 * @param props - Deliverable, locale, and translator.
 * @returns The table row.
 */
function ProjectDeliverableRow({
  deliverable,
  locale,
  t,
}: {
  /** Deliverable shown by the row. */
  deliverable: ProjectDeliverable
  /** Display locale. */
  locale: Locale
  /** Translator of the display locale. */
  t: ReturnType<typeof createTranslator>
}) {
  const { file, owner } = deliverable
  return (
    <tr className="border-b border-[var(--workbench-border)] last:border-b-0" data-testid={`deliverable-${file.id}`}>
      <td className="max-w-[16rem] py-2 pr-3">
        <span className="block truncate font-semibold text-[var(--workbench-text)]" title={file.name}>{file.name}</span>
      </td>
      <td className="max-w-[16rem] py-2 pr-3 text-[var(--workbench-text)]">
        <span className="block truncate">
          {owner.kind === 'project' ? t('files.deliverables.owner.project') : formatDeliverableWorkItemLabel(owner)}
        </span>
      </td>
      <td className="py-2 pr-3 tabular-nums">v{file.currentVersion.number}</td>
      <td className="py-2 pr-3">
        <span className={resolveScanBadgeClassName(file.currentVersion.scanStatus)}>
          {t(`files.scan.${file.currentVersion.scanStatus}`)}
        </span>
      </td>
      <td className="py-2 pr-3">
        <span className={resolveApprovalStateBadgeClassName(deliverable.approvalState)}>
          {t(`files.deliverables.approval.${deliverable.approvalState}`)}
        </span>
      </td>
      <td className="py-2 pr-3 tabular-nums">
        {deliverable.unresolvedAnnotationCount > 0 ? (
          <span className="workbench-badge-warning">{deliverable.unresolvedAnnotationCount}</span>
        ) : (
          <span className="text-[var(--workbench-muted)]">0</span>
        )}
      </td>
      <td className="py-2 tabular-nums text-[var(--workbench-muted)]">{formatDeliverableDate(file.updatedAt, locale)}</td>
    </tr>
  )
}

/**
 * Picks the badge style of a scan state.
 *
 * @param status - Scan state.
 * @returns The badge class name.
 */
function resolveScanBadgeClassName(status: FileScanStatus) {
  if (status === 'available') return 'workbench-badge-success'
  if (status === 'blocked' || status === 'failed') return 'workbench-badge-danger'
  return 'workbench-badge-warning'
}

/**
 * Picks the badge style of an approval state.
 *
 * @param state - Approval state.
 * @returns The badge class name.
 */
function resolveApprovalStateBadgeClassName(state: ProjectDeliverableApprovalState) {
  if (state === 'approved') return 'workbench-badge-success'
  if (state === 'rejected' || state === 'changes-requested') return 'workbench-badge-danger'
  return state === 'pending' ? 'workbench-badge-warning' : 'workbench-badge'
}

/**
 * Formats an update time as a local date.
 *
 * @param value - ISO 8601 timestamp.
 * @param locale - Display locale.
 * @returns The formatted date, or the raw value when it is not a date.
 */
function formatDeliverableDate(value: string, locale: Locale) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale)
}
