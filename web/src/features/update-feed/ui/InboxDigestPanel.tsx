import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestState } from '@mukuroji/contracts'
import type { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedViews } from '../model/updateFeed'
import { validDigestSelection } from '../model/digestSelection'
import { DigestSavedFeedSelection } from './DigestSavedFeedSelection'
import { normalizeDigestPreferences, sameDigestPreferences } from '../model/digestPreferences'

/** Pure consent view with no send or preview callback. */
type InboxDigestPanelProps = {
  /** Current personal definitions, absent after failed reads. */ savedFeeds?: import('@mukuroji/contracts').SavedUpdateFeeds
  /** Current saved definition query readiness. */ savedStatus?: 'loading' | 'ready' | 'error'
  /** Explicit successful reload discards the editing base. */ draftReset?: number
  /** Stable disclosure focus fallback for removed descendants. */ restoreFocus?(): void
  /** Delivery-only metadata. */ state?: UpdateFeedDigestState
  /** Initial load status. */ loading: boolean
  /** Save status. */ pending: boolean
  /** Current write permission. */ canEdit: boolean
  /** Safe failure category. */ failure?: 'denied' | 'conflict' | 'error' | 'saveError'
  /** Localized labels. */ t: ReturnType<typeof createTranslator>
  /** Explicit consent save with its original editing revision. */ onSave(preferences: UpdateFeedDigestPreferences, expectedRevision?: number): Promise<boolean>
  /** Explicit metadata reload. */ onReload(): void
  /** Retires obsolete retry presentation when local edits return to observed settings. */ onRevert?(): void
}

/** Renders separate consent without implying that the scheduler is active.
 * @param props - Current state and explicit consent actions.
 * @returns Accessible native settings.
 */
