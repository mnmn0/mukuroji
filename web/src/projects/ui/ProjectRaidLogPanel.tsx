import {
  deriveProjectRaidSeverity,
  isProjectRaidReviewOverdue,
  PROJECT_RAID_ENTRY_KINDS,
  PROJECT_RAID_TEXT_MAX_LENGTH,
  PROJECT_RAID_TITLE_MAX_LENGTH,
  summarizeProjectRaidLog,
  type ProjectRaidEntry,
  type ProjectRaidEntryInput,
  type ProjectRaidEntryKind,
  type ProjectRaidEntryStatus,
  type ProjectRaidSeverity,
} from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { ProjectDirectoryApiError } from '../api/errors'

/** Props of the Project risk, issue, and change request log panel. */
export type ProjectRaidLogPanelProps = {
  /** Entries of the log, newest first; absent while loading. */
  entries?: readonly ProjectRaidEntry[]
  /** Whether the first load is still running. */
  isLoading: boolean
  /** Whether the last load failed. */
  hasLoadError: boolean
  /** Today in `YYYY-MM-DD`, in the viewer's calendar. */
  today: string
  /** Whether the viewer may add and change entries. */
  canEdit: boolean
  /**
   * Saves a new entry or a change.
   *
   * @param entry - Entry being changed, or `undefined` for a new one.
   * @param input - Editable fields to save.
   */
  onSave: (entry: ProjectRaidEntry | undefined, input: ProjectRaidEntryInput) => Promise<void>
  /** Loads the log again. */
  onReload: () => void
  /** Translator for every label. */
  t: (key: MessageKey) => string
}

/** Values of the entry form, as the inputs hold them. */
type EntryFormValues = {
  /** Selected kind. */
  kind: ProjectRaidEntryKind
  /** Title text. */
  title: string
  /** Probability rating as text. */
  probability: string
  /** Impact rating as text. */
  impact: string
  /** Review date in `YYYY-MM-DD`, or empty. */
  reviewDueDate: string
  /** Details text. */
  description: string
  /** Mitigation, resolution, or decision text. */
  response: string
  /** Selected status. */
  status: ProjectRaidEntryStatus
}

/** Form state: closed, adding a new entry, or editing one. */
type EditorState =
  | {
      /** No form is open. */
      mode: 'closed'
    }
  | {
      /** A new entry is being added. */
      mode: 'create'
      /** Current form values. */
      values: EntryFormValues
    }
  | {
      /** An existing entry is being edited. */
      mode: 'edit'
      /** Entry the form started from. */
      entry: ProjectRaidEntry
      /** Current form values. */
      values: EntryFormValues
    }

const inputClassName =
  'h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10 disabled:bg-[var(--workbench-surface-muted)]'
const textAreaClassName =
  'min-h-20 rounded-md border border-tone-d3d8df bg-surface px-3 py-2 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10'
const labelClassName = 'grid gap-1.5 text-sm font-semibold text-fg-505967'
const ratingOptions = ['1', '2', '3', '4', '5']

/** Badge colors of each severity. */
const severityClassNames: Record<ProjectRaidSeverity, string> = {
  low: 'border-slate-200 bg-slate-50 text-fg-slate-700',
  medium: 'border-amber-200 bg-amber-50 text-fg-amber-800',
  high: 'border-orange-200 bg-orange-50 text-fg-orange-700',
  critical: 'border-red-200 bg-red-50 text-fg-red-700',
}

/**
 * Names the message key of an entry kind.
 *
 * @param kind - Entry kind.
 * @returns The message key.
 */
function kindMessageKey(kind: ProjectRaidEntryKind): MessageKey {
  if (kind === 'risk') return 'projects.raidLog.kind.risk'
  if (kind === 'issue') return 'projects.raidLog.kind.issue'
  return 'projects.raidLog.kind.changeRequest'
}

/**
 * Names the message key of a severity.
 *
 * @param severity - Severity.
 * @returns The message key.
 */
function severityMessageKey(severity: ProjectRaidSeverity): MessageKey {
  if (severity === 'low') return 'projects.raidLog.severity.low'
  if (severity === 'medium') return 'projects.raidLog.severity.medium'
  if (severity === 'high') return 'projects.raidLog.severity.high'
  return 'projects.raidLog.severity.critical'
}

/**
 * Builds the form values of a new entry or of an existing one.
 *
 * @param entry - Entry to edit, or `undefined` for a new risk.
 * @returns The form values.
 */
