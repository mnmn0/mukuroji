import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestPreview, UpdateFeedDigestState } from '@mukuroji/contracts'
import type { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedTargetKey, updateFeedTargetPath, updateFeedViews } from '../model/updateFeed'
import { normalizeDigestPreferences, sameDigestPreferences } from '../model/digestPreferences'

/** Pure manual-preview presentation with explicit user intent callbacks. */
type DigestPanelProps = {
  /** Explicit reload discards an unsaved draft. */
  draftReset?: number
  /** Stable focus destination when a focused control disappears. */
  restoreFocus?(): void
  /** Current personal metadata, absent after failed reads. */
  state?: UpdateFeedDigestState
  /** Short-lived currently authorized result. */
  preview?: UpdateFeedDigestPreview
  /** Initial metadata request is pending. */
  loading: boolean
  /** A save or preview request is pending. */
  pending: boolean
  /** Whether this member may mutate personal preview state. */
  canEdit: boolean
  /** Safe presentation category, independent of transport errors. */
  failure?: 'denied' | 'conflict' | 'exhausted' | 'refresh' | 'interrupted' | 'error'
  /** Current localized copy. */
  t: ReturnType<typeof createTranslator>
  /** Saves explicit preferences. */
  onSave(preferences: UpdateFeedDigestPreferences, expectedRevision?: number): Promise<boolean>
  /** Generates a current manual preview. */
  onGenerate(): Promise<boolean>
  /** Refreshes metadata after errors without generating content. */
  onReload(): void
  /** Discards preview content when settings are edited. */
  onDismiss(): void
}

const actionClass = 'min-h-11 rounded-md border border-slate-300 px-3 text-app-meta font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50'

/** Renders metadata, settings and ephemeral preview without a delivery action.
 * @param props - Validated state and explicit callbacks.
 * @returns Accessible responsive settings and preview region.
 */
