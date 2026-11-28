import type { TeamInvestmentAssignments, WorkspaceInvestmentCategorySettings } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { readInvestmentCategoryDisplayName } from '../../../workspace/model/investmentCategories'
import type { SaveTeamInvestmentAssignmentsInput, TeamInvestmentAssignmentsView } from '../api/investmentAssignments'
import {
  listInvestmentCategoryChoices,
  setProjectInvestmentCategory,
  setWorkItemInvestmentCategory,
} from '../model/investmentAssignments'
import { describeTimeTrackingFailure, interpolate, type TimeTrackingTranslator } from './timeTrackingText'

/** A Project or Work Item offered in the panel. */
export type InvestmentAssignmentOption = {
  /** Project or Work Item ID. */
  id: string
  /** Display name. */
  name: string
}

/** Props of the investment category assignment panel. */
export type InvestmentAssignmentsPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Saved assignments; absent while loading. */
  view?: TeamInvestmentAssignmentsView
  /** Workspace categories; absent while loading. */
  settings?: WorkspaceInvestmentCategorySettings
  /** Projects of the Team. */
  projects: readonly InvestmentAssignmentOption[]
  /** Work Items that can take their own category. */
  workItems: readonly InvestmentAssignmentOption[]
  /** Whether the assignments or categories are loading. */
  isLoading?: boolean
  /** Whether a read failed. */
  hasLoadError?: boolean
  /** Saves the whole assignment list; the fields stay locked until it settles. */
  onSave: (input: SaveTeamInvestmentAssignmentsInput) => Promise<unknown>
  /** Reads the assignments and categories again. */
  onRetry: () => void
}

/** Props of one category select. */
type CategorySelectProps = {
  /** Accessible name. */
  label: string
  /** Selected key, or an empty string. */
  value: string
  /** Key the saved assignments hold for the item, which may be retired. */
  savedKey: string | undefined
  /** Workspace categories. */
  settings: WorkspaceInvestmentCategorySettings
  /** Whether an empty choice is offered. */
  allowsEmpty: boolean
  /** Whether the select is locked. */
  disabled: boolean
  /** Translator. */
  t: TimeTrackingTranslator
  /** Selects another key. */
  onChange: (key: string) => void
}

/**
 * Select of the active categories, plus a retired one the item already holds.
 *
 * @param props - Value, choices, and change handler.
 * @returns Category select.
 */
function CategorySelect({ allowsEmpty, disabled, label, onChange, savedKey, settings, t, value }: CategorySelectProps) {
  return (
    <select
      aria-label={label}
      className="workbench-input min-h-9 px-2"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {allowsEmpty ? <option value="">{t('timeTracking.investment.unassigned')}</option> : null}
      {listInvestmentCategoryChoices(settings, savedKey).map((choice) => {
        const name = readInvestmentCategoryDisplayName(choice.key, settings, t)
        return (
          <option key={choice.key} value={choice.key}>
            {choice.retired ? interpolate(t('timeTracking.investment.retired'), { name }) : name}
          </option>
        )
      })}
    </select>
  )
}

/**
 * Editor of a Team's investment categories (ADR 0116): a default per Project, and overrides per
 * Work Item. Shown only to managers of the whole Team.
 *
 * @param props - Assignments, options, and actions.
 * @returns Assignment panel.
 */
