import {
  PROJECT_STATUS_REPORT_SECTIONS,
  renderProjectStatusReportMarkdown,
  type ProjectStatusReport,
  type ProjectStatusReportSection,
  type ProjectStatusShare,
} from '@mukuroji/contracts'
import { useId, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/locales/ja'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import { ProjectDirectoryApiError } from '../api/errors'
import { exportProjectStatusReportPdf } from '../api/statusReports'
import {
  createProjectStatusReportFileName,
  createProjectStatusReportSlides,
} from '../model/projectStatusReport'
import { useProjectStatusShareRecipients, useProjectStatusShares } from '../queries/useProjectStatusShares'
import {
  ProjectStatusReportDocument,
  saveProjectStatusReportFile,
  useProjectStatusReportPrint,
} from './ProjectStatusReportDocument'

/** Props of {@link ProjectStatusReportDialog}. */
export type ProjectStatusReportDialogProps = {
  /** Session access token. */
  accessToken?: string
  /** Team that owns the Project. */
  teamId: string
  /** Project the report is about. */
  projectId: string
  /** Report built from the overview, or `undefined` while its data loads. */
  report?: ProjectStatusReport
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
}

/** Export formats offered by the dialog. */
type ExportFormat = 'pdf' | 'markdown' | 'pptx'

/** Expiry choices of a new share link, in days. */
const EXPIRY_CHOICES = [7, 14, 30, 90] as const

/** Translation keys of the section names. */
const SECTION_LABELS: Record<ProjectStatusReportSection, MessageKey> = {
  health: 'projects.statusReport.section.health',
  schedule: 'projects.statusReport.section.schedule',
  progress: 'projects.statusReport.section.progress',
  risks: 'projects.statusReport.section.risks',
  nextActions: 'projects.statusReport.section.nextActions',
}

/**
 * Shows the Project status report with its exports and, for Project members, the read-only
 * share links for people outside the Workspace.
 *
 * @param props - Session, Project, report, labels, and close callback.
 * @returns The modal dialog.
 */
export function ProjectStatusReportDialog({ accessToken, teamId, projectId, report, t, onClose }: ProjectStatusReportDialogProps) {
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLElement>(onClose)
  const { print, portal } = useProjectStatusReportPrint()
  const [exporting, setExporting] = useState<ExportFormat>()
  const [exportError, setExportError] = useState(false)

  const runExport = async (format: ExportFormat) => {
    if (!report) return
    setExporting(format)
    setExportError(false)
    try {
      if (format === 'pdf') {
        if (!accessToken) throw new Error('The session is not ready.')
        saveProjectStatusReportFile(
          await exportProjectStatusReportPdf(accessToken, teamId, projectId, report),
          createProjectStatusReportFileName(report, 'pdf'),
        )
      } else if (format === 'markdown') {
        saveProjectStatusReportFile(
          new Blob([renderProjectStatusReportMarkdown(report)], { type: 'text/markdown;charset=utf-8' }),
          createProjectStatusReportFileName(report, 'md'),
        )
      } else {
        const bytes = createProjectStatusReportSlides(report)
        saveProjectStatusReportFile(
          new Blob([bytes.slice().buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
          createProjectStatusReportFileName(report, 'pptx'),
        )
      }
    } catch {
      setExportError(true)
    } finally {
      setExporting(undefined)
    }
  }

  return (
    <>
      {portal}
      <div
        className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
        onMouseDown={onClose}
      >
        <section
          aria-labelledby={titleId}
          aria-modal="true"
          className="workbench-panel flex max-h-[calc(100svh-3rem)] w-full max-w-[960px] flex-col overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
          data-testid="project-status-report-dialog"
          onMouseDown={(event) => event.stopPropagation()}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
            <h2 className="mr-auto text-lg font-semibold text-[var(--workbench-text)]" id={titleId}>
              {t('projects.statusReport.title')}
            </h2>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onClose} type="button">
              {t('projects.statusReport.close')}
            </button>
          </div>
          <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 min-[900px]:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid content-start gap-4">
              <p className="text-sm text-[var(--workbench-muted)]">{t('projects.statusReport.description')}</p>
              <div aria-label={t('projects.statusReport.export.heading')} className="flex flex-wrap gap-2" role="group">
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  disabled={!report}
                  onClick={() => report && print(report)}
                  type="button"
                >
                  {t('projects.statusReport.export.print')}
                </button>
                {(['pdf', 'markdown', 'pptx'] as const).map((format) => (
                  <button
                    className="workbench-button-secondary min-h-10 px-4"
                    data-testid={`project-status-report-export-${format}`}
                    disabled={!report || exporting !== undefined}
                    key={format}
                    onClick={() => void runExport(format)}
                    type="button"
                  >
                    {exporting === format
                      ? t('projects.statusReport.export.exporting')
                      : t(`projects.statusReport.export.${format}`)}
                  </button>
                ))}
              </div>
              {exportError ? (
                <p className="text-sm font-semibold text-red-700" role="alert">{t('projects.statusReport.error.export')}</p>
              ) : null}
              <div className="rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-5">
                {report
                  ? <ProjectStatusReportDocument report={report} />
                  : <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('projects.statusReport.loading')}</p>}
              </div>
            </div>
            <ShareLinks accessToken={accessToken} projectId={projectId} report={report} t={t} teamId={teamId} />
          </div>
        </section>
      </div>
    </>
  )
}

/** Props of {@link ShareLinks}. */
type ShareLinksProps = Pick<ProjectStatusReportDialogProps, 'accessToken' | 'teamId' | 'projectId' | 'report' | 't'>

/**
 * Lists a Project's share links and creates new ones.
 *
 * @param props - Session, Project, report, and labels.
 * @returns The share panel.
 */
function ShareLinks({ accessToken, teamId, projectId, report, t }: ShareLinksProps) {
  const { list, create, revoke } = useProjectStatusShares(accessToken, teamId, projectId, true)
  const forbidden = list.error instanceof ProjectDirectoryApiError && list.error.status === 403
  const [label, setLabel] = useState('')
  const [sections, setSections] = useState<ProjectStatusReportSection[]>(['health', 'schedule', 'progress'])
  const [showPeopleNames, setShowPeopleNames] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState<number>(14)
  const [customerId, setCustomerId] = useState('')
  const [contactId, setContactId] = useState('')
  const recipients = useProjectStatusShareRecipients(accessToken, !forbidden && !list.error, customerId || undefined)
  const [creating, setCreating] = useState(false)
  const [createdUrl, setCreatedUrl] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<MessageKey>()
  const [revoking, setRevoking] = useState<string>()

  if (forbidden) {
    return (
      <aside className="grid content-start gap-2" data-testid="project-status-share-forbidden">
        <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.share.title')}</h3>
        <p className="text-sm text-[var(--workbench-muted)]">{t('projects.statusReport.share.forbidden')}</p>
      </aside>
    )
  }

  const submit = async () => {
    if (!report) return
    setCreating(true)
    setError(undefined)
    setCreatedUrl(undefined)
    setCopied(false)
    try {
      const created = await create({
        report,
        label: label.trim(),
        sections,
        showPeopleNames,
        expiresInDays,
        ...(customerId ? { customerId } : {}),
        ...(customerId && contactId ? { contactId } : {}),
      })
      setCreatedUrl(new URL(created.url, window.location.origin).toString())
      setLabel('')
    } catch (caught) {
      setError(describeShareError(caught, 'projects.statusReport.error.create'))
    } finally {
      setCreating(false)
    }
  }

  const customers = recipients.customers.data?.customers ?? []
  const contacts = recipients.customer.data?.contacts.filter((contact) => contact.status === 'active') ?? []

  return (
    <aside className="grid content-start gap-4" data-testid="project-status-share">
      <div className="grid gap-1">
        <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.share.title')}</h3>
        <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t('projects.statusReport.share.description')}</p>
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('projects.statusReport.share.label')}
          <input
            className="workbench-input min-h-10"
            data-testid="project-status-share-label"
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
            required
            value={label}
          />
        </label>
        <fieldset className="grid gap-1 text-sm">
          <legend className="mb-1 font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.share.sections')}</legend>
          {PROJECT_STATUS_REPORT_SECTIONS.map((section) => (
            <label className="flex items-center gap-2" key={section}>
              <input
                checked={sections.includes(section)}
                onChange={(event) => setSections((current) => event.target.checked
                  ? PROJECT_STATUS_REPORT_SECTIONS.filter((candidate) => candidate === section || current.includes(candidate))
                  : current.filter((candidate) => candidate !== section))}
                type="checkbox"
              />
              {t(SECTION_LABELS[section])}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input checked={showPeopleNames} onChange={(event) => setShowPeopleNames(event.target.checked)} type="checkbox" />
          {t('projects.statusReport.share.showPeopleNames')}
        </label>
        <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('projects.statusReport.share.expires')}
          <select className="workbench-input min-h-10" onChange={(event) => setExpiresInDays(Number(event.target.value))} value={expiresInDays}>
            {EXPIRY_CHOICES.map((days) => (
              <option key={days} value={days}>
                {t('projects.statusReport.share.expiresDays').replace('{days}', String(days))}
              </option>
            ))}
          </select>
        </label>
        {customers.length > 0 ? (
          <>
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('projects.statusReport.share.customer')}
              <select
                className="workbench-input min-h-10"
                onChange={(event) => {
                  setCustomerId(event.target.value)
                  setContactId('')
                }}
                value={customerId}
              >
                <option value="">{t('projects.statusReport.share.none')}</option>
                {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
              </select>
            </label>
            {customerId && contacts.length > 0 ? (
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('projects.statusReport.share.contact')}
                <select className="workbench-input min-h-10" onChange={(event) => setContactId(event.target.value)} value={contactId}>
                  <option value="">{t('projects.statusReport.share.none')}</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        <button
          className="workbench-button-primary min-h-10 px-4"
          data-testid="project-status-share-create"
          disabled={!report || creating || sections.length === 0 || label.trim().length === 0}
          type="submit"
        >
          {creating ? t('projects.statusReport.share.creating') : t('projects.statusReport.share.create')}
        </button>
      </form>
      {error ? <p className="text-sm font-semibold text-red-700" role="alert">{t(error)}</p> : null}
      {createdUrl ? (
        <div className="grid gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3" role="status">
          <p className="text-xs font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.share.created')}</p>
          <input aria-label={t('projects.statusReport.share.title')} className="workbench-input min-h-10 text-xs" data-testid="project-status-share-url" readOnly value={createdUrl} />
          <button
            className="workbench-button-secondary min-h-9 px-3 text-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(createdUrl).then(() => setCopied(true), () => setCopied(false))
            }}
            type="button"
          >
            {copied ? t('projects.statusReport.share.copied') : t('projects.statusReport.share.copy')}
          </button>
        </div>
      ) : null}
      <div className="grid gap-2">
        <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.share.list')}</h4>
        {list.error ? (
          <p className="text-sm text-red-700" role="alert">{t('projects.statusReport.error.shares')}</p>
        ) : list.data && list.data.shares.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('projects.statusReport.share.empty')}</p>
        ) : (
          <ul className="grid gap-2" data-testid="project-status-share-list">
            {(list.data?.shares ?? []).map((share) => (
              <ShareRow
                isRevoking={revoking === share.id}
                key={share.id}
                onRevoke={async () => {
                  setRevoking(share.id)
                  setError(undefined)
                  try {
                    await revoke(share.id)
                  } catch (caught) {
                    setError(describeShareError(caught, 'projects.statusReport.error.revoke'))
                  } finally {
                    setRevoking(undefined)
                  }
                }}
                share={share}
                t={t}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

/** Props of {@link ShareRow}. */
type ShareRowProps = {
  /** Share link. */
  share: ProjectStatusShare
  /** Whether this link is being revoked. */
  isRevoking: boolean
  /** Revokes the link. */
  onRevoke: () => Promise<void>
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Shows one share link with its state, expiry, and view count.
 *
 * @param props - Share, revoke state, and labels.
 * @returns The list item.
 */
function ShareRow({ share, isRevoking, onRevoke, t }: ShareRowProps) {
  const state = share.revokedAt !== undefined
    ? 'revoked'
    : Date.parse(share.expiresAt) <= Date.now()
      ? 'expired'
      : 'open'
  return (
    <li className="grid gap-1 rounded-md border border-[var(--workbench-border)] px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold text-[var(--workbench-text)]">{share.label}</span>
        <span className={state === 'open' ? 'workbench-badge workbench-badge-success' : 'workbench-badge'}>
          {t(`projects.statusReport.share.status.${state}`)}
        </span>
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('projects.statusReport.share.meta')
          .replace('{expiresAt}', share.expiresAt.slice(0, 10))
          .replace('{count}', String(share.viewCount))}
      </p>
      {state === 'open' ? (
        <button
          className="workbench-button-secondary min-h-8 justify-self-start px-3 text-xs"
          disabled={isRevoking}
          onClick={() => void onRevoke()}
          type="button"
        >
          {isRevoking ? t('projects.statusReport.share.revoking') : t('projects.statusReport.share.revoke')}
        </button>
      ) : null}
    </li>
  )
}

/**
 * Chooses the message of a failed share request.
 *
 * @param error - Thrown error.
 * @param fallback - Message used for unexpected failures.
 * @returns Translation key.
 */
function describeShareError(error: unknown, fallback: MessageKey): MessageKey {
  if (!(error instanceof ProjectDirectoryApiError)) return fallback
  if (error.code === 'ProjectStatusShareLimitReached') return 'projects.statusReport.error.limit'
  if (error.code === 'ProjectStatusReportTooLarge') return 'projects.statusReport.error.tooLarge'
  if (error.code === 'ProjectStatusShareCustomerForbidden') return 'projects.statusReport.error.customerForbidden'
  if (error.status === 400) return 'projects.statusReport.error.invalid'
  return fallback
}
