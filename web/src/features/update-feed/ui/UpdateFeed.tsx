import type { UpdateFeedEntry, UpdateFeedResponse, UpdateFeedView } from '@mukuroji/contracts'
import { Link } from 'react-router'
import { useId, type ReactNode } from 'react'
import type { createTranslator, Locale } from '../../../shared/i18n/i18n'
import { updateFeedTargetKey, updateFeedTargetPath, updateFeedViews, isUpdateFeedView } from '../model/updateFeed'

/** Pure feed presentation and user intent callbacks. */
type UpdateFeedProps = {
  /** Optional personal filter controls below the page heading. */
  controls?: ReactNode
  /** Current authorized response, absent while loading or on failure. */
  response?: UpdateFeedResponse
  /** Selected server view. */
  view: UpdateFeedView
  /** Locale for dates. */
  locale: Locale
  /** Shared message translator. */
  t: ReturnType<typeof createTranslator>
  /** Whether initial loading is in progress. */
  loading: boolean
  /** Whether the latest refresh failed. */
  failed: boolean
  /** Whether current permissions deny the feed, rather than a transient failure. */
  denied: boolean
  /** Whether this non-guest caller may save personal state. */
  canMarkRead: boolean
  /** Whether a personal-state mutation failed. */
  mutationFailed: boolean
  /** Whether a mutation is in progress. */
  pending: boolean
  /** Selects a standard view. */
  onViewChange(view: UpdateFeedView): void
  /** Reloads current permissions and content. */
  onRetry(): void
  /** Toggles the shown immutable report's personal state. */
  onToggle(entry: UpdateFeedEntry): void
}

/** Renders compact report rows with separate health, submission, and personal state.
 * @param props - Authorized response, localized state, and user intent callbacks.
 * @returns Responsive report list with loading, empty, and error states.
 */
export function UpdateFeed({ controls, response, view, locale, t, loading, failed, denied, canMarkRead, mutationFailed, pending, onViewChange, onRetry, onToggle }: UpdateFeedProps) {
  const viewId = useId()
  return <section className="mx-auto w-full max-w-5xl" aria-label={t('updates.title')}>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4">
      <div className="grid gap-1 text-app-meta font-semibold text-slate-600">
        <label htmlFor={viewId}>{t('updates.view')}</label>
        <select id={viewId} className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-app-body text-slate-900" value={view} onChange={(event) => { if (isUpdateFeedView(event.target.value)) onViewChange(event.target.value) }}>
          {updateFeedViews.map((option) => <option key={option} value={option}>{t(`updates.view.${option}`)}</option>)}
        </select>
      </div>
      {response ? <p className="text-app-meta text-slate-500">{t('updates.count').replace('{count}', String(response.total))}</p> : null}
    </div>
    {controls}
    {view === 'for-me' ? <p className="mb-4 text-app-meta text-slate-600">{t('updates.ranking')}</p> : null}
    {loading ? <p role="status" className="py-12 text-center text-slate-500">{t('updates.loading')}</p> : null}
    {failed ? denied ? <p role="alert" className="border-l-2 border-slate-400 p-4">{t('updates.denied')}</p> : <div role="alert" className="flex flex-wrap items-center gap-3 border-l-2 border-amber-500 p-4"><p>{t('updates.error')}</p><button className="min-h-10 px-3 font-semibold text-teal-800 underline" onClick={onRetry}>{t('workspace.error.retry')}</button></div> : null}
    {response && !canMarkRead ? <p className="mb-4 text-app-meta text-slate-600">{t('updates.readOnly')}</p> : null}
    {mutationFailed ? <p role="alert" className="mb-4 border-l-2 border-amber-500 p-3 text-app-meta">{t('updates.saveError')}</p> : null}
    {response && response.entries.length === 0 ? <div className="py-16 text-center"><h2 className="text-lg font-semibold text-slate-800">{t('updates.empty')}</h2><p className="mt-2 text-app-body text-slate-500">{t('updates.emptyHint')}</p></div> : null}
    {response && !failed ? <ul className="divide-y divide-slate-200">
      {response.entries.map((entry) => <li key={updateFeedTargetKey(entry.target)} className="grid gap-3 py-5 sm:grid-cols-[1fr_auto]" data-testid="update-feed-row">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link className="break-words text-base font-semibold text-slate-900 underline-offset-4 hover:underline" to={updateFeedTargetPath(entry.target)}>{entry.title}</Link>
            <span className="text-app-meta text-slate-500">{t(`updates.target.${entry.target.type}`)}</span>
            {entry.readState ? <span className={`text-app-meta font-semibold ${entry.readState.read ? 'text-slate-500' : 'text-teal-800'}`}>{t(entry.readState.read ? 'updates.read' : 'updates.unread')}</span> : null}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-app-meta">
            <div className="flex gap-1"><dt className="text-slate-500">{t('updates.health')}</dt><dd className={entry.health === 'off-track' || entry.health === 'at-risk' ? 'font-semibold text-amber-800' : 'font-semibold text-slate-700'}>{t(`planning.health.${entry.health}`)}</dd></div>
            <div className="flex gap-1"><dt className="text-slate-500">{t('updates.submission')}</dt><dd className="font-semibold text-slate-700">{t(`planning.updateState.${entry.updateState}`)}</dd></div>
          </dl>
          <p className="mt-3 whitespace-pre-wrap break-words text-app-body leading-relaxed text-slate-700">{entry.latestUpdate?.summary ?? t('updates.noReport')}</p>
          {entry.latestUpdate ? <p className="mt-2 break-words text-app-meta text-slate-500">{entry.latestUpdate.authorMemberKey} · <time dateTime={entry.latestUpdate.createdAt}>{new Date(entry.latestUpdate.createdAt).toLocaleString(locale)}</time></p> : null}
          {entry.reasons.length ? <p className="mt-2 text-app-meta text-slate-600">{entry.reasons.map((reason) => t(`updates.reason.${reason}`)).join(' · ')}</p> : null}
          {entry.attention?.reasons.length ? <p className="mt-1 text-app-meta text-slate-600">{entry.attention.reasons.map((reason) => t(`updates.attention.${reason}`)).join(' · ')}</p> : null}
        </div>
        <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-end">
          {entry.readState && canMarkRead ? <button aria-label={t(entry.readState.read ? 'updates.markUnreadTarget' : 'updates.markReadTarget').replace('{title}', () => entry.title)} className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-app-meta font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={pending} onClick={() => onToggle(entry)}>{t(entry.readState.read ? 'updates.markUnread' : 'updates.markRead')}</button> : null}
          <Link aria-label={t('updates.historyTarget').replace('{title}', () => entry.title)} className="inline-flex min-h-10 items-center px-3 text-app-meta font-semibold text-teal-800 underline-offset-4 hover:underline" to={updateFeedTargetPath(entry.target)}>{t('updates.history')}</Link>
        </div>
      </li>)}
    </ul> : null}
    {response?.truncated ? <p role="status" className="mt-4 border-t border-slate-200 pt-4 text-app-meta text-slate-600">{t('updates.truncated').replace('{count}', String(response.entries.length))}</p> : null}
  </section>
}
