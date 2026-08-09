import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import type { NotificationFilter } from '../../notifications/api'
import { useNotificationInbox } from '../../notifications/mutations/useNotifications'
import { WorkspaceInboxView } from '../../notifications/ui/WorkspaceInboxView'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const focusInboxMaximumAutomaticPageLoads = 7

/**
 * Renders the URL-specific Inbox route with the durable notification timeline.
 *
 * @returns Inbox content rendered inside the shared Workspace shell.
 */
export function InboxPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const selectedEventId = searchParams.get('eventId')?.trim() || undefined
  const selectedFilter = readFocusInboxFilter(searchParams.get('filter'))
  const notificationInbox = useNotificationInbox(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    selectedFilter,
  )
  const automaticLoadState = useRef({ selection: '', loads: 0 })

  useEffect(() => {
    const selection = `${selectedFilter}\u0000${selectedEventId ?? ''}`
    if (automaticLoadState.current.selection !== selection) {
      automaticLoadState.current = { selection, loads: 0 }
    }
    if (
      selectedEventId === undefined ||
      notificationInbox.notifications.some((notification) =>
        notification.eventId === selectedEventId
      ) ||
      !notificationInbox.hasMore ||
      notificationInbox.isLoadingMore ||
      notificationInbox.hasLoadError ||
      automaticLoadState.current.loads >= focusInboxMaximumAutomaticPageLoads
    ) {
      return
    }
    automaticLoadState.current.loads += 1
    void notificationInbox.loadMore()
  }, [notificationInbox, selectedEventId, selectedFilter])

  return (
    <WorkspaceRouteContent
      sessionErrors={notificationInbox.sessionErrors ?? []}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceInboxView
          locale={workspace.locale}
          notificationInbox={notificationInbox}
          onOpenNotification={workspace.onOpenNotification}
          selectedEventId={selectedEventId}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}

/**
 * Parses the optional Focus source timeline without accepting unknown notification filters.
 *
 * @param value - Filter query parameter supplied by a Focus deep link.
 * @returns Archived or snoozed when explicitly selected, otherwise the active timeline.
 */
function readFocusInboxFilter(value: string | null): NotificationFilter {
  return value === 'archived' || value === 'snoozed' ? value : 'all'
}
