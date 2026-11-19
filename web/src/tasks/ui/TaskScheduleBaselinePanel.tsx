import { useState } from 'react'
import {
  deriveWorkItemScheduleSlip,
  type CanonicalWorkItem,
  type ProjectScheduleBaseline,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { useCaptureProjectScheduleBaseline } from '../../work-items/mutations/useCaptureProjectScheduleBaseline'
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
  /** Whether to offer saving a new Project baseline; the server still checks the role. */
  canCapture: boolean
  /** Disables the save button while the view is read-only. */
  disabled: boolean
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Shows the Work Item's frozen baseline dates and how far its current plan slipped from them.
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
  const query = useProjectScheduleBaseline(accessToken, teamId, projectId)
  const captureBaseline = useCaptureProjectScheduleBaseline()
  const [pendingScope, setPendingScope] = useState<string | undefined>()
  const [failedScope, setFailedScope] = useState<string | undefined>()
  const scope = `${teamId}/${projectId}`
  const isCapturing = pendingScope === scope

  /** Saves a new Project baseline; the response lands in that Project's cache entry only. */
  const capture = async () => {
    setPendingScope(scope)
    setFailedScope(undefined)
    try {
      await captureBaseline(accessToken, teamId, projectId)
    } catch {
      setFailedScope(scope)
    } finally {
      setPendingScope((current) => current === scope ? undefined : current)
    }
  }

  return (
    <TaskScheduleBaselineView
      canCapture={canCapture}
      captureFailed={failedScope === scope}
      disabled={disabled || isCapturing}
      onCapture={() => {
        void capture()
      }}
      onRetry={() => {
        void query.mutate()
      }}
      state={
        query.data
          ? { status: 'ready', baseline: query.data.baseline }
          : query.error !== undefined
            ? { status: 'error' }
            : { status: 'loading' }
      }
      t={t}
      task={task}
    />
  )
}

/** Load state of a Project baseline as the view shows it. */
export type TaskScheduleBaselineState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
    /** The baseline was read. */
    status: 'ready'
    /** Latest baseline, or `null` when none was saved. */
    baseline: ProjectScheduleBaseline | null
  }

/** Props for the presentational baseline section. */
export type TaskScheduleBaselineViewProps = {
  /** Work Item whose current plan is compared with the baseline. */
  task: CanonicalWorkItem
  /** Load state of the Project baseline. */
  state: TaskScheduleBaselineState
  /** Whether to offer saving a new Project baseline. */
  canCapture: boolean
  /** Whether the last save for this Project failed. */
  captureFailed: boolean
  /** Disables the save button. */
  disabled: boolean
  /** Saves a new Project baseline. */
  onCapture: () => void
  /** Reads the existing baseline again without saving a new one. */
  onRetry: () => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the baseline dates, the slips, and the save button without reading any data.
 *
 * @param props - Work Item, baseline state, and the save callback.
 * @returns The baseline section.
 */
export function TaskScheduleBaselineView({
  task,
  state,
  canCapture,
  captureFailed,
  disabled,
  onCapture,
  onRetry,
  t,
}: TaskScheduleBaselineViewProps) {
  const baseline = state.status === 'ready' ? state.baseline : null
  const entry = baseline?.entries.find((candidate) => candidate.workItemId === task.id)
  const slip = entry ? deriveWorkItemScheduleSlip(entry, task.schedule) : undefined
  const baselineDates = entry
    ? [entry.startDate, entry.endDate]
      .filter((date, index, dates): date is string => date !== undefined && dates.indexOf(date) === index)
      .join(' – ')
    : ''

  return (
    <section
      aria-label={t('tasks.detail.scheduleBaseline')}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="task-detail-schedule-baseline"
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('tasks.detail.scheduleBaseline')}</h3>
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
        </dl>
      ) : null}
      {baseline ? (
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {t('tasks.detail.baselineCapturedAt').replace('{date}', baseline.capturedAt.slice(0, 10))}
        </p>
      ) : null}
      {canCapture ? (
        <div className="grid gap-2">
          <p className="text-xs text-[var(--workbench-muted)]">{t('tasks.detail.baselineCaptureHint')}</p>
          <button
            className="workbench-button-secondary min-h-[44px] px-3 disabled:border-slate-300 disabled:bg-slate-300"
            disabled={disabled || state.status === 'loading'}
            onClick={onCapture}
            type="button"
          >
            {t('tasks.detail.baselineCapture')}
          </button>
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
