import { useState } from 'react'
import {
  deriveWorkItemScheduleSlip,
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
  type CanonicalWorkItem,
  type ProjectScheduleBaseline,
  type SavedProjectScheduleBaseline,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { formatPlannedEffortHours } from '../../work-items/model/contributorAssignments'
import {
  useActivateProjectScheduleBaseline,
  useCaptureProjectScheduleBaseline,
} from '../../work-items/mutations/useCaptureProjectScheduleBaseline'
import { useProjectScheduleBaseline } from '../../work-items/queries/useProjectScheduleBaseline'
import {
  formatTaskScheduleVariance,
  resolveTaskScheduleVarianceTone,
  taskScheduleVarianceToneClasses,
} from '../model/taskActualDates'

/** Props for the baseline section of the task detail pane. */
export type TaskScheduleBaselinePanelProps = {
  /** Work Item whose current plan is compared with the Project baseline. */
  task: CanonicalWorkItem
  /** Project the Work Item is assigned to. */
  projectId: string
  /** Access token sent as the bearer token. */
  accessToken: string
  /** Whether to offer saving and switching Project baselines; the server still checks the role. */
  canCapture: boolean
  /** Disables the save and switch buttons while the view is read-only. */
  disabled: boolean
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Shows the Work Item's frozen baseline dates and how far its current plan slipped from them,
 * with a choice among the Project's saved baselines.
 *
 * @param props - Work Item, Project, token, and permissions.
 * @returns The baseline section.
 */
export function TaskScheduleBaselinePanel({
  task,
  projectId,
  accessToken,
  canCapture,
  disabled,
  t,
}: TaskScheduleBaselinePanelProps) {
  const { teamId } = task
  const scope = `${teamId}/${projectId}`
  const [viewed, setViewed] = useState<{ scope: string; baselineId: string } | undefined>()
  const activeQuery = useProjectScheduleBaseline(accessToken, teamId, projectId)
  const activeBaselineId = activeQuery.data?.activeBaselineId
  const viewedBaselineId = viewed?.scope === scope && viewed.baselineId !== activeBaselineId ? viewed.baselineId : undefined
  const savedQuery = useProjectScheduleBaseline(accessToken, teamId, projectId, viewedBaselineId, viewedBaselineId !== undefined)
  const query = viewedBaselineId === undefined ? activeQuery : savedQuery
  const captureBaseline = useCaptureProjectScheduleBaseline()
  const activateBaseline = useActivateProjectScheduleBaseline()
  const [pending, setPending] = useState<{ scope: string; action: 'capture' | 'activate' } | undefined>()
  const [failed, setFailed] = useState<{ scope: string; action: 'capture' | 'activate' } | undefined>()
  const pendingAction = pending?.scope === scope ? pending.action : undefined
  const failedAction = failed?.scope === scope ? failed.action : undefined

  /**
   * Runs one baseline write for this Project and records its progress and failure.
   *
   * @param action - Which write runs.
   * @param run - The write.
   */
  const runWrite = async (action: 'capture' | 'activate', run: () => Promise<unknown>) => {
    setPending({ scope, action })
    setFailed(undefined)
    try {
      await run()
      setViewed(undefined)
    } catch {
      setFailed({ scope, action })
    } finally {
      setPending((current) => current?.scope === scope ? undefined : current)
    }
  }

  return (
    <TaskScheduleBaselineView
      activeBaselineId={activeBaselineId}
      canCapture={canCapture}
      captureFailed={failedAction === 'capture'}
      capturing={pendingAction === 'capture'}
      activateFailed={failedAction === 'activate'}
      activating={pendingAction === 'activate'}
      disabled={disabled || pendingAction !== undefined}
      onActivate={() => {
        const revision = activeQuery.data?.baseline?.revision
        if (viewedBaselineId === undefined || revision === undefined) return
        void runWrite('activate', () => activateBaseline(accessToken, teamId, projectId, viewedBaselineId, revision))
      }}
      onCapture={(name) => {
        void runWrite('capture', () => captureBaseline(accessToken, teamId, projectId, name))
      }}
      onRetry={() => {
        void query.mutate()
      }}
      onSelectBaseline={(baselineId) => setViewed({ scope, baselineId })}
      savedBaselines={activeQuery.data?.savedBaselines ?? []}
      state={
        query.data
          ? { status: 'ready', baseline: query.data.baseline }
          : query.error !== undefined
            ? { status: 'error' }
            : { status: 'loading' }
      }
      t={t}
      task={task}
      viewedBaselineId={viewedBaselineId ?? activeBaselineId}
    />
  )
}

/** Load state of a Project baseline as the view shows it. */
export type TaskScheduleBaselineState =
  | {
    /** The baseline is being read for the first time. */
    status: 'loading'
  }
  | {
    /** The baseline could not be read. */
    status: 'error'
  }
  | {
    /** The baseline was read. */
    status: 'ready'
    /** Shown baseline, or `null` when none was saved. */
    baseline: ProjectScheduleBaseline | null
  }

/** Props for the presentational baseline section. */
export type TaskScheduleBaselineViewProps = {
  /** Work Item whose current plan is compared with the baseline. */
  task: CanonicalWorkItem
  /** Load state of the shown baseline. */
  state: TaskScheduleBaselineState
  /** Saved baselines of the Project, newest first. */
  savedBaselines?: readonly SavedProjectScheduleBaseline[]
  /** ID of the active baseline that the Gantt, tables, Focus, and updates compare against. */
  activeBaselineId?: string
  /** ID of the baseline shown here. */
  viewedBaselineId?: string
  /** Whether to offer saving and switching Project baselines. */
  canCapture: boolean
  /** Whether the last save for this Project failed. */
  captureFailed: boolean
  /** Whether a save for this Project is running. */
  capturing: boolean
  /** Whether the last switch for this Project failed. */
  activateFailed?: boolean
  /** Whether a switch for this Project is running. */
  activating?: boolean
  /** Disables the save and switch buttons. */
  disabled: boolean
  /** Saves a new Project baseline with an optional name. */
  onCapture: (name?: string) => void
  /** Shows another saved baseline here without changing the active one. */
  onSelectBaseline?: (baselineId: string) => void
  /** Makes the shown baseline the active one. */
  onActivate?: () => void
  /** Reads the shown baseline again without saving a new one. */
  onRetry: () => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Names a saved baseline for the picker.
 *
 * @param baseline - Saved baseline.
 * @param isActive - Whether it is the active baseline.
 * @param t - Translator.
 * @returns The option label.
 */
function formatSavedBaselineLabel(
  baseline: Pick<SavedProjectScheduleBaseline, 'name' | 'capturedAt'>,
  isActive: boolean,
  t: (key: MessageKey) => string,
) {
  const date = baseline.capturedAt.slice(0, 10)
  const label = baseline.name ? `${baseline.name} (${date})` : t('tasks.detail.baselineCapturedAt').replace('{date}', date)
  return isActive ? `${label} · ${t('tasks.detail.baselineActive')}` : label
}

/**
 * Formats a signed effort change in hours.
 *
 * @param minutes - Signed minutes, or undefined when unknown.
 * @param t - Translator.
 * @returns The label.
 */
function formatEffortDelta(minutes: number | undefined, t: (key: MessageKey) => string) {
  if (minutes === undefined) return '—'
  if (minutes === 0) return t('tasks.detail.baselineEffortSame')
  return t(minutes > 0 ? 'tasks.detail.baselineEffortMore' : 'tasks.detail.baselineEffortLess')
    .replace('{hours}', formatPlannedEffortHours(Math.abs(minutes)))
}

/**
 * Renders the baseline dates, the slips, the saved-baseline picker, and the save and switch
 * buttons without reading any data.
 *
 * @param props - Work Item, baseline state, and the callbacks.
 * @returns The baseline section.
 */
export function TaskScheduleBaselineView({
  task,
  state,
  savedBaselines = [],
  activeBaselineId,
  viewedBaselineId,
  canCapture,
  captureFailed,
  capturing,
  activateFailed = false,
  activating = false,
  disabled,
  onCapture,
  onSelectBaseline,
  onActivate,
  onRetry,
  t,
}: TaskScheduleBaselineViewProps) {
  const [name, setName] = useState('')
  const baseline = state.status === 'ready' ? state.baseline : null
  const entry = baseline?.entries.find((candidate) => candidate.workItemId === task.id)
  const slip = entry ? deriveWorkItemScheduleSlip(entry, task.schedule) : undefined
  const baselineDates = entry
    ? [entry.startDate, entry.endDate]
      .filter((date, index, dates): date is string => date !== undefined && dates.indexOf(date) === index)
      .join(' – ')
    : ''
  const viewingInactive = viewedBaselineId !== undefined && activeBaselineId !== undefined && viewedBaselineId !== activeBaselineId

  return (
    <section
      aria-label={t('tasks.detail.scheduleBaseline')}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="task-detail-schedule-baseline"
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('tasks.detail.scheduleBaseline')}</h3>
      {savedBaselines.length > 1 && onSelectBaseline ? (
        <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('tasks.detail.baselinePicker')}
          <select
            className="workbench-input h-10 min-w-0 px-2 text-sm"
            data-testid="task-detail-baseline-picker"
            onChange={(event) => onSelectBaseline(event.target.value)}
            value={viewedBaselineId ?? activeBaselineId ?? ''}
          >
            {savedBaselines.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {formatSavedBaselineLabel(saved, saved.id === activeBaselineId, t)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {state.status === 'loading' ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('tasks.detail.baselineLoading')}</p>
      ) : null}
      {state.status === 'error' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-[var(--workbench-muted)]">{t('tasks.detail.baselineLoadError')}</p>
          <button className="workbench-button-secondary min-h-[44px] px-3" onClick={onRetry} type="button">
            {t('tasks.detail.baselineRetry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && !baseline ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('tasks.detail.baselineNone')}</p>
      ) : null}
      {baseline && !entry ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('tasks.detail.baselineNotIncluded')}</p>
      ) : null}
      {baseline && entry && slip ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-[var(--workbench-muted)]">{t('tasks.detail.baselineDates')}</dt>
          <dd className="min-w-0 text-[var(--workbench-text)]" data-testid="task-detail-baseline-dates">
            {baselineDates || '—'}
          </dd>
          <SlipRow days={slip.startSlipDays} label={t('tasks.detail.baselineStartSlip')} t={t} />
          <SlipRow
            days={slip.endSlipDays}
            label={t('tasks.detail.baselineEndSlip')}
            t={t}
            testId="task-detail-baseline-end-slip"
          />
          {entry.plannedEffortMinutes !== undefined ? (
            <>
              <dt className="text-[var(--workbench-muted)]">{t('tasks.detail.baselineEffort')}</dt>
              <dd className="min-w-0 text-[var(--workbench-text)]" data-testid="task-detail-baseline-effort">
                {`${formatPlannedEffortHours(entry.plannedEffortMinutes)}h · ${formatEffortDelta(slip.effortDeltaMinutes, t)}`}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {baseline ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {formatSavedBaselineLabel(baseline, !viewingInactive, t)}
        </p>
      ) : null}
      {viewingInactive ? (
        <p className="text-xs text-[var(--workbench-muted)]">{t('tasks.detail.baselineViewingInactive')}</p>
      ) : null}
      {canCapture && viewingInactive && onActivate ? (
        <div className="grid gap-2">
          <button
            className="workbench-button-secondary min-h-[44px] px-3 disabled:border-slate-300 disabled:bg-slate-300"
            disabled={disabled || state.status !== 'ready'}
            onClick={onActivate}
            type="button"
          >
            {t('tasks.detail.baselineActivate')}
          </button>
          {activating ? (
            <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('tasks.detail.baselineActivating')}</p>
          ) : null}
          {activateFailed ? (
            <p className="text-sm text-fg-red-700" role="alert">{t('tasks.detail.baselineActivateError')}</p>
          ) : null}
        </div>
      ) : null}
      {canCapture ? (
        <div className="grid gap-2">
          <p className="text-xs text-[var(--workbench-muted)]">{t('tasks.detail.baselineCaptureHint')}</p>
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('tasks.detail.baselineName')}
            <input
              className="workbench-input h-10 min-w-0 px-2 text-sm"
              disabled={disabled}
              maxLength={PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('tasks.detail.baselineNamePlaceholder')}
              value={name}
            />
          </label>
          <button
            className="workbench-button-secondary min-h-[44px] px-3 disabled:border-slate-300 disabled:bg-slate-300"
            disabled={disabled || state.status === 'loading'}
            onClick={() => {
              onCapture(name.trim() || undefined)
              setName('')
            }}
            type="button"
          >
            {t('tasks.detail.baselineCapture')}
          </button>
          {capturing ? (
            <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('tasks.detail.baselineCapturing')}</p>
          ) : null}
          {captureFailed ? (
            <p className="text-sm text-fg-red-700" role="alert">{t('tasks.detail.baselineCaptureError')}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** Props for one slip row. */
type SlipRowProps = {
  /** Signed slip in calendar days, or undefined when unknown. */
  days: number | undefined
  /** Row label. */
  label: string
  /** Translator for the slip label. */
  t: (key: MessageKey) => string
  /** Optional test identifier for the value. */
  testId?: string
}

/**
 * Renders one slip row with the same tone as the plan-versus-actual delays.
 *
 * @param props - Slip, label, and translator.
 * @returns The term and description pair.
 */
function SlipRow({ days, label, t, testId }: SlipRowProps) {
  const tone = resolveTaskScheduleVarianceTone(days)
  return (
    <>
      <dt className="text-[var(--workbench-muted)]">{label}</dt>
      <dd
        className={`min-w-0 ${tone ? taskScheduleVarianceToneClasses[tone] : 'text-[var(--workbench-muted)]'}`}
        data-testid={testId}
      >
        {formatTaskScheduleVariance(days, t)}
      </dd>
    </>
  )
}
