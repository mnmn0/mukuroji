import { useRef, useState } from 'react'
import { UpdateFeedApiError } from '../api/updateFeed'
import { useInboxDigestSettings } from '../mutations/useInboxDigestSettings'
import { createTranslator } from '../../../shared/i18n/i18n'
import { InboxDigestPanel } from './InboxDigestPanel'
import { useSavedUpdateFeeds } from '../queries/useSavedUpdateFeeds'

/** Session-bound settings inputs. */
type Props = {
  /** Current session. */ token?: string
  /** Read permission. */ enabled: boolean
  /** Write permission. */ canEdit: boolean
  /** Language. */ locale: 'ja' | 'en'
  /** Shared recovery. */ guard<T>(request: Promise<T>): Promise<T>
}

/** Loads consent only after opening the native disclosure.
 * @param props - Current session and permissions.
 * @returns A collapsed-by-default settings disclosure.
 */
export function InboxDigestPanelContainer(props: Props) {
  const [open, setOpen] = useState(false)
  const summary = useRef<HTMLElement>(null)
  return <details className="mb-5" onToggle={(event) => setOpen(event.currentTarget.open)}><summary ref={summary} className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-teal-800">{createTranslator(props.locale)('updates.inbox.title')}</summary><Content {...props} open={open} restoreFocus={() => summary.current?.focus()} /></details>
}
/** Maps transport failures into safe presentation categories. */
function Content({ token, enabled, canEdit, locale, guard, restoreFocus, open }: Props & { /** Disclosure state separate from controller lifetime. */ open: boolean; /** Stable focus destination for removed controls. */ restoreFocus(): void }) {
  const controller = useInboxDigestSettings(token, enabled && open, guard)
  const saved = useSavedUpdateFeeds(token, enabled && open, guard)
  const error = controller.error
  if (!open) return null
  const failure = error instanceof UpdateFeedApiError && (error.status === 401 || error.status === 403) ? 'denied' : error instanceof UpdateFeedApiError && error.status === 409 ? 'conflict' : error ? controller.retryableSaveFailure ? 'saveError' : 'error' : undefined
  return <InboxDigestPanel {...controller} savedFeeds={saved.data} savedStatus={saved.isLoading || saved.isValidating ? 'loading' : saved.error ? 'error' : saved.data ? 'ready' : 'loading'} restoreFocus={restoreFocus} failure={failure} canEdit={canEdit} t={createTranslator(locale)} onSave={controller.save} onReload={() => { controller.reload(); void saved.mutate().catch(() => undefined) }} />
}
