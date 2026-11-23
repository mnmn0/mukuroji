import type {
  ProjectRaidChangeDecisionOutcome,
  ProjectRaidEntry,
  ProjectRaidScheduleChange,
  ProjectRaidScheduleChangeOperation,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { operationDate } from '../model/projectChangeRequestDecision'
import { labelProjectRaidReference, type ProjectRaidReferenceOption } from '../model/projectRaidLogExport'

/** Options of one decision, as the panel passes them to its owner. */
export type ProjectChangeRequestDecisionChoice = {
  /** On approval, save the plan after the date changes as the new active baseline. */
  replaceBaseline: boolean
}

/** Props of the requested date changes field. */
type ScheduleChangesFieldProps = {
  /** Related Work Items, in the order the entry names them. */
  relatedWorkItemIds: readonly string[]
  /** Work Items with their display text. */
  workItemOptions: readonly ProjectRaidReferenceOption[]
  /** Requested changes so far. */
  value: readonly ProjectRaidScheduleChange[]
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /**
   * Receives the next changes.
   *
   * @param changes - Requested changes.
   */
  onChange: (changes: ProjectRaidScheduleChange[]) => void
}

/** Kind of change selected for one Work Item in the form, or none. */
type ScheduleChangeKind = 'none' | ProjectRaidScheduleChangeOperation['type']

/**
 * Builds a requested change from the form inputs.
 *
 * @param kind - Selected kind.
 * @param date - Entered date, possibly empty.
 * @returns The operation, or `undefined` for none.
 */
function toOperation(kind: ScheduleChangeKind, date: string): ProjectRaidScheduleChangeOperation | undefined {
  if (kind === 'move') return { type: 'move', targetDate: date }
  if (kind === 'resize') return { type: 'resize', endDate: date }
  return undefined
}

/**
 * Lets the author of a change request state the date change it asks for on each related Work
 * Item: move it to a date, or change the end of a date range.
 *
 * @param props - Related Work Items, current changes, and change callback.
 * @returns The field, or nothing while no Work Item is related.
 */
export function ScheduleChangesField({ relatedWorkItemIds, workItemOptions, value, t, onChange }: ScheduleChangesFieldProps) {
  if (relatedWorkItemIds.length === 0) {
    return <p className="col-span-full text-xs font-medium text-fg-505967">{t('projects.raidLog.schedule.needsRelated')}</p>
  }

  /**
   * Replaces the change of one Work Item, keeping the order of the related list.
   *
   * @param workItemId - Work Item.
   * @param operation - New change, or `undefined` for none.
   */
  function setChange(workItemId: string, operation: ProjectRaidScheduleChangeOperation | undefined) {
    onChange(relatedWorkItemIds.flatMap((id) => {
      if (id === workItemId) return operation ? [{ workItemId, operation }] : []
      const current = value.find((change) => change.workItemId === id)
      return current ? [current] : []
    }))
  }

  return (
    <fieldset className="col-span-full grid gap-2 rounded-md border border-tone-d3d8df p-3" data-testid="project-raid-log-schedule-changes">
      <legend className="px-1 text-sm font-semibold text-fg-505967">{t('projects.raidLog.schedule.title')}</legend>
      <p className="text-xs font-medium text-fg-505967">{t('projects.raidLog.schedule.help')}</p>
      {relatedWorkItemIds.map((workItemId) => {
        const label = labelProjectRaidReference(workItemOptions, workItemId)
        const current = value.find((change) => change.workItemId === workItemId)
        const kind: ScheduleChangeKind = current?.operation.type ?? 'none'
        const date = current ? operationDate(current.operation) : ''
        return (
          <div className="flex flex-wrap items-end gap-2" data-testid="project-raid-log-schedule-change" key={workItemId}>
            <span className="min-w-0 flex-1 basis-48 text-sm font-semibold text-fg-1c1d1f">{label}</span>
            <label className="grid gap-1 text-xs font-semibold text-fg-505967">
              {t('projects.raidLog.schedule.kind')}
              <select
                aria-label={`${t('projects.raidLog.schedule.kind')}: ${label}`}
                className="h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f"
                value={kind}
                onChange={(event) => {
                  const next = event.target.value === 'move' || event.target.value === 'resize' ? event.target.value : 'none'
                  setChange(workItemId, toOperation(next, date))
                }}
              >
                <option value="none">{t('projects.raidLog.schedule.none')}</option>
                <option value="move">{t('projects.raidLog.schedule.move')}</option>
                <option value="resize">{t('projects.raidLog.schedule.resize')}</option>
              </select>
            </label>
            {kind !== 'none' ? (
              <label className="grid gap-1 text-xs font-semibold text-fg-505967">
                {t(kind === 'move' ? 'projects.raidLog.schedule.targetDate' : 'projects.raidLog.schedule.endDate')}
                <input
                  aria-label={`${t(kind === 'move' ? 'projects.raidLog.schedule.targetDate' : 'projects.raidLog.schedule.endDate')}: ${label}`}
                  className="h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f"
                  required
                  type="date"
                  value={date}
                  onChange={(event) => setChange(workItemId, toOperation(kind, event.target.value))}
                />
              </label>
            ) : null}
          </div>
        )
      })}
    </fieldset>
  )
}

/** Props of the decision part of one change request. */
type ChangeRequestDecisionProps = {
  /** The change request. */
  entry: ProjectRaidEntry
  /** Whether the viewer may approve or reject it. */
  canDecide: boolean
  /** Members, to name the person who decided. */
  ownerOptions: readonly ProjectRaidReferenceOption[]
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /**
   * Approves or rejects the request.
   *
   * @param entry - The change request.
   * @param outcome - Approve or reject.
   * @param choice - Whether to replace the baseline on approval.
   */
  onDecide?: (entry: ProjectRaidEntry, outcome: ProjectRaidChangeDecisionOutcome, choice: ProjectChangeRequestDecisionChoice) => Promise<void>
  /**
   * Describes a failed decision.
   *
   * @param error - Thrown error.
   * @returns The message to show.
   */
  describeError: (error: unknown) => string
}

/**
 * Shows the decision on a change request, or lets a Project manager approve or reject an open
 * one. Approving asks once for confirmation, because it moves the requested dates and can replace
 * the baseline.
 *
 * @param props - Entry, permission, and decision callback.
 * @returns The decision line or controls, or nothing.
 */
export function ChangeRequestDecision({ entry, canDecide, ownerOptions, t, onDecide, describeError }: ChangeRequestDecisionProps) {
  const [confirming, setConfirming] = useState(false)
  const [replaceBaseline, setReplaceBaseline] = useState(true)
  const [pending, setPending] = useState<ProjectRaidChangeDecisionOutcome>()
  const [error, setError] = useState<string>()

  if (entry.decision) {
    const key: MessageKey = entry.decision.outcome === 'approved'
      ? 'projects.raidLog.decision.approved'
      : 'projects.raidLog.decision.rejected'
    return (
      <p className="text-xs font-semibold text-fg-505967" data-testid="project-raid-log-decision">
        {t(key)
          .replace('{name}', labelProjectRaidReference(ownerOptions, entry.decision.decidedByMemberId))
          .replace('{date}', entry.decision.decidedAt.slice(0, 10))}
        {entry.decision.baselineId ? ` ${t('projects.raidLog.decision.baselineReplaced')}` : null}
      </p>
    )
  }
  if (entry.status !== 'open' || !canDecide || !onDecide) return null

  /**
   * Sends one decision and keeps its outcome on screen.
   *
   * @param outcome - Approve or reject.
   */
  async function decide(outcome: ProjectRaidChangeDecisionOutcome) {
    if (!onDecide || pending) return
    setPending(outcome)
    setError(undefined)
    try {
      await onDecide(entry, outcome, { replaceBaseline })
      setConfirming(false)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div className="grid gap-2" data-testid="project-raid-log-decide">
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2" role="group" aria-label={t('projects.raidLog.decision.confirmTitle')}>
          <p className="text-sm font-semibold text-fg-amber-800">
            {t((entry.scheduleChanges?.length ?? 0) > 0 ? 'projects.raidLog.decision.confirmWithDates' : 'projects.raidLog.decision.confirm')}
          </p>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-1c1d1f">
            <input
              checked={replaceBaseline}
              data-testid="project-raid-log-decide-baseline"
              type="checkbox"
              onChange={(event) => setReplaceBaseline(event.target.checked)}
            />
            {t('projects.raidLog.decision.replaceBaseline')}
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
              data-testid="project-raid-log-approve-confirm"
              disabled={pending !== undefined}
              type="button"
              onClick={() => void decide('approved')}
            >
              {t(pending === 'approved' ? 'projects.raidLog.decision.approving' : 'projects.raidLog.decision.approveConfirm')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-4"
              disabled={pending !== undefined}
              type="button"
              onClick={() => setConfirming(false)}
            >
              {t('projects.raidLog.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            className="workbench-button-primary min-h-8 px-3"
            data-testid="project-raid-log-approve"
            disabled={pending !== undefined}
            type="button"
            onClick={() => {
              setError(undefined)
              setConfirming(true)
            }}
          >
            {t('projects.raidLog.decision.approve')}
          </button>
          <button
            className="workbench-button-secondary min-h-8 px-3 disabled:opacity-50"
            data-testid="project-raid-log-reject"
            disabled={pending !== undefined}
            type="button"
            onClick={() => void decide('rejected')}
          >
            {t(pending === 'rejected' ? 'projects.raidLog.decision.rejecting' : 'projects.raidLog.decision.reject')}
          </button>
        </div>
      )}
      {error ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{error}</p> : null}
    </div>
  )
}
