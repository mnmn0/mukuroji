import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { useCalendarFeeds } from '../mutations/useCalendarFeeds'
import { CalendarFeedsPanel, type CalendarFeedTeamOption } from './CalendarFeedsPanel'

/** Inputs of the calendar feed settings container. */
export type CalendarFeedsPanelContainerProps = {
  /** Access token of the signed-in member. */
  accessToken: string
  /** Locale of the screen and of the event titles a new feed writes. */
  locale: Locale
  /** Teams and Projects the member can see. */
  teams: readonly CalendarFeedTeamOption[]
}

/**
 * Copies text to the clipboard.
 *
 * @param text - Text to copy.
 * @returns Whether the browser copied it.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Connects the calendar feed settings to the member's feed API.
 *
 * @param props - Session, locale, and visible Teams.
 * @returns The settings section.
 */
export function CalendarFeedsPanelContainer({ accessToken, locale, teams }: CalendarFeedsPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const feeds = useCalendarFeeds(accessToken)
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )
  return (
    <CalendarFeedsPanel
      busyOperation={feeds.busyOperation}
      feeds={feeds.feeds}
      formatDateTime={(value) => formatter.format(new Date(value))}
      hasLoadError={feeds.hasLoadError}
      hasOperationError={feeds.hasOperationError}
      isLoading={feeds.isLoading}
      issued={feeds.issued}
      onCopy={copyText}
      onDismissIssued={feeds.dismissIssued}
      onIssueMember={() => void feeds.issue({ kind: 'member', locale })}
      onIssueProject={(teamId, projectId) => void feeds.issue({ kind: 'project', teamId, projectId, locale })}
      onReload={() => void feeds.reload()}
      onRevoke={(feed) => void feeds.revoke(feed)}
      t={t}
      teams={teams}
    />
  )
}
