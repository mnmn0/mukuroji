import { useEffect, useId, useRef, useState } from 'react'
import type { PlanningHealth, PlanningUpdateState, ReplaceSavedUpdateFeedsInput, SavedUpdateFeed, SavedUpdateFeeds, UpdateFeedFilterOptions, UpdateFeedFilters } from '@mukuroji/contracts'
import type { createTranslator } from '../../../shared/i18n/i18n'
import { isUpdateFeedView, updateFeedViews } from '../model/updateFeed'
import { UpdateFeedApiError } from '../api/updateFeed'

/** Captured collection revision remains stable while a user edits. */
type Editor = {
  /** Editable definition. */
  feed: SavedUpdateFeed
  /** Collection captured on opening, used for CAS. */
  original: SavedUpdateFeeds
  /** Explicit deletion confirmation replaces the form. */
  deleting: boolean
}
/** Pure personal-feed manager with externally owned persistence and authorization. */
type Props = {
  /** Current member-owned definitions; absent on load/error. */
  collection?: SavedUpdateFeeds
  /** Selected personal feed, or empty for standard views. */
  selectedId: string
  /** Current authorized selector labels. */
  options?: UpdateFeedFilterOptions
  /** Whether selector labels failed to load. */
  optionsFailed: boolean
  /** Whether saved definitions failed to load. */
  failed: boolean
  /** Whether current permissions deny personal-feed loading. */
  denied: boolean
  /** Whether this active caller may change personal state. */
  canEdit: boolean
  /** Whether a serialized persistence operation is pending. */
  pending: boolean
  /** Last mutation error, preserving the draft. */
  error?: unknown
  /** Shared localized message translator. */
  t: ReturnType<typeof createTranslator>
  /** Selects a saved definition or clears it. */
  onSelect: (id: string) => void
  /** Enables editor-only current-label loading. */
  onEditingChange: (open: boolean) => void
  /** Clears stale mutation feedback when opening another editing session. */
  onClearError: () => void
  /** Reloads definitions and labels after a read failure. */
  onReload: () => void
  /** Persists an explicit captured revision; false keeps the editor open. */
  onSave: (input: ReplaceSavedUpdateFeedsInput) => Promise<boolean>
}
const healthValues: PlanningHealth[] = ['unknown', 'on-track', 'at-risk', 'off-track']
const stateValues: PlanningUpdateState[] = ['not-configured', 'missing', 'current', 'overdue', 'stale']
const control = 'min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-app-meta'
const button = 'min-h-10 rounded-md border border-slate-300 px-3 text-app-meta font-semibold disabled:opacity-50'

/** Renders saved selection, bounded filter editing and explicit delete confirmation.
 * @param props - Authorized definitions, metadata and user-intent callbacks.
 * @returns Responsive personal filter controls.
 */
