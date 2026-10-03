import { useState } from 'react'
import { UpdateFeedApiError } from '../api/updateFeed'
import { useInboxDigestSettings } from '../mutations/useInboxDigestSettings'
import { createTranslator } from '../../../shared/i18n/i18n'
import { InboxDigestPanel } from './InboxDigestPanel'

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
  return <details className="mb-5" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-teal-800">{createTranslator(props.locale)('updates.inbox.title')}</summary>{open ? <Content {...props} /> : null}</details>
}
/** Maps transport failures into safe presentation categories. */
function Content({ token, enabled, canEdit, locale, guard }: Props) {
  const controller = useInboxDigestSettings(token, enabled, guard)
  const error = controller.error
  const failure = error instanceof UpdateFeedApiError && (error.status === 401 || error.status === 403) ? 'denied' : error instanceof UpdateFeedApiError && error.status === 409 ? 'conflict' : error ? 'error' : undefined
  return <InboxDigestPanel {...controller} failure={failure} canEdit={canEdit} t={createTranslator(locale)} onSave={controller.save} onReload={controller.reload} />
}
