/** Immutable Secrets Manager generation pinned to an inbound Webhook endpoint. */
export type AutomationInboundWebhookSecretReference = {
  /** Workspace that owns the endpoint. */
  workspaceId: string
  /** Endpoint identifier within the Workspace. */
  endpointId: string
  /** Secrets Manager resource identifier. */
  secretId: string
  /** Immutable Secrets Manager version identifier. */
  secretVersionId: string
  /** Monotonically increasing endpoint secret generation. */
  secretGeneration: number
}

/** External secret side-effect port required by inbound Webhook use cases. */
export interface AutomationInboundWebhookSecretStore {
  /** Provisions or recovers one reserved generation and returns plaintext once. */
  provision(reference: AutomationInboundWebhookSecretReference): Promise<string>
  /** Reads one pinned generation for public delivery verification. */
  get(reference: AutomationInboundWebhookSecretReference): Promise<Uint8Array>
  /** Removes all generations belonging to a revoked endpoint resource. */
  delete(reference: AutomationInboundWebhookSecretReference): Promise<void>
}
