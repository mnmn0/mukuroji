/** Whether Web Push can be used, and the key a browser needs to subscribe. */
export type PushConfiguration = {
  /** Whether this deployment accepts push subscriptions. */
  enabled: boolean
  /** VAPID application server public key, base64url-encoded; present only when enabled. */
  vapidPublicKey?: string
}

/** Encryption keys a browser issues with a push subscription. */
export type PushSubscriptionKeys = {
  /** Uncompressed P-256 public key, base64url-encoded. */
  p256dh: string
  /** 16-byte authentication secret, base64url-encoded. */
  auth: string
}

/** A browser push subscription registered for the signed-in member. */
export type PushSubscriptionInput = {
  /** Push service URL the browser issued. */
  endpoint: string
  /** Message encryption keys for the subscription. */
  keys: PushSubscriptionKeys
}

/** Identifies the push subscription to remove for the signed-in member. */
export type PushSubscriptionRemovalInput = {
  /** Push service URL the browser issued. */
  endpoint: string
}

/** Message the push delivery worker sends and the service worker shows as a notification. */
export type PushNotificationPayload = {
  /** Notification title, already localized for the recipient. */
  title: string
  /** Notification body text. */
  body?: string
  /** Same-origin application path opened when the notification is clicked. */
  path?: string
  /** Replaces an earlier notification with the same tag instead of stacking a new one. */
  tag?: string
}
