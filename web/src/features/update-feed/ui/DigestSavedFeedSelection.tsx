import type { SavedUpdateFeeds, UpdateFeedDigestPreferences } from '@mukuroji/contracts'
import type { createTranslator } from '../../../shared/i18n/i18n'

/** Pure personal source selector; unavailable definitions never render stale labels or IDs.
 * @param props - Current personal collection, draft and explicit change callback.
 * @returns Native checkboxes and an explicit reset for stale selections.
 */
export function DigestSavedFeedSelection({ collection, status = collection ? 'ready' : 'error', preferences, t, onChange }: {
  /** Successfully loaded session-owned definitions. */ collection?: SavedUpdateFeeds
  /** Explicit query readiness; pending reads are not evidence of a deleted selection. */ status?: 'loading' | 'ready' | 'error'
  /** Unsaved bounded preferences. */ preferences: UpdateFeedDigestPreferences
  /** Localized labels. */ t: ReturnType<typeof createTranslator>
  /** Explicit selection mutation, never an automatic revision refresh. */ onChange(preferences: UpdateFeedDigestPreferences): void
}) {
  const selection = preferences.savedFeeds
  const stale = status === 'ready' && Boolean(selection && (collection?.revision !== selection.revision || selection.ids.some((id) => !collection?.feeds.some((feed) => feed.id === id))))
  if (status === 'loading') return <fieldset className="mt-4 min-w-0"><legend className="text-app-meta font-semibold">{t('updates.digest.savedFeeds')}</legend><p role="status" className="text-app-meta text-slate-500">{t('updates.digest.savedLoading')}</p></fieldset>
  return <fieldset className="mt-4 min-w-0"><legend className="text-app-meta font-semibold">{t('updates.digest.savedFeeds')}</legend>
    <p className="text-app-meta text-slate-500">{t('updates.digest.selectionLimit')}</p>
    {stale ? <p role="alert" className="mt-2 text-app-meta text-amber-800">{t('updates.digest.selectionChanged')}</p> : null}
    {status === 'ready' && collection ? <div className="grid sm:grid-cols-2">{collection.feeds.map((feed) => <label key={feed.id} className="flex min-h-11 min-w-0 items-center gap-3 pr-3"><input type="checkbox" className="size-4 shrink-0 accent-teal-700" disabled={stale} checked={!stale && Boolean(selection?.ids.includes(feed.id))} onChange={(event) => {
      const ids = event.target.checked ? [...(selection?.ids ?? []), feed.id] : (selection?.ids ?? []).filter((id) => id !== feed.id)
      onChange({ ...preferences, savedFeeds: ids.length ? { revision: collection.revision, ids } : undefined })
    }} /><span className="break-words">{feed.name}</span></label>)}</div> : <p role="alert" className="text-app-meta text-slate-500">{t('updates.digest.savedUnavailable')}</p>}
    {selection ? <button type="button" className="mt-2 min-h-11 rounded-md border px-3" onClick={() => onChange({ ...preferences, savedFeeds: undefined })}>{t('updates.digest.clearSaved')}</button> : null}
  </fieldset>
}