export function SavedUpdateFeedsPanel({ collection, selectedId, options, optionsFailed, failed, denied, canEdit, pending, error, t, onSelect, onEditingChange, onClearError, onReload, onSave }: Props) {
  const id = useId()
  const [editor, setEditor] = useState<Editor>()
  const selector = useRef<HTMLSelectElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!editor && restoreFocus.current) { restoreFocus.current = false; selector.current?.focus() }
  }, [editor])
  const selected = collection?.feeds.find((feed) => feed.id === selectedId)
  /** Captures a revision so background refreshes never silently rebase an edit. */
  const open = (feed?: SavedUpdateFeed, deleting = false) => {
    if (!collection) return
    onClearError()
    setEditor({ original: structuredClone(collection), deleting, feed: structuredClone(feed ?? { id: crypto.randomUUID(), name: '', view: 'recent', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }) })
    onEditingChange(true)
  }
  /** Closes this editing session only through an explicit user action or successful commit. */
  const close = () => { restoreFocus.current = true; setEditor(undefined); onEditingChange(false) }
  /** Applies one dimension without modifying the captured collection or revision. */
  const changeFilters = (filters: Partial<UpdateFeedFilters>) => { if (editor) setEditor({ ...editor, feed: { ...editor.feed, filters: { ...editor.feed.filters, ...filters } } }) }
  /** Commits the desired collection; failed CAS never closes or clears the draft. */
  const save = async () => {
    if (!editor) return
    const feeds = editor.deleting ? editor.original.feeds.filter((feed) => feed.id !== editor.feed.id) : [...editor.original.feeds]
    if (!editor.deleting) {
      const index = editor.original.feeds.findIndex((feed) => feed.id === editor.feed.id)
      if (index === -1) feeds.push(editor.feed)
      else feeds[index] = editor.feed
    }
    if (await onSave({ expectedRevision: editor.original.revision, feeds })) { onSelect(editor.deleting ? '' : editor.feed.id); close() }
  }
  const conflict = error instanceof UpdateFeedApiError && error.status === 409
  const oversized = editor && Object.values(editor.feed.filters).some((values) => values.length > 20)
  return <section className="mx-auto mb-5 w-full max-w-5xl border-b border-slate-200 pb-4" aria-label={t('updates.saved.title')}>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-48 flex-1 text-app-meta font-semibold" htmlFor={`${id}-saved`}>{t('updates.saved.title')}<select ref={selector} id={`${id}-saved`} className={`${control} mt-1`} value={selectedId} disabled={!collection || pending || Boolean(editor)} onChange={(event) => onSelect(event.target.value)}><option value="">{t('updates.saved.standard')}</option>{collection?.feeds.map((feed) => <option key={feed.id} value={feed.id}>{feed.name}</option>)}</select></label>
      {canEdit && !editor ? <><button className={button} disabled={!collection || collection.feeds.length >= 20} onClick={() => open()}>{t('updates.saved.new')}</button>{selected ? <><button className={button} onClick={() => open(selected)}>{t('updates.saved.edit')}</button><button className={button} onClick={() => open(selected, true)}>{t('updates.saved.delete')}</button></> : null}</> : null}
    </div>
    {failed ? <div role="alert" className="mt-3 text-app-meta">{t(denied ? 'updates.denied' : 'updates.saved.loadError')} {!denied ? <button className="underline" onClick={onReload}>{t('workspace.error.retry')}</button> : null}</div> : null}
    {!failed && collection && selectedId && !selected ? <p role="alert" className="mt-3 text-app-meta">{t('updates.saved.unavailable')}</p> : null}
    {editor && canEdit ? <form className="mt-4 space-y-4 rounded-md border border-slate-200 p-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
      {editor.deleting ? <p>{t('updates.saved.confirmDelete').replace('{name}', () => editor.feed.name)}</p> : <>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-app-meta font-semibold">{t('updates.saved.name')}<input autoFocus required maxLength={80} value={editor.feed.name} className={`${control} mt-1`} onChange={(event) => setEditor({ ...editor, feed: { ...editor.feed, name: event.target.value } })} /></label>
          <label className="text-app-meta font-semibold">{t('updates.saved.base')}<select className={`${control} mt-1`} value={editor.feed.view} onChange={(event) => { if (isUpdateFeedView(event.target.value)) setEditor({ ...editor, feed: { ...editor.feed, view: event.target.value } }) }}>{updateFeedViews.map((view) => <option key={view} value={view}>{t(`updates.view.${view}`)}</option>)}</select></label>
        </div>
        <p className="text-app-meta text-slate-600">{t('updates.saved.rules')}</p>
        {options ? <div className="grid gap-4 sm:grid-cols-2">
          <Dimension t={t} label={t('updates.saved.teams')} values={editor.feed.filters.teamIds} options={options.teams.map((item) => ({ value: item.id, label: item.name }))} onChange={(teamIds) => changeFilters({ teamIds })} />
          <Dimension t={t} label={t('updates.saved.projects')} values={editor.feed.filters.projects.map((item) => JSON.stringify([item.teamId, item.projectId]))} options={options.projects.map((item) => ({ value: JSON.stringify([item.teamId, item.projectId]), label: `${item.name} (${options.teams.find((team) => team.id === item.teamId)?.name ?? item.teamId})` }))} onChange={(values) => changeFilters({ projects: options.projects.filter((item) => values.includes(JSON.stringify([item.teamId, item.projectId]))).map(({ teamId, projectId }) => ({ teamId, projectId })) })} />
          <Dimension t={t} label={t('updates.saved.portfolios')} values={editor.feed.filters.portfolioIds} options={options.portfolios.map((item) => ({ value: item.id, label: item.name }))} onChange={(portfolioIds) => changeFilters({ portfolioIds })} />
          <Dimension t={t} label={t('updates.saved.initiatives')} values={editor.feed.filters.initiativeIds} options={options.initiatives.map((item) => ({ value: item.id, label: item.name }))} onChange={(initiativeIds) => changeFilters({ initiativeIds })} />
          <Dimension t={t} label={t('updates.saved.health')} values={editor.feed.filters.health} options={healthValues.map((value) => ({ value, label: t(`planning.health.${value}`) }))} onChange={(values) => changeFilters({ health: healthValues.filter((value) => values.includes(value)) })} />
          <Dimension t={t} label={t('updates.saved.status')} values={editor.feed.filters.updateStates} options={stateValues.map((value) => ({ value, label: t(`planning.updateState.${value}`) }))} onChange={(values) => changeFilters({ updateStates: stateValues.filter((value) => values.includes(value)) })} />
        </div> : <p role={optionsFailed ? 'alert' : 'status'}>{t(optionsFailed ? 'updates.saved.optionsError' : 'updates.loading')}</p>}
        <p className="text-app-meta text-slate-500">{t('updates.saved.visibility')}</p>
      </>}
      {oversized ? <p role="alert">{t('updates.saved.limit')}</p> : null}
      {error ? <p role="alert" className="text-app-meta text-amber-800">{t(conflict ? 'updates.saved.conflict' : 'updates.saveError')}</p> : null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={`${button} bg-teal-800 text-white`} disabled={pending || conflict || Boolean(oversized) || (!editor.deleting && (!options || optionsFailed || !editor.feed.name.trim()))}>{t(editor.deleting ? 'updates.saved.delete' : 'updates.saved.save')}</button><button type="button" className={button} disabled={pending} onClick={close}>{t('updates.saved.cancel')}</button></div>
    </form> : null}
  </section>
}

/** Accessible native multi-selection for one independent filter dimension. */
function Dimension({ t, label, values, options, onChange }: {
  /** Localized description for retained unavailable conditions. */ t: ReturnType<typeof createTranslator>
  /** Localized dimension label. */ label: string
  /** Selected logical values. */ values: string[]
  /** Current authorized choices. */ options: { /** Logical value. */ value: string; /** Current label. */ label: string }[]
  /** Explicit user selection. */ onChange: (values: string[]) => void
}) {
  const descriptionId = useId()
  const available = new Set(options.map((option) => option.value))
  const unavailableCount = values.filter((value) => !available.has(value)).length
  return <div><label className="text-app-meta font-semibold">{label}<select multiple size={3} aria-describedby={unavailableCount ? descriptionId : undefined} className={`${control} mt-1`} value={values} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{unavailableCount ? <p id={descriptionId} className="mt-1 text-app-meta text-slate-600">{t('updates.saved.unavailableConditions').replace('{count}', String(unavailableCount))}</p> : null}</div>
}
