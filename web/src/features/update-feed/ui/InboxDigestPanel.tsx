import { useId, useState } from 'react'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestState } from '@mukuroji/contracts'
import type { createTranslator } from '../../../shared/i18n/i18n'
import { updateFeedViews } from '../model/updateFeed'

/** Pure consent view with no send or preview callback. */
type InboxDigestPanelProps = {
  /** Delivery-only metadata. */ state?: UpdateFeedDigestState
  /** Initial load status. */ loading: boolean
  /** Save status. */ pending: boolean
  /** Current write permission. */ canEdit: boolean
  /** Safe failure category. */ failure?: 'denied' | 'conflict' | 'error'
  /** Localized labels. */ t: ReturnType<typeof createTranslator>
  /** Explicit consent save. */ onSave(preferences: UpdateFeedDigestPreferences): Promise<boolean>
  /** Explicit metadata reload. */ onReload(): void
}

/** Renders separate consent without implying that the scheduler is active.
 * @param props - Current state and explicit consent actions.
 * @returns Accessible native settings.
 */
export function InboxDigestPanel({ state, loading, pending, canEdit, failure, t, onSave, onReload }: InboxDigestPanelProps) {
  const id = useId()
  const [edit, setEdit] = useState<{ /** Draft base revision. */ revision: number; /** Unsaved consent. */ preferences: UpdateFeedDigestPreferences }>()
  const draft = edit?.revision === state?.revision ? edit?.preferences : state?.preferences
  const dirty = JSON.stringify(draft) !== JSON.stringify(state?.preferences)
  const unavailable = pending || !canEdit || Boolean(failure)
  /** Keeps edits bound to the displayed metadata revision. */
  const change = (preferences: UpdateFeedDigestPreferences) => { if (state) setEdit({ revision: state.revision, preferences }) }
  return <section aria-label={t('updates.inbox.title')} className="min-w-0 border-y border-slate-200 py-4">
    <p className="mb-4 text-app-meta font-semibold text-slate-600">{t('updates.inbox.inactive')}</p>
    {loading ? <p role="status">{t('updates.loading')}</p> : null}
    {failure ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3"><p>{t(`updates.inbox.${failure}`)}</p>{failure !== 'denied' ? <button className="min-h-11 rounded-md border px-3" disabled={pending} onClick={onReload}>{t('workspace.error.retry')}</button> : null}</div> : null}
    {!canEdit ? <p>{t('updates.readOnly')}</p> : null}
    {draft && state && failure !== 'denied' ? <form onSubmit={(event) => { event.preventDefault(); if (!unavailable && dirty && draft.views.length) void onSave(draft) }}>
      <fieldset disabled={unavailable} className="min-w-0"><legend className="text-sm font-semibold">{t('updates.inbox.settings')}</legend>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-4 accent-teal-700" checked={draft.enabled} onChange={(event) => change({ ...draft, enabled: event.target.checked })} />{t('updates.inbox.enabled')}</label>
        <label htmlFor={`${id}-cadence`} className="mt-3 block text-app-meta font-semibold">{t('updates.digest.frequency')}</label>
        <select id={`${id}-cadence`} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 sm:max-w-52" value={draft.frequency} onChange={(event) => { if (event.target.value === 'daily' || event.target.value === 'weekly') change({ ...draft, frequency: event.target.value }) }}>
          <option value="daily">{t('updates.digest.daily')}</option><option value="weekly">{t('updates.digest.weekly')}</option>
        </select><p className="mt-1 text-app-meta text-slate-500">{t('updates.digest.utc')}</p>
        <fieldset className="mt-4 min-w-0"><legend className="text-app-meta font-semibold">{t('updates.digest.views')}</legend><div className="grid sm:grid-cols-2">
          {updateFeedViews.map((view) => <label key={view} className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-4 accent-teal-700" checked={draft.views.includes(view)} onChange={(event) => change({ ...draft, views: event.target.checked ? [...draft.views, view] : draft.views.filter((value) => value !== view) })} />{t(`updates.view.${view}`)}</label>)}
        </div></fieldset>
        {!draft.views.length ? <p role="alert">{t('updates.digest.chooseView')}</p> : null}
        <button type="submit" className="mt-4 min-h-11 rounded-md border border-teal-700 px-3 text-sm font-semibold text-teal-800 disabled:opacity-50" disabled={unavailable || !dirty || !draft.views.length}>{t(pending ? 'updates.digest.working' : 'updates.inbox.save')}</button>
        <p role="status" className="mt-2 text-app-meta text-slate-600">{t(dirty ? 'updates.digest.unsaved' : state.preferences.enabled ? 'updates.inbox.optedIn' : 'updates.inbox.disabled')}</p>
      </fieldset>
    </form> : null}
  </section>
}