export function DigestPanel(props: DigestPanelProps) {
  const { state, preview, loading, pending, canEdit, failure, t, onReload } = props
  const focused = useRef<HTMLElement | null>(null)
  // Restore only a removed focused descendant, never another live control.
  useLayoutEffect(() => {
    /** Retains detached focus ownership while the browser is inactive. */
    const restore = () => {
      if (!focused.current || focused.current.isConnected || !document.hasFocus()) return
      if (document.activeElement === document.body) props.restoreFocus?.()
      focused.current = null
    }
    restore()
    window.addEventListener('focus', restore)
    document.addEventListener('visibilitychange', restore)
    return () => { window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore) }
  })
  return <section onFocusCapture={(event) => { focused.current = event.target }} onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focused.current = null }} aria-label={t('updates.digest.title')} className="min-w-0 border-y border-slate-200 py-4">
    <p className="mb-4 text-app-meta font-semibold text-teal-800">{t('updates.digest.previewOnly')}</p>
    {loading ? <p role="status">{t('updates.loading')}</p> : null}
    {failure ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 border-l-2 border-amber-500 pl-3"><p>{t(`updates.digest.${failure}`)}</p>{failure !== 'denied' ? <button className={actionClass} disabled={pending} onClick={onReload}>{t('workspace.error.retry')}</button> : null}</div> : null}
    {!canEdit ? <p className="text-app-meta text-slate-600">{t('updates.readOnly')}</p> : null}
    {state && failure !== 'denied' ? <>
      {canEdit ? <DigestForm key={props.draftReset} {...props} state={state} /> : null}
      <h3 className="mt-6 text-sm font-semibold text-slate-800">{t('updates.digest.history')}</h3>
      {state.history.length ? <ul className="mt-2 divide-y divide-slate-200">
        {[...state.history].reverse().map((receipt) => <li key={receipt.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3 text-app-meta text-slate-600">
          <span>{t(receipt.id.startsWith('weekly:') ? 'updates.digest.weekly' : 'updates.digest.daily')} · {receipt.id.split(':')[1]}</span>
          <span>{t(`updates.digest.status.${receipt.status}`)} · {t('updates.digest.attempts').replace('{count}', String(receipt.attempts))}{receipt.status === 'completed' ? ` · ${t('updates.count').replace('{count}', String(receipt.count))}` : ''}</span>
        </li>)}
      </ul> : <p className="mt-2 text-app-meta text-slate-500">{t('updates.digest.noHistory')}</p>}
    </> : null}
    {state && preview && !failure ? <div className="mt-6" aria-label={t('updates.digest.result')}>
      <h3 className="text-sm font-semibold text-slate-800">{t('updates.digest.result')}</h3>
      <p role="status" className="mt-1 text-app-meta text-slate-600">{t(preview.replay ? 'updates.digest.replay' : 'updates.digest.generated')}</p>
      {preview.entries.length === 0 ? <p className="py-5 text-app-body text-slate-500">{t(preview.truncated ? 'updates.digest.boundedEmpty' : 'updates.digest.empty')}</p> : <ul className="mt-2 divide-y divide-slate-200">
        {preview.entries.map((entry) => <li key={updateFeedTargetKey(entry.target)} className="min-w-0 py-4">
          <Link className="inline-flex min-h-11 max-w-full items-center break-words font-semibold text-teal-800 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-teal-700" to={updateFeedTargetPath(entry.target)}>{entry.title}</Link>
          <p className="whitespace-pre-wrap break-words text-app-body text-slate-700">{entry.latestUpdate?.summary}</p>
          <p className="mt-2 text-app-meta text-slate-600">{t(`planning.health.${entry.health}`)} · {t(`planning.updateState.${entry.updateState}`)}</p>
        </li>)}
      </ul>}
      {preview.truncated && preview.entries.length > 0 ? <p role="status" className="mt-3 text-app-meta text-slate-600">{t('updates.digest.truncated').replace('{count}', String(preview.entries.length))}</p> : null}
    </div> : null}
  </section>
}

/** Owns an unsaved draft scoped to its base revision while preserving keyboard focus. */
function DigestForm({ state, pending, canEdit, failure, t, onSave, onGenerate, onDismiss, restoreFocus, onReload: propsReload }: DigestPanelProps & { /** Required committed form seed. */ state: UpdateFeedDigestState }) {
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const generateButton = useRef<HTMLButtonElement>(null)
  const restoreActionFocus = useRef(false)
  const [edit, setEdit] = useState<{ /** Revision at which editing began. */ revision: number; /** Unsaved preferences. */ preferences: UpdateFeedDigestPreferences }>()
  const draft = edit?.preferences ?? state.preferences
  const dirty = !sameDigestPreferences(draft, state.preferences)
  // A satisfied draft no longer owns a base revision or a future value.
  if (edit && !dirty) setEdit(undefined)
  const stale = dirty && edit !== undefined && edit.revision !== state.revision
  const unavailable = pending || !canEdit || failure === 'denied'
  const canSave = !unavailable && !stale && failure !== 'conflict' && dirty && draft.views.length > 0
  /** Discards stale output immediately when the visible settings change. */
  const change = (next: UpdateFeedDigestPreferences) => { setEdit(sameDigestPreferences(next, state.preferences) ? undefined : { revision: dirty && edit ? edit.revision : state.revision, preferences: normalizeDigestPreferences(next) }); onDismiss() }
  // DOM focus must wait for React to commit the re-enabled fieldset.
  useEffect(() => {
    if (pending || !restoreActionFocus.current) return
    restoreActionFocus.current = false
    if (!document.hasFocus() || document.activeElement !== document.body) return
    if (generateButton.current && !generateButton.current.matches(':disabled')) generateButton.current.focus()
    else restoreFocus?.()
  }, [pending, restoreFocus])
  /** Remembers only user-triggered actions for DOM focus restoration. */
  const perform = (action: () => Promise<boolean>) => { restoreActionFocus.current = Boolean(form.current?.contains(document.activeElement)); return action() }
  /** Clears only the acknowledged snapshot, preserving edits made after submission. */
  const save = async () => {
    const submitted = edit
    const success = await onSave(normalizeDigestPreferences(draft), submitted?.revision ?? state.revision)
    if (success) setEdit((current) => current === submitted ? undefined : current)
    return success
  }
  return <form ref={form} onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) restoreActionFocus.current = false }} onSubmit={(event) => { event.preventDefault(); if (canSave) void perform(save) }}>
    {stale && failure !== 'conflict' ? <div role="alert"><p>{t('updates.digest.conflict')}</p><button type="button" className={actionClass} disabled={pending} onClick={propsReload}>{t('workspace.error.retry')}</button></div> : null}
    <fieldset disabled={unavailable} className="min-w-0">
      <legend className="text-sm font-semibold text-slate-800">{t('updates.digest.settings')}</legend>
      <label className="mt-2 flex min-h-11 items-center gap-3 text-app-body"><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ ...draft, enabled: event.target.checked })} className="size-4 accent-teal-700" />{t('updates.digest.enabled')}</label>
      <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(140px,200px)_1fr]">
        <div><label htmlFor={`${id}-frequency`} className="mb-1 block text-app-meta font-semibold text-slate-600">{t('updates.digest.frequency')}</label>
          <select id={`${id}-frequency`} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3" value={draft.frequency} onChange={(event) => { if (event.target.value === 'daily' || event.target.value === 'weekly') change({ ...draft, frequency: event.target.value }) }}>
            <option value="daily">{t('updates.digest.daily')}</option><option value="weekly">{t('updates.digest.weekly')}</option>
          </select><p className="mt-1 text-app-meta text-slate-500">{t('updates.digest.utc')}</p>
        </div>
        <fieldset className="min-w-0"><legend className="text-app-meta font-semibold text-slate-600">{t('updates.digest.views')}</legend><div className="grid grid-cols-1 sm:grid-cols-2">
          {updateFeedViews.map((view) => <label key={view} className="flex min-h-11 items-center gap-3 pr-3 text-app-body"><input type="checkbox" className="size-4 accent-teal-700" checked={draft.views.includes(view)} onChange={(event) => change({ ...draft, views: event.target.checked ? [...draft.views, view] : draft.views.filter((selected) => selected !== view) })} />{t(`updates.view.${view}`)}</label>)}
        </div></fieldset>
      </div>
      {draft.views.length === 0 ? <p role="alert" className="mt-2 text-app-meta text-amber-800">{t('updates.digest.chooseView')}</p> : null}
      <p className="mt-2 text-app-meta text-slate-500">{t('updates.digest.standardOnly')}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" className={actionClass} disabled={!canSave}>{t('updates.digest.save')}</button>
        <button ref={generateButton} type="button" className={`${actionClass} border-teal-700 text-teal-800`} disabled={unavailable || dirty || !state.preferences.enabled || failure === 'exhausted' || failure === 'conflict' || failure === 'interrupted'} onClick={() => { void perform(onGenerate) }}>{t(pending ? 'updates.digest.working' : 'updates.digest.generate')}</button>
      </div>
      {dirty ? <p role="status" className="mt-2 text-app-meta text-slate-600">{t('updates.digest.unsaved')}</p> : null}
    </fieldset>
  </form>
}
