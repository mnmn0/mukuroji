import {
  deriveWorkItemProgressPercent,
  deriveWorkItemRemainingEffortMinutes,
  isWorkItemProgressPercent,
  type WorkItemEffortFields,
  type WorkItemProgressMode,
} from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { formatPlannedEffortHours } from '../model/contributorAssignments'
import type { WorkItemEffortProgressChange } from '../model/workItemEffort'

/** Help text describing how each Team progress mode derives the shown percentage. */
const progressModeHelpKeys = {
  'status-category': 'workItems.effort.mode.status-category.help',
  'remaining-effort': 'workItems.effort.mode.remaining-effort.help',
  manual: 'workItems.effort.mode.manual.help',
} as const satisfies Record<WorkItemProgressMode, MessageKey>

export type { WorkItemEffortProgressChange } from '../model/workItemEffort'

/** Props of the Work Item effort and progress editor. */
export type WorkItemEffortProgressEditorProps = {
  /** Display locale. */
  locale: Locale
  /** Effort fields of the Work Item: status category, canonical estimate, remaining, progress. */
  item: WorkItemEffortFields
  /** Team progress mode; the default mode applies when omitted. */
  progressMode?: WorkItemProgressMode
  /** Identity that resets the inputs when the Work Item or its revision changes. */
  editorIdentity: string
  /** Shows the values without inputs. */
  readOnly?: boolean
  /**
   * Keeps the inputs but disables them, such as while another update of the Work Item is pending,
   * so the typed values survive until it settles.
   */
  disabled?: boolean
  /**
   * Shows an estimate input. Set it where the estimate has no other editor, such as a Team Work Item
   * detail whose schedule is read-only.
   */
  canEditEstimate?: boolean
  /** Saves the changed values: remaining effort, manual progress under the `manual` mode, and the estimate when editable. */
  onSave?: (change: WorkItemEffortProgressChange) => Promise<unknown>
}

/**
 * Parses an hours input into whole minutes.
 *
 * @param value - Raw input; blank means "clear".
 * @returns Minutes, null for blank, or undefined when invalid.
 */
function parseHours(value: FormDataEntryValue | null): number | null | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  const hours = Number(text)
  if (!Number.isFinite(hours) || hours < 0) return undefined
  const minutes = Math.round(hours * 60)
  return Number.isSafeInteger(minutes) ? minutes : undefined
}

/**
 * Parses a progress percentage input.
 *
 * @param value - Raw input; blank means "clear".
 * @returns The percentage, null for blank, or undefined when invalid.
 */
function parsePercent(value: FormDataEntryValue | null): number | null | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  const percent = Number(text)
  return isWorkItemProgressPercent(percent) ? percent : undefined
}

/**
 * Shows a Work Item's canonical estimate, remaining effort, and progress, and edits the
 * remaining effort and (under the Team's `manual` mode) the recorded progress.
 *
 * The estimate is the schedule's `plannedEffortMinutes`. Where the schedule has its own editor
 * the estimate is only displayed here; otherwise `canEditEstimate` adds an input for it.
 *
 * @param props - Work Item effort fields, Team progress mode, and the save callback.
 * @returns Effort and progress section.
 */
