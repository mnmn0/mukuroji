/**
 * Whether this deployment can deliver each external notification channel. Members may still
 * choose a channel the deployment cannot deliver; the settings screen then shows it as off here.
 */
export type NotificationTransports = {
  /** Whether an Email sender is configured. */
  email: boolean
  /** Whether a Web Push VAPID key is configured. */
  push: boolean
}
