import type { PushSubscriptionKeys } from '@mukuroji/contracts'

/** One registered browser or app that can receive Web Push for a member. */
export type PushDevice = {
  /** Endpoint-derived subscription ID. */
  subscriptionId: string
  /** Push service URL validated at registration. */
  endpoint: string
  /** Encryption keys issued with the subscription. */
  keys: PushSubscriptionKeys
  /** Registration time; a gone-device removal deletes only this exact registration. */
  updatedAt: string
}

/** Reads a recipient's devices and removes those the push service reports as gone. */
export type PushDeviceDirectory = {
  /** Lists unexpired devices the recipient still owns; transient failures reject. */
  listDevices(workspaceId: string, memberKey: string, now: Date, signal: AbortSignal): Promise<PushDevice[]>
  /**
   * Strongly rechecks, right before a device is sent to, that the recipient still owns its
   * endpoint, so a device another member took over after the listing never gets this message.
   */
  isDeviceOwned(workspaceId: string, memberKey: string, device: PushDevice, signal: AbortSignal): Promise<boolean>
  /** Deletes one registration after a `404` or `410` from its push service. */
  removeGoneDevice(workspaceId: string, memberKey: string, device: PushDevice, signal: AbortSignal): Promise<void>
}
