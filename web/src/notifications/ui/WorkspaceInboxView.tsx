import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { InboxNotification } from '../api/inbox'
import type { NotificationInboxController } from '../mutations/useNotifications'
import { NotificationInbox } from './NotificationInbox'

/** Props for the notification-only Workspace Inbox view. */
export type WorkspaceInboxViewProps = {
  /** Locale used by the notification timeline. */
  locale: Locale
  /** Durable notification data and actions. */
  notificationInbox: NotificationInboxController
  /** Opens the destination associated with a notification. */
  onOpenNotification?: (notification: InboxNotification) => void
  /** Immutable event selected by a Focus source link when present. */
  selectedEventId?: string
  /** Resolves localized Workspace labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the durable event Inbox without duplicating the continuing Focus queue.
 *
 * @param props - Notification data, navigation, and localized labels.
 * @returns The notification timeline and a cross-link to continuing attention.
 */
export function WorkspaceInboxView({
  locale,
  notificationInbox,
  onOpenNotification,
  selectedEventId,
  t,
}: WorkspaceInboxViewProps) {
  return (
    <div className="grid gap-5" data-testid="inbox-workbench">
      <section className="workbench-toolbar flex min-w-0 flex-wrap items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.inbox.focusTitle')}
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.inbox.focusDescription')}
          </p>
        </div>
        <a
          className="workbench-button-secondary inline-flex min-h-[44px] shrink-0 items-center px-4"
          data-testid="inbox-open-focus"
          href="/focus"
        >
          {t('workspace.inbox.openFocus')}
        </a>
      </section>

      <NotificationInbox
        controller={notificationInbox}
        locale={locale}
        onOpenNotification={onOpenNotification}
        selectedEventId={selectedEventId}
      />
    </div>
  )
}