function toFormValues(entry?: ProjectRaidEntry): EntryFormValues {
  return {
    kind: entry?.kind ?? 'risk',
    title: entry?.title ?? '',
    probability: String(entry?.probability ?? 3),
    impact: String(entry?.impact ?? 3),
    reviewDueDate: entry?.reviewDueDate ?? '',
    description: entry?.description ?? '',
    response: entry?.response ?? '',
    status: entry?.status ?? 'open',
  }
}

/**
 * Converts form values to entry input.
 *
 * @param values - Form values.
 * @returns The input sent to the server, which validates it again.
 */
function toEntryInput(values: EntryFormValues): ProjectRaidEntryInput {
  return {
    kind: values.kind,
    title: values.title,
    ...(values.kind === 'risk' ? { probability: Number(values.probability) } : {}),
    impact: Number(values.impact),
    ...(values.reviewDueDate ? { reviewDueDate: values.reviewDueDate } : {}),
    ...(values.description.trim() ? { description: values.description } : {}),
    ...(values.response.trim() ? { response: values.response } : {}),
    status: values.status,
  }
}

/**
 * Describes a failed save for the person who tried it.
 *
 * @param error - Thrown error.
 * @param t - Translator.
 * @returns The message to show.
 */
function describeSaveError(error: unknown, t: (key: MessageKey) => string) {
  if (error instanceof ProjectDirectoryApiError) {
    if (error.status === 409) return t('projects.raidLog.error.conflict')
    if (error.status === 403) return t('projects.raidLog.error.forbidden')
    if (error.status === 413) return t('projects.raidLog.error.full')
    if (error.status === 400) return t('projects.raidLog.error.invalid').replace('{reason}', error.message)
  }
  return t('projects.raidLog.error.save')
}

/**
 * Shows a Project's risks, issues, and change requests with their open counts and lets members
 * add, edit, close, and reopen them.
 *
 * @param props - Entries, permissions, and callbacks.
 * @returns The panel.
 */
