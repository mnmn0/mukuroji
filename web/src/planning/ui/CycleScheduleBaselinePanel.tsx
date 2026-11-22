import {
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
  type CycleScheduleBaselineResponse,
  type PlanningEntity,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import { useState } from 'react'
import { compareCycleBaseline } from '../model/cycleBaselines'
import { useCycleScheduleBaselines } from '../mutations/useCycleScheduleBaselines'

/** Localized labels of the Cycle baseline section. */
export type CycleScheduleBaselineLabels = {
  /** Section heading. */
  title: string
  /** Explains what a Cycle baseline freezes and who may save one. */
  hint: string
  /** Shown before the first save. */
  none: string
  /** Loading message. */
  loading: string
  /** Load failure message. */
  loadError: string
  /** Retry button. */
  retry: string
  /** Baseline picker label. */
  picker: string
  /** Option text of one saved baseline. */
  option: (name: string | undefined, capturedAt: string) => string
  /** Name input label. */
  name: string
  /** Name input placeholder. */
  namePlaceholder: string
  /** Save button. */
  capture: string
  /** Saving message. */
  capturing: string
  /** Save failure message. */
  captureError: string
  /** Committed Work Items at the baseline. */
  committed: (count: number) => string
  /** Work Items still in the Cycle. */
  stillIn: (count: number) => string
  /** Work Items added since the baseline. */
  added: (count: number) => string
  /** Work Items removed since the baseline. */
  removed: (count: number) => string
  /** Work Items the reader cannot see. */
  hidden: (count: number) => string
  /** Planned effort change; positive means more effort now. */
  effortDelta: (minutes: number) => string
  /** Heading of the slipped list. */
  slippedTitle: string
  /** One slipped Work Item's delay. */
  slippedDays: (days: number) => string
  /** No Work Item moved its end later. */
  slippedNone: string
}

/** Props of the Cycle baseline section. */
export type CycleScheduleBaselinePanelProps = {
  /** Cycle whose baselines are shown. */
  cycle: PlanningEntity
  /** Current Planning snapshot, for the Cycle's current Work Items. */
  snapshot: Pick<PlanningSnapshot, 'workItemLinks' | 'workItems'>
  /** Baseline response, or undefined while it loads or after a failure. */
  response?: CycleScheduleBaselineResponse
  /** Whether the response is loading. */
  isLoading: boolean
  /** Whether the response failed to load. */
  hasError: boolean
  /** Whether the viewer manages the Cycle and may save a baseline. */
  canCapture: boolean
  /** Whether a save is running. */
  isCapturing: boolean
  /** Whether the last save failed. */
  captureFailed: boolean
  /** Localized labels. */
  labels: CycleScheduleBaselineLabels
  /** Saves a new baseline with an optional name. */
  onCapture: (name: string) => void
  /** Chooses which saved baseline to compare against. */
  onSelect: (baselineId: string) => void
  /** Loads the baseline again. */
  onRetry: () => void
}

/**
 * Shows how a Cycle moved since a saved baseline: scope added and removed, planned ends that
 * slipped, and the planned effort change. A Cycle manager can save a new named baseline.
 *
 * @param props - Baseline response, Cycle, snapshot, and handlers.
 * @returns The baseline section.
 */
export function CycleScheduleBaselinePanel({
  canCapture,
  captureFailed,
  cycle,
  hasError,
  isCapturing,
  isLoading,
  labels,
  onCapture,
  onRetry,
  onSelect,
  response,
  snapshot,
}: CycleScheduleBaselinePanelProps) {
  const [name, setName] = useState('')
  const baseline = response?.baseline ?? null
  const comparison = baseline ? compareCycleBaseline(baseline, cycle.id, snapshot) : undefined
  return (
    <section className="workbench-panel-muted grid min-w-0 gap-3 p-3" data-testid="cycle-baseline">
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.title}</h3>
      {isLoading ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{labels.loading}</p>
      ) : hasError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-[var(--workbench-muted)]">{labels.loadError}</p>
          <button className="workbench-button-secondary min-h-[44px] px-3" type="button" onClick={onRetry}>
            {labels.retry}
          </button>
        </div>
      ) : !baseline ? (
        <p className="text-sm text-[var(--workbench-muted)]" data-testid="cycle-baseline-none">{labels.none}</p>
      ) : (
        <>
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {labels.picker}
            <select
              className="workbench-input h-10 min-w-0 px-2 text-sm"
              data-testid="cycle-baseline-picker"
              value={baseline.id}
              onChange={(event) => onSelect(event.target.value)}
            >
              {(response?.savedBaselines ?? []).map((item) => (
                <option key={item.id} value={item.id}>{labels.option(item.name, item.capturedAt)}</option>
              ))}
            </select>
          </label>
          {comparison ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold" data-testid="cycle-baseline-summary">
                <span className="workbench-badge">{labels.committed(comparison.committed)}</span>
                <span className="text-[var(--workbench-muted)]">{labels.stillIn(comparison.stillIn)}</span>
                <span className="workbench-badge" data-testid="cycle-baseline-added">{labels.added(comparison.added.length)}</span>
                <span className="workbench-badge" data-testid="cycle-baseline-removed">{labels.removed(comparison.removed.length)}</span>
                {comparison.hidden > 0 ? (
                  <span className="text-[var(--workbench-muted)]">{labels.hidden(comparison.hidden)}</span>
                ) : null}
                <span className="text-[var(--workbench-muted)]" data-testid="cycle-baseline-effort">
                  {labels.effortDelta(comparison.effortDeltaMinutes)}
                </span>
              </div>
              <div className="grid gap-1">
                <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.slippedTitle}</h4>
                {comparison.slipped.length === 0 ? (
                  <p className="text-sm text-[var(--workbench-muted)]">{labels.slippedNone}</p>
                ) : (
                  <ul className="grid gap-1 text-sm" data-testid="cycle-baseline-slipped">
                    {comparison.slipped.map(({ workItem, endSlipDays }) => (
                      <li className="flex min-w-0 items-center justify-between gap-2" key={`${workItem.teamId}/${workItem.id}`}>
                        <span className="min-w-0 truncate text-[var(--workbench-text)]">{workItem.title}</span>
                        <span className="workbench-badge-danger shrink-0">{labels.slippedDays(endSlipDays)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
      {canCapture ? (
        <form
          className="grid gap-2"
          data-testid="cycle-baseline-capture"
          onSubmit={(event) => {
            event.preventDefault()
            onCapture(name)
            setName('')
          }}
        >
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {labels.name}
            <input
              className="workbench-input h-10 min-w-0 px-2 text-sm"
              data-testid="cycle-baseline-name"
              maxLength={PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH}
              placeholder={labels.namePlaceholder}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            className="workbench-button-secondary min-h-[44px] px-3 disabled:opacity-50"
            disabled={isCapturing}
            type="submit"
          >
            {labels.capture}
          </button>
          <p className="text-xs text-[var(--workbench-muted)]">{labels.hint}</p>
          {isCapturing ? <p className="text-sm text-[var(--workbench-muted)]" role="status">{labels.capturing}</p> : null}
          {captureFailed ? <p className="text-sm text-[var(--workbench-danger)]" role="alert">{labels.captureError}</p> : null}
        </form>
      ) : null}
    </section>
  )
}

/** Props of the Cycle baseline section bound to the Planning API. */
export type CycleScheduleBaselineContainerProps = {
  /** Planning API access token. */
  accessToken: string
  /** Cycle whose baselines are shown. */
  cycle: PlanningEntity
  /** Current Planning snapshot. */
  snapshot: Pick<PlanningSnapshot, 'workItemLinks' | 'workItems'>
  /** Whether the viewer manages the Cycle. */
  canCapture: boolean
  /** Localized labels. */
  labels: CycleScheduleBaselineLabels
}

/**
 * Loads a Cycle's baselines, saves new ones, and shows the comparison.
 *
 * @param props - Access token, Cycle, snapshot, permission, and labels.
 * @returns The baseline section bound to the Planning API.
 */
export function CycleScheduleBaselineContainer({
  accessToken,
  canCapture,
  cycle,
  labels,
  snapshot,
}: CycleScheduleBaselineContainerProps) {
  const { query, select, retry, capture, isCapturing, captureFailed } = useCycleScheduleBaselines(accessToken, cycle.id)
  return (
    <CycleScheduleBaselinePanel
      canCapture={canCapture}
      captureFailed={captureFailed}
      cycle={cycle}
      hasError={Boolean(query.error)}
      isCapturing={isCapturing}
      isLoading={query.isLoading}
      labels={labels}
      response={query.data}
      snapshot={snapshot}
      onCapture={(name) => void capture(name)}
      onRetry={retry}
      onSelect={select}
    />
  )
}