export function InvestmentAssignmentsPanel({
  hasLoadError = false,
  isLoading = false,
  onRetry,
  onSave,
  projects,
  settings,
  t,
  view,
  workItems,
}: InvestmentAssignmentsPanelProps) {
  const id = useId()
  const saved = view?.assignments
  const [draft, setDraft] = useState<{ revision: number; value: TeamInvestmentAssignments }>()
  const [newWorkItemId, setNewWorkItemId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  // A newer saved list replaces a draft made from an older one.
  const current = saved && draft?.revision === saved.revision
    ? draft.value
    : saved ? { projects: saved.projects, workItems: saved.workItems } : undefined
  const projectRows = withStoredIds(projects, Object.keys(saved?.projects ?? {}))
  const workItemNames = new Map(withStoredIds(workItems, Object.keys(saved?.workItems ?? {})).map((row) => [row.id, row.name]))
  const overrideIds = current ? Object.keys(current.workItems) : []
  const addableWorkItems = workItems.filter((item) => !current || !Object.hasOwn(current.workItems, item.id))
  const firstActiveKey = settings?.categories.find((category) => category.active)?.key ?? ''

  /**
   * Replaces the draft with an edited copy.
   *
   * @param update - Changes the copy of the current draft.
   */
  const edit = (update: (value: TeamInvestmentAssignments) => TeamInvestmentAssignments) => {
    if (!saved || !current) return
    setMessage(undefined)
    setDraft({ revision: saved.revision, value: update(current) })
  }

  /** Adds the chosen Work Item override. */
  const addOverride = () => {
    const categoryKey = newCategory || firstActiveKey
    if (newWorkItemId === '' || categoryKey === '') return
    edit((value) => setWorkItemInvestmentCategory(value, newWorkItemId, categoryKey))
    setNewWorkItemId('')
  }

  /**
   * Saves the draft.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving || !saved || !current) return
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave({ ...current, expectedRevision: saved.revision })
      setDraft(undefined)
      setMessage({ tone: 'status', text: t('timeTracking.investment.saved') })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4" data-testid="investment-assignments-panel">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.investment.title')}</h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.investment.hint')}</p>
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.investment.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {current && settings && saved && !isLoading && !hasLoadError ? (
        <form className="grid min-w-0 gap-4" onSubmit={(event) => { void submit(event) }}>
          <fieldset className="grid min-w-0 gap-2">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.investment.projects')}</legend>
            {projectRows.length === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.investment.noProjects')}</p>
            ) : (
              <ul className="grid min-w-0 gap-2">
                {projectRows.map((row) => (
                  <li className="flex min-w-0 flex-wrap items-center gap-3" key={row.id}>
                    <span className="min-w-32 break-words text-sm font-medium text-[var(--workbench-text)]">{row.name}</span>
                    <CategorySelect
                      allowsEmpty
                      disabled={isSaving}
                      label={`${row.name} ${t('timeTracking.investment.category')}`}
                      onChange={(key) => edit((value) => setProjectInvestmentCategory(value, row.id, key))}
                      savedKey={saved.projects[row.id]}
                      settings={settings}
                      t={t}
                      value={current.projects[row.id] ?? ''}
                    />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="grid min-w-0 gap-2">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.investment.workItems')}</legend>
            {overrideIds.length === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.investment.noWorkItems')}</p>
            ) : (
              <ul className="grid min-w-0 gap-2">
                {overrideIds.map((workItemId) => {
                  const name = workItemNames.get(workItemId) ?? workItemId
                  return (
                    <li className="flex min-w-0 flex-wrap items-center gap-3" key={workItemId}>
                      <span className="min-w-32 break-words text-sm font-medium text-[var(--workbench-text)]">{name}</span>
                      <CategorySelect
                        allowsEmpty={false}
                        disabled={isSaving}
                        label={`${name} ${t('timeTracking.investment.category')}`}
                        onChange={(key) => edit((value) => setWorkItemInvestmentCategory(value, workItemId, key))}
                        savedKey={saved.workItems[workItemId]}
                        settings={settings}
                        t={t}
                        value={current.workItems[workItemId] ?? ''}
                      />
                      <button
                        aria-label={interpolate(t('timeTracking.investment.removeFor'), { name })}
                        className="workbench-button-secondary min-h-8 px-3"
                        disabled={isSaving}
                        onClick={() => edit((value) => setWorkItemInvestmentCategory(value, workItemId, ''))}
                        type="button"
                      >
                        {t('timeTracking.investment.remove')}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {addableWorkItems.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-end gap-3">
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('timeTracking.investment.addWorkItem')}
                  <select
                    className="workbench-input min-h-9 max-w-80 px-2"
                    disabled={isSaving}
                    onChange={(event) => setNewWorkItemId(event.target.value)}
                    value={newWorkItemId}
                  >
                    <option value="">{t('timeTracking.investment.addWorkItemPlaceholder')}</option>
                    {addableWorkItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('timeTracking.investment.category')}
                  <CategorySelect
                    allowsEmpty={false}
                    disabled={isSaving}
                    label={t('timeTracking.investment.category')}
                    onChange={setNewCategory}
                    savedKey={undefined}
                    settings={settings}
                    t={t}
                    value={newCategory || firstActiveKey}
                  />
                </label>
                <button
                  className="workbench-button-secondary min-h-9 px-3"
                  disabled={isSaving || newWorkItemId === ''}
                  onClick={addOverride}
                  type="button"
                >
                  {t('timeTracking.investment.add')}
                </button>
              </div>
            ) : null}
          </fieldset>

          <div aria-live="polite" role="status">
            {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
          </div>
          {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}
          <div>
            <button className="workbench-button-primary min-h-9 px-3" disabled={isSaving} type="submit">{t('timeTracking.investment.save')}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

/**
 * Lists the offered options, then IDs the saved assignments hold for options no longer offered,
 * labelled by their IDs so they can still be cleared.
 *
 * @param options - Offered options.
 * @param storedIds - IDs the saved assignments hold.
 * @returns Rows in display order.
 */
function withStoredIds(options: readonly InvestmentAssignmentOption[], storedIds: readonly string[]): InvestmentAssignmentOption[] {
  const offered = new Set(options.map((option) => option.id))
  return [...options, ...storedIds.filter((storedId) => !offered.has(storedId)).map((storedId) => ({ id: storedId, name: storedId }))]
}