export function InboxDigestPanel({ state, savedFeeds, savedStatus, loading, pending, canEdit, failure, t, onSave, onReload, onRevert, draftReset, restoreFocus }: InboxDigestPanelProps) {
  const id = useId()
  const [edit, setEdit] = useState<{ /** Draft base revision. */ revision: number; /** Explicit reload generation. */ reset?: number; /** Unsaved consent. */ preferences: UpdateFeedDigestPreferences }>()
  const currentEdit = edit?.reset === draftReset ? edit : undefined
  const draft = currentEdit?.preferences ?? state?.preferences
  const savedSelection = state?.preferences.savedFeeds
  const readableSavedSelection = savedSelection && (!savedStatus || savedStatus === 'ready') && savedFeeds?.revision === savedSelection.revision && savedSelection.ids.every((id) => savedFeeds.feeds.some((feed) => feed.id === id))
  const valid = draft !== undefined && validDigestSelection(draft, savedStatus && savedStatus !== 'ready' ? undefined : savedFeeds)
  const dirty = Boolean(draft && (!state || !sameDigestPreferences(draft, state.preferences)))
  if (edit && (!currentEdit || failure === 'denied' || (state && !dirty))) setEdit(undefined)
  const stale = dirty && currentEdit !== undefined && currentEdit.revision !== state?.revision
  const effectiveFailure = failure === 'denied' ? failure : stale ? 'conflict' : failure
  const unavailable = pending || !canEdit || Boolean(effectiveFailure && effectiveFailure !== 'saveError')
  const focused = useRef<HTMLElement | null>(null)
  const pendingFocus = useRef(false)
  // Only removed or disabled owned controls require a stable focus fallback.
  useLayoutEffect(() => {
    /** Restores owned focus after a removed control outlives window activity. */
    const restore = () => {
      const owner = focused.current
      if (pending && owner) pendingFocus.current = true
      const lost = owner && (!owner.isConnected || (!pending && (owner.matches(':disabled') || (pendingFocus.current && document.activeElement === document.body))))
      if (!lost || !document.hasFocus()) return
      if (document.activeElement === document.body || document.activeElement === owner) {
        if (owner.isConnected && !owner.matches(':disabled')) { pendingFocus.current = false; owner.focus(); return }
        else restoreFocus?.()
      }
      pendingFocus.current = false
      focused.current = null
    }
    restore()
    window.addEventListener('focus', restore)
    document.addEventListener('visibilitychange', restore)
    return () => { window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore) }
  })
  /** Keeps edits bound to the displayed metadata revision. */
  const change = (preferences: UpdateFeedDigestPreferences) => {
    if (!state) return
    const reverted = sameDigestPreferences(preferences, state.preferences)
    setEdit(reverted ? undefined : { revision: dirty && currentEdit ? currentEdit.revision : state.revision, reset: draftReset, preferences: normalizeDigestPreferences(preferences) })
    if (reverted) onRevert?.()
  }
  /** Acknowledges only the submitted draft; later edits and failed saves remain owned. */
  const save = async () => {
    if (!draft || !state) return
    const submitted = currentEdit
    if (await onSave(normalizeDigestPreferences(draft), submitted?.revision ?? state.revision)) setEdit((current) => current === submitted ? undefined : current)
  }
  return <section onFocusCapture={(event) => { focused.current = event.target }} onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focused.current = null }} aria-label={t('updates.inbox.title')} className="min-w-0 border-y border-slate-200 py-4">
    <p className="mb-4 text-app-meta font-semibold text-slate-600">{t('updates.inbox.inactive')}</p>
    {loading ? <p role="status">{t('updates.loading')}</p> : null}
    {effectiveFailure ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3"><p>{t(`updates.inbox.${effectiveFailure}`)}</p>{effectiveFailure !== 'denied' && effectiveFailure !== 'saveError' ? <button className="min-h-11 rounded-md border px-3" disabled={pending} onClick={onReload}>{t('workspace.error.retry')}</button> : null}</div> : null}
    {!canEdit ? <p>{t('updates.readOnly')}</p> : null}
    {!canEdit && state && failure !== 'denied' ? <div className="mt-2 text-app-meta text-slate-600">
      <p role="status">{t(state.preferences.enabled ? 'updates.inbox.optedIn' : 'updates.inbox.disabled')}</p>
      <dl className="mt-3 space-y-2"><div><dt className="font-semibold">{t('updates.digest.frequency')}</dt><dd>{t(state.preferences.frequency === 'daily' ? 'updates.digest.daily' : 'updates.digest.weekly')}</dd></div>{state.preferences.views.length ? <div><dt className="font-semibold">{t('updates.digest.views')}</dt><dd>{state.preferences.views.map((view) => t(`updates.view.${view}`)).join(', ')}</dd></div> : null}</dl>
      {savedSelection ? <dl className="mt-2"><dt className="font-semibold">{t('updates.digest.savedFeeds')}</dt><dd className="break-words">{readableSavedSelection ? savedFeeds?.feeds.filter((feed) => savedSelection.ids.includes(feed.id)).map((feed) => feed.name).join(', ') : t(savedStatus === 'loading' ? 'updates.digest.savedLoading' : 'updates.digest.savedUnavailable')}</dd></dl> : null}
    </div> : null}
    {canEdit && draft && state && failure !== 'denied' ? <form onSubmit={(event) => { event.preventDefault(); if (!unavailable && dirty && valid) void save() }}>
      <fieldset disabled={unavailable} className="min-w-0"><legend className="text-sm font-semibold">{t('updates.inbox.settings')}</legend>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-4 accent-teal-700" checked={draft.enabled} onChange={(event) => change({ ...draft, enabled: event.target.checked })} />{t('updates.inbox.enabled')}</label>
        <label htmlFor={`${id}-cadence`} className="mt-3 block text-app-meta font-semibold">{t('updates.digest.frequency')}</label>
        <select id={`${id}-cadence`} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 sm:max-w-52" value={draft.frequency} onChange={(event) => { if (event.target.value === 'daily' || event.target.value === 'weekly') change({ ...draft, frequency: event.target.value }) }}>
          <option value="daily">{t('updates.digest.daily')}</option><option value="weekly">{t('updates.digest.weekly')}</option>
        </select><p className="mt-1 text-app-meta text-slate-500">{t('updates.digest.utc')}</p>
        <fieldset className="mt-4 min-w-0"><legend className="text-app-meta font-semibold">{t('updates.digest.views')}</legend><div className="grid sm:grid-cols-2">
          {updateFeedViews.map((view) => <label key={view} className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-4 accent-teal-700" checked={draft.views.includes(view)} onChange={(event) => change({ ...draft, views: event.target.checked ? [...draft.views, view] : draft.views.filter((value) => value !== view) })} />{t(`updates.view.${view}`)}</label>)}
        </div></fieldset>
        <DigestSavedFeedSelection collection={savedFeeds} status={savedStatus} preferences={draft} t={t} onChange={change} />
        {!valid && !(savedStatus === 'loading' && draft.savedFeeds) ? <p role="alert">{t('updates.digest.chooseView')}</p> : null}
        <button type="submit" className="mt-4 min-h-11 rounded-md border border-teal-700 px-3 text-sm font-semibold text-teal-800 disabled:opacity-50" disabled={unavailable || !dirty || !valid}>{t(pending ? 'updates.digest.working' : 'updates.inbox.save')}</button>
        <p role="status" className="mt-2 text-app-meta text-slate-600">{t(dirty ? 'updates.inbox.unsaved' : state.preferences.enabled ? 'updates.inbox.optedIn' : 'updates.inbox.disabled')}</p>
      </fieldset>
    </form> : null}
  </section>
}