export function ProjectRaidLogPanel({
  entries,
  isLoading,
  hasLoadError,
  today,
  canEdit,
  onSave,
  onReload,
  t,
}: ProjectRaidLogPanelProps) {
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [showClosed, setShowClosed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  // After a revision conflict the form keeps the draft and saves it onto the newest revision,
  // which the reloaded list provides; the person can also switch the form to that revision.
  const [conflictEntryId, setConflictEntryId] = useState<string>()
  const latestEditedEntry = editor.mode === 'edit' && conflictEntryId === editor.entry.id
    ? entries?.find((candidate) => candidate.id === editor.entry.id)
    : undefined
  const hasNewerRevision = editor.mode === 'edit' &&
    latestEditedEntry !== undefined &&
    latestEditedEntry.revision !== editor.entry.revision
  const summary = summarizeProjectRaidLog(entries ?? [], today)
  const visibleEntries = (entries ?? []).filter((entry) => showClosed || entry.status === 'open')

  /**
   * Changes one form value.
   *
   * @param key - Field to change.
   * @param value - New value.
   */
  function updateValue<K extends keyof EntryFormValues>(key: K, value: EntryFormValues[K]) {
    setEditor((current) => current.mode === 'closed' ? current : { ...current, values: { ...current.values, [key]: value } })
  }

  /**
   * Saves the open form.
   *
   * @param event - Form submission.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (editor.mode === 'closed' || isSaving) return
    setIsSaving(true)
    setSaveError(undefined)
    const baseEntry = editor.mode === 'edit' ? (latestEditedEntry ?? editor.entry) : undefined
    try {
      await onSave(baseEntry, toEntryInput(editor.values))
      setEditor({ mode: 'closed' })
      setConflictEntryId(undefined)
    } catch (error) {
      if (baseEntry && error instanceof ProjectDirectoryApiError && error.status === 409) {
        setEditor({ mode: 'edit', entry: baseEntry, values: editor.values })
        setConflictEntryId(baseEntry.id)
      }
      setSaveError(describeSaveError(error, t))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="project-raid-log-title"
      className="grid gap-4 rounded-md border border-tone-d3d8df bg-surface p-4"
      data-testid="project-raid-log"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-1c1d1f" id="project-raid-log-title">{t('projects.raidLog.title')}</h2>
          <p className="mt-1 text-sm font-medium text-fg-505967">{t('projects.raidLog.description')}</p>
        </div>
        {canEdit && editor.mode === 'closed' && entries ? (
          <button
            className="workbench-button-primary min-h-10 px-4"
            data-testid="project-raid-log-add"
            type="button"
            onClick={() => {
              setSaveError(undefined)
              setConflictEntryId(undefined)
              setEditor({ mode: 'create', values: toFormValues() })
            }}
          >
            {t('projects.raidLog.add')}
          </button>
        ) : null}
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('projects.raidLog.error.loading')}</p>
          <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onReload}>
            {t('projects.raidLog.reload')}
          </button>
        </div>
      ) : null}
      {isLoading && !entries ? (
        <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.raidLog.loading')}</p>
      ) : null}

      {entries ? (
        <ul aria-label={t('projects.raidLog.title')} className="flex flex-wrap gap-2" data-testid="project-raid-log-summary">
          <SummaryChip text={t('projects.raidLog.summary.risk').replace('{count}', String(summary.openCounts.risk))} />
          <SummaryChip text={t('projects.raidLog.summary.issue').replace('{count}', String(summary.openCounts.issue))} />
          <SummaryChip text={t('projects.raidLog.summary.changeRequest').replace('{count}', String(summary.openCounts['change-request']))} />
          {summary.highestOpenSeverity ? (
            <SummaryChip
              className={severityClassNames[summary.highestOpenSeverity]}
              text={t('projects.raidLog.summary.highest').replace('{severity}', t(severityMessageKey(summary.highestOpenSeverity)))}
            />
          ) : null}
          {summary.overdueReviewCount > 0 ? (
            <SummaryChip
              className={severityClassNames.critical}
              text={t('projects.raidLog.summary.overdue').replace('{count}', String(summary.overdueReviewCount))}
            />
          ) : null}
        </ul>
      ) : null}

      {editor.mode !== 'closed' ? (
        <form
          className="grid grid-cols-2 gap-3 rounded-md border border-tone-d3d8df p-3 max-[780px]:grid-cols-1"
          data-testid="project-raid-log-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          {/* Fields stay locked while a save is in flight, so no edit is lost when it completes. */}
          <fieldset className="contents" disabled={isSaving}>
            <label className={labelClassName}>
              {t('projects.raidLog.field.kind')}
              <select
                className={inputClassName}
                data-testid="project-raid-log-kind"
                disabled={editor.mode === 'edit'}
                value={editor.values.kind}
                onChange={(event) => {
                  const kind = PROJECT_RAID_ENTRY_KINDS.find((candidate) => candidate === event.target.value)
                  if (kind) updateValue('kind', kind)
                }}
              >
                {PROJECT_RAID_ENTRY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{t(kindMessageKey(kind))}</option>
                ))}
              </select>
            </label>
            <label className={labelClassName}>
              {t('projects.raidLog.field.status')}
              <select
                className={inputClassName}
                data-testid="project-raid-log-status"
                value={editor.values.status}
                onChange={(event) => updateValue('status', event.target.value === 'closed' ? 'closed' : 'open')}
              >
                <option value="open">{t('projects.raidLog.status.open')}</option>
                <option value="closed">{t('projects.raidLog.status.closed')}</option>
              </select>
            </label>
            <label className={`${labelClassName} col-span-full`}>
              {t('projects.raidLog.field.title')}
              <input
                className={inputClassName}
                data-testid="project-raid-log-title-input"
                maxLength={PROJECT_RAID_TITLE_MAX_LENGTH}
                required
                value={editor.values.title}
                onChange={(event) => updateValue('title', event.target.value)}
              />
            </label>
            {editor.values.kind === 'risk' ? (
              <label className={labelClassName}>
                {t('projects.raidLog.field.probability')}
                <select
                  className={inputClassName}
                  data-testid="project-raid-log-probability"
                  value={editor.values.probability}
                  onChange={(event) => updateValue('probability', event.target.value)}
                >
                  {ratingOptions.map((rating) => <option key={rating} value={rating}>{rating}</option>)}
                </select>
              </label>
            ) : null}
            <label className={labelClassName}>
              {t('projects.raidLog.field.impact')}
              <select
                className={inputClassName}
                data-testid="project-raid-log-impact"
                value={editor.values.impact}
                onChange={(event) => updateValue('impact', event.target.value)}
              >
                {ratingOptions.map((rating) => <option key={rating} value={rating}>{rating}</option>)}
              </select>
            </label>
            <label className={labelClassName}>
              {t('projects.raidLog.field.reviewDueDate')}
              <input
                className={inputClassName}
                data-testid="project-raid-log-review"
                type="date"
                value={editor.values.reviewDueDate}
                onChange={(event) => updateValue('reviewDueDate', event.target.value)}
              />
            </label>
            <label className={`${labelClassName} col-span-full`}>
              {t('projects.raidLog.field.description')}
              <textarea
                className={textAreaClassName}
                maxLength={PROJECT_RAID_TEXT_MAX_LENGTH}
                value={editor.values.description}
                onChange={(event) => updateValue('description', event.target.value)}
              />
            </label>
            <label className={`${labelClassName} col-span-full`}>
              {t('projects.raidLog.field.response')}
              <textarea
                className={textAreaClassName}
                maxLength={PROJECT_RAID_TEXT_MAX_LENGTH}
                value={editor.values.response}
                onChange={(event) => updateValue('response', event.target.value)}
              />
            </label>
            {hasNewerRevision && latestEditedEntry ? (
              <div
                className="col-span-full flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                role="status"
              >
                <p className="text-sm font-semibold text-fg-amber-800">{t('projects.raidLog.conflict.newer')}</p>
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  type="button"
                  onClick={() => {
                    setEditor({ mode: 'edit', entry: latestEditedEntry, values: toFormValues(latestEditedEntry) })
                    setConflictEntryId(undefined)
                    setSaveError(undefined)
                  }}
                >
                  {t('projects.raidLog.conflict.useLatest')}
                </button>
              </div>
            ) : saveError ? (
              <p className="col-span-full text-sm font-semibold text-fg-red-700" role="alert">{saveError}</p>
            ) : null}
            <div className="col-span-full flex flex-wrap gap-2">
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                data-testid="project-raid-log-save"
                disabled={isSaving}
                type="submit"
              >
                {t('projects.raidLog.save')}
              </button>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                disabled={isSaving}
                type="button"
                onClick={() => {
                  setEditor({ mode: 'closed' })
                  setConflictEntryId(undefined)
                }}
              >
                {t('projects.raidLog.cancel')}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {entries && entries.length === 0 ? (
        <p className="text-sm font-medium text-fg-505967">{t('projects.raidLog.empty')}</p>
      ) : null}
      {entries && entries.length > 0 ? (
        <>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-505967">
            <input checked={showClosed} type="checkbox" onChange={(event) => setShowClosed(event.target.checked)} />
            {t('projects.raidLog.showClosed')}
          </label>
          <ul className="grid gap-2" data-testid="project-raid-log-entries">
            {visibleEntries.map((entry) => {
              const severity = deriveProjectRaidSeverity(entry)
              const overdue = isProjectRaidReviewOverdue(entry, today)
              return (
                <li className="grid gap-1 rounded-md border border-tone-d3d8df px-3 py-2" data-testid="project-raid-log-entry" key={entry.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-fg-505967">
                      {t(kindMessageKey(entry.kind))}
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${severityClassNames[severity]}`}>
                      {t(severityMessageKey(severity))}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-fg-1c1d1f">{entry.title}</span>
                    <span className="text-xs font-semibold text-fg-505967">
                      {t(entry.status === 'open' ? 'projects.raidLog.status.open' : 'projects.raidLog.status.closed')}
                    </span>
                    {canEdit && editor.mode === 'closed' ? (
                      <button
                        aria-label={`${t('projects.raidLog.edit')}: ${entry.title}`}
                        className="workbench-button-secondary min-h-8 px-3"
                        type="button"
                        onClick={() => {
                          setSaveError(undefined)
                          setConflictEntryId(undefined)
                          setEditor({ mode: 'edit', entry, values: toFormValues(entry) })
                        }}
                      >
                        {t('projects.raidLog.edit')}
                      </button>
                    ) : null}
                  </div>
                  {entry.reviewDueDate ? (
                    <p className={`text-xs font-medium ${overdue ? 'text-fg-red-700' : 'text-fg-505967'}`}>
                      {t('projects.raidLog.reviewDue').replace('{date}', entry.reviewDueDate)}
                      {overdue ? ` ${t('projects.raidLog.overdue')}` : null}
                    </p>
                  ) : null}
                  {entry.description ? <p className="whitespace-pre-wrap text-sm text-fg-1c1d1f">{entry.description}</p> : null}
                  {entry.response ? (
                    <p className="whitespace-pre-wrap text-sm text-fg-505967">
                      <span className="font-semibold">{t('projects.raidLog.field.response')}: </span>
                      {entry.response}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
      {!canEdit && entries ? (
        <p className="text-xs font-medium text-fg-505967">{t('projects.raidLog.readOnly')}</p>
      ) : null}
    </section>
  )
}

/**
 * Shows one summary figure.
 *
 * @param props - Text and optional color classes.
 * @returns The chip.
 */
function SummaryChip({ text, className = 'border-slate-200 bg-slate-50 text-fg-slate-700' }: {
  /** Text of the chip. */
  text: string
  /** Color classes. */
  className?: string
}) {
  return <li className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>{text}</li>
}
