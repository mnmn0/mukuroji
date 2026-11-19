import { useState } from 'react'
import type { TeamIssue } from '../api/workItems'
import {
  useArchivedWorkItems,
  type ArchivedWorkItemScope,
} from '../queries/useArchivedWorkItems'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { ArchivedWorkItemsPanel } from './ArchivedWorkItemsPanel'

/** Props of the archived Work Item list connected to its query. */
export type ArchivedWorkItemsPanelContainerProps = {
  /** Work Item API access token. */
  accessToken?: string
  /** Team or Project whose archived Work Items are listed. */
  scope?: ArchivedWorkItemScope
  /** Locale used to format archive times. */
  locale: Locale
  /** Whether the viewer may restore this Work Item. */
  canRestore: (workItem: TeamIssue) => boolean
  /** Restores one Work Item and refreshes the page lists; undefined when the viewer may restore none. */
  onRestore?: (workItem: TeamIssue) => Promise<void>
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Reads the archived Work Items while the list is open and restores them one at a time.
 *
 * @param props - Scope, permission check, restore callback, and translator.
 * @returns The archived Work Item list.
 */
export function ArchivedWorkItemsPanelContainer({
  accessToken,
  scope,
  locale,
  canRestore,
  onRestore,
  t,
}: ArchivedWorkItemsPanelContainerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [restoringWorkItemId, setRestoringWorkItemId] = useState<string>()
  const [restoreErrorMessage, setRestoreErrorMessage] = useState<string>()
  const query = useArchivedWorkItems(accessToken, scope, isOpen)

  /** Restores one Work Item, then reads the archived list again. */
  const handleRestore = async (workItem: TeamIssue) => {
    if (!onRestore) return
    setRestoringWorkItemId(workItem.id)
    setRestoreErrorMessage(undefined)
    try {
      await onRestore(workItem)
    } catch (error) {
      setRestoreErrorMessage(error instanceof Error && error.message
        ? error.message
        : t('issues.archive.restoreError'))
    } finally {
      setRestoringWorkItemId(undefined)
      await query.mutate().catch(() => undefined)
    }
  }

  return (
    <ArchivedWorkItemsPanel
      canRestore={canRestore}
      errorMessage={query.error ? t('issues.archive.loadError') : undefined}
      isLoading={query.isLoading || query.isValidating}
      locale={locale}
      onOpenChange={setIsOpen}
      onRestore={onRestore ? (workItem) => void handleRestore(workItem) : undefined}
      onRetry={() => void query.mutate()}
      restoreErrorMessage={restoreErrorMessage}
      restoringWorkItemId={restoringWorkItemId}
      t={t}
      workItems={query.data}
    />
  )
}
