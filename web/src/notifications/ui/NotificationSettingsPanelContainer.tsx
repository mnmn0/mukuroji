import type { Locale } from '../../shared/i18n/i18n'
import { useNotificationPreferences } from '../mutations/useNotifications'
import { usePushDevice } from '../mutations/usePushDevice'
import type {
  NotificationPreferencesSessionErrorReporter,
} from '../queries/useNotificationPreferences'
import { NotificationSettingsPanel } from './NotificationSettingsPanel'
import { PushDeviceSettings } from './PushDeviceSettings'

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
}

/**
 * Connects notification preference queries and mutations to their settings panel, followed by
 * this device's push registration.
 *
 * @param props - Authentication, locale, and session-error forwarding inputs.
 * @returns The notification settings panel and push device card backed by their controllers.
 */
export function NotificationSettingsPanelContainer({
  accessToken,
  locale,
  onSessionError,
}: NotificationSettingsPanelContainerProps) {
  const controller = useNotificationPreferences(
    accessToken,
    true,
    onSessionError,
  )
  const pushDevice = usePushDevice(accessToken)

  return (
    <div className="grid gap-4">
      <NotificationSettingsPanel
        controller={controller}
        key={controller.preferences?.version ?? 'notification-settings-loading'}
        locale={locale}
      />
      <PushDeviceSettings controller={pushDevice} locale={locale} />
    </div>
  )
}
