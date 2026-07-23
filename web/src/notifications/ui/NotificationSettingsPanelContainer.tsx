import type { Locale } from '../../shared/i18n/i18n'
import { useNotificationPreferences } from '../mutations/useNotifications'
import { NotificationSettingsPanel } from './NotificationSettingsPanel'

/**
 * Inputs for the notification settings feature container.
 */
export type NotificationSettingsPanelContainerProps = {
  /** Access token used to load and update notification preferences. */
  accessToken: string
  /** Locale used by the notification settings panel. */
  locale: Locale
  /** Optional callback that forwards session-policy errors to the Workspace shell. */
  onSessionError?: (error?: unknown) => void
}

/**
 * Connects notification preference queries and mutations to their settings panel.
 *
 * @param props - Authentication, locale, and session-error forwarding inputs.
 * @returns The notification settings panel backed by its feature controller.
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

  return (
    <NotificationSettingsPanel
      controller={controller}
      key={controller.preferences?.version ?? 'notification-settings-loading'}
      locale={locale}
    />
  )
}