export function WorkItemEffortProgressEditor({
  canEditEstimate = false,
  disabled = false,
  editorIdentity,
  item,
  locale,
  onSave,
  progressMode = 'status-category',
  readOnly = false,
}: WorkItemEffortProgressEditorProps) {
  const t = createTranslator(locale)
  const id = useId()
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const planned = item.schedule.plannedEffortMinutes
  const remaining = deriveWorkItemRemainingEffortMinutes(item)
  const progress = deriveWorkItemProgressPercent(item, progressMode)
  const isManual = progressMode === 'manual'
  const canEdit = !readOnly && onSave !== undefined
  const inputsDisabled = disabled || pending

  /**
   * Validates and saves the typed values.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onSave || inputsDisabled) return
    const formData = new FormData(event.currentTarget)
    const plannedEffortMinutes = canEditEstimate ? parseHours(formData.get('estimateHours')) : null
    if (plannedEffortMinutes === undefined) {
      setErrorMessage(t('workItems.effort.estimateInvalid'))
      return
    }
    const remainingEffortMinutes = parseHours(formData.get('remainingEffortHours'))
    if (remainingEffortMinutes === undefined) {
      setErrorMessage(t('workItems.effort.remainingInvalid'))
      return
    }
    const progressPercent = isManual ? parsePercent(formData.get('progressPercent')) : null
    if (progressPercent === undefined) {
      setErrorMessage(t('workItems.effort.progressInvalid'))
      return
    }
    // Only changed values are sent; saving nothing would only advance the revision.
    const change: WorkItemEffortProgressChange = {
      ...(canEditEstimate && plannedEffortMinutes !== (planned ?? null) ? { plannedEffortMinutes } : {}),
      ...(remainingEffortMinutes === (item.remainingEffortMinutes ?? null) ? {} : { remainingEffortMinutes }),
      ...(isManual && progressPercent !== (item.progressPercent ?? null) ? { progressPercent } : {}),
    }
    if (Object.keys(change).length === 0) {
      setErrorMessage(undefined)
      return
    }
    setPending(true)
    setErrorMessage(undefined)
    try {
      // The owning editor announces the saved Work Item, so only a failure is reported here.
      await onSave(change)
    } catch {
      setErrorMessage(t('workItems.effort.saveError'))
    } finally {
      setPending(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3" data-testid="work-item-effort-progress">
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('workItems.effort.title')}</h3>
      <dl className="grid min-w-0 grid-cols-3 gap-2 max-[520px]:grid-cols-1">
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workItems.effort.estimate')}</dt>
          <dd className="text-base font-semibold tabular-nums text-[var(--workbench-text)]">
            {planned === undefined ? t('workItems.effort.notSet') : t('workItems.effort.hours').replace('{hours}', formatPlannedEffortHours(planned))}
          </dd>
        </div>
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workItems.effort.remaining')}</dt>
          <dd className="text-base font-semibold tabular-nums text-[var(--workbench-text)]">
            {remaining === undefined ? t('workItems.effort.notSet') : t('workItems.effort.hours').replace('{hours}', formatPlannedEffortHours(remaining))}
          </dd>
        </div>
        <div className="workbench-panel-muted grid gap-1 p-2">
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workItems.effort.progress')}</dt>
          <dd className="grid gap-1 text-base font-semibold tabular-nums text-[var(--workbench-text)]">
            {progress === undefined ? t('workItems.effort.notMeasured') : (
              <>
                <span>{progress}%</span>
                <progress aria-label={t('workItems.effort.progress')} className="h-1.5 w-full" max={100} value={progress} />
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="text-xs font-medium text-[var(--workbench-muted)]">{t(progressModeHelpKeys[progressMode])}</p>
      {canEdit ? (
        <form className="flex min-w-0 flex-wrap items-end gap-2" key={editorIdentity} onSubmit={(event) => { void submit(event) }}>
          {canEditEstimate ? (
            <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workItems.effort.estimateHours')}
              <input
                className="workbench-input h-9 w-32 px-3"
                disabled={inputsDisabled}
                defaultValue={planned === undefined ? '' : formatPlannedEffortHours(planned)}
                inputMode="decimal"
                min="0"
                name="estimateHours"
                step="any"
                type="number"
              />
            </label>
          ) : null}
          <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.effort.remainingHours')}
            <input
              className="workbench-input h-9 w-32 px-3"
              disabled={inputsDisabled}
              defaultValue={item.remainingEffortMinutes === undefined ? '' : formatPlannedEffortHours(item.remainingEffortMinutes)}
              inputMode="decimal"
              min="0"
              name="remainingEffortHours"
              step="any"
              type="number"
            />
          </label>
          {isManual ? (
            <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workItems.effort.progressPercent')}
              <input
                className="workbench-input h-9 w-24 px-3"
                disabled={inputsDisabled}
                defaultValue={item.progressPercent ?? ''}
                inputMode="numeric"
                max="100"
                min="0"
                name="progressPercent"
                step="1"
                type="number"
              />
            </label>
          ) : null}
          <button className="workbench-button-secondary min-h-9 px-3" disabled={inputsDisabled} type="submit">
            {t('workItems.effort.save')}
          </button>
          <span className="w-full text-xs text-[var(--workbench-muted)]">
            {t(canEditEstimate ? 'workItems.effort.clearHintWithEstimate' : 'workItems.effort.clearHint')}
          </span>
        </form>
      ) : null}
      {errorMessage ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{errorMessage}</p> : null}
    </section>
  )
}
