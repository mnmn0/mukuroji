import { useLayoutEffect, useRef, useState } from 'react'
import { UpdateFeedApiError } from '../api/updateFeed'
import { useDigestPreview } from '../mutations/useDigestPreview'
import { createTranslator } from '../../../shared/i18n/i18n'
import { DigestPanel } from './DigestPanel'

/** Session and permission inputs supplied by the owning Workspace page. */
type DigestPanelContainerProps = {
  /** Content scope invalidates ephemeral results without replacing the editor. */
  contentKey?: string
  /** Current authenticated session. */
  token?: string
  /** Whether Workspace metadata may load. */
  enabled: boolean
  /** Whether this member may mutate personal preferences. */
  canEdit: boolean
  /** Current locale. */
  locale: 'ja' | 'en'
  /** Shared enterprise recovery boundary. */
  guard<T>(request: Promise<T>): Promise<T>
}

/** Lazily opens manual digest controls without background generation.
 * @param props - Authenticated session and permissions.
 * @returns A native keyboard-accessible disclosure.
 */
export function DigestPanelContainer(props: DigestPanelContainerProps) {
  const [open, setOpen] = useState(false)
  const summary = useRef<HTMLElement>(null)
  const t = createTranslator(props.locale)
  return <details className="mb-5" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary} className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-teal-800 focus-visible:outline-2 focus-visible:outline-teal-700">{t('updates.digest.title')}<span className="mt-1 block text-app-meta font-normal">{t('updates.digest.previewOnly')}</span></summary>
    {open ? <DigestContent {...props} restoreFocus={() => summary.current?.focus()} /> : null}
  </details>
}

/** Connects safe presentation categories to the session-owned controller. */
function DigestContent({ token, enabled, canEdit, locale, guard, restoreFocus, contentKey }: DigestPanelContainerProps & { /** Stable fallback for removed controls. */ restoreFocus(): void }) {
  const controller = useDigestPreview(token, enabled, locale, guard)
  const { dismiss } = controller
  // Cancel owned browser requests/timers and clear ephemeral content before paint;
  // unrelated Feed scope changes must preserve the personal settings form and focus.
  useLayoutEffect(() => { dismiss() }, [contentKey, dismiss])
  const error = controller.error
  const failure = error instanceof UpdateFeedApiError && (error.status === 401 || error.status === 403) ? 'denied' : controller.refreshFailed ? 'refresh' : error instanceof UpdateFeedApiError && error.code === 'UpdateFeedDigestAttemptsExhausted' ? 'exhausted' : error instanceof UpdateFeedApiError && error.status === 409 ? 'conflict' : error ? 'error' : undefined
  return <DigestPanel {...controller} restoreFocus={restoreFocus} failure={failure} canEdit={canEdit} t={createTranslator(locale)} onSave={controller.save} onGenerate={controller.generate} onReload={controller.reload} onDismiss={controller.dismiss} />
}
