import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { useNotificationPreferences } from '../mutations/useNotifications'
import { usePushDevice } from '../mutations/usePushDevice'
import { useSlackDestination } from '../mutations/useSlackDestination'
import type {
  NotificationPreferencesSessionErrorReporter,
} from '../queries/useNotificationPreferences'
import type { PushRequestGuard } from '../queries/usePushDeviceStatus'
import type { NotificationMuteTeam } from './NotificationRoutingFields'
import { NotificationSettingsPanel } from './NotificationSettingsPanel'
import { PushDeviceSettings } from './PushDeviceSettings'
import { SlackDestinationPanel } from './SlackDestinationPanel'

/**
 * Inputs for the notification settings feature container.
 */
export type NotificationSettingsPanelContainerProps = {
  /** Access token used to load and update notification preferences. */
  accessToken: string
  /** Locale used by the notification settings panel. */
  locale: Locale
  /** Optional callback that forwards session-policy errors to the Workspace shell. */
  onSessionError?: NotificationPreferencesSessionErrorReporter
  /** Optional session guard that reports push request session failures to the Workspace shell. */
  guardRequest?: PushRequestGuard
  /** Teams and Projects the member can mute; omitted while unknown. */
  muteTargets?: readonly NotificationMuteTeam[]
}

/**
 * Connects notification preference queries and mutations to their settings panel, followed by
 * this device's push registration and the member's own Slack destination.
 *
 * @param props - Authentication, locale, and session-error forwarding inputs.
 * @returns The notification settings panel and push device card backed by their controllers.
 */
export function NotificationSettingsPanelContainer({
  accessToken,
  locale,
  onSessionError,
  guardRequest,
  muteTargets,
}: NotificationSettingsPanelContainerProps) {
  const controller = useNotificationPreferences(
    accessToken,
    true,
    onSessionError,
  )
  const pushDevice = usePushDevice(accessToken, guardRequest ? { guardRequest } : {})
  const slackDestination = useSlackDestination(accessToken, 'personal', locale)
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <div className="grid gap-4">
      <NotificationSettingsPanel
        controller={controller}
        key={controller.preferences?.version ?? 'notification-settings-loading'}
        locale={locale}
        muteTargets={muteTargets}
      />
      <PushDeviceSettings controller={pushDevice} locale={locale} />
      <SlackDestinationPanel controller={slackDestination} kind="personal" t={t} />
    </div>
  )
}
