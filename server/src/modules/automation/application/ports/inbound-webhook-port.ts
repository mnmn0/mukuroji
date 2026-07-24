import type {
  AUTOMATION_SCHEMA_VERSION,
  AutomationInboundWebhookEndpoint,
  AutomationInboundWebhookLifecycleInput,
  CreateAutomationInboundWebhookEndpointInput,
  UpdateAutomationInboundWebhookEndpointInput,
} from '@mukuroji/contracts'

/** Server-only endpoint record containing an immutable secret reference. */
export type AutomationInboundWebhookEndpointRecord = AutomationInboundWebhookEndpoint & {
  /** Secrets Manager resource identifier. */
  secretId: string
  /** Immutable current secret version identifier. */
  secretVersionId: string
  /** Provisioning operation currently holding the endpoint. */
  provisioningOperationId?: string
  /** Status restored when provisioning completes. */
  provisioningTargetStatus?: 'active' | 'paused'
}

/** Durable idempotent create or rotate provisioning operation. */
export type AutomationInboundWebhookProvisioningOperation = {
  /** Deterministic operation identifier. */
  id: string
  /** Workspace that owns the operation. */
  workspaceId: string
  /** Actor that started the operation. */
  actorId: string
  /** Provisioning operation kind. */
  kind: 'create' | 'rotate'
  /** Target endpoint identifier. */
  endpointId: string
  /** Fingerprint binding the idempotency key to its input. */
  requestFingerprint: string
  /** Durable operation status. */
  status: 'provisioning' | 'succeeded'
  /** Endpoint status restored after provisioning. */
  targetStatus: 'active' | 'paused'
  /** Reserved endpoint version. */
  endpointVersion: number
  /** Reserved endpoint revision. */
  endpointRevision: number
  /** Reserved secret generation. */
  secretGeneration: number
  /** Secrets Manager resource identifier. */
  secretId: string
  /** Immutable Secrets Manager version identifier. */
  secretVersionId: string
  /** ISO creation timestamp. */
  createdAt: string
  /** ISO last-update timestamp. */
  updatedAt: string
  /** Deadline for plaintext-secret response-loss recovery. */
  recoveryExpiresAt: string
}

/** Endpoint and operation used by provisioning orchestration. */
export type AutomationInboundWebhookProvisioning = {
  /** Endpoint containing the internal secret reference. */
  endpoint: AutomationInboundWebhookEndpointRecord
  /** Durable idempotent provisioning operation. */
  operation: AutomationInboundWebhookProvisioningOperation
}

/** Durable intent that repeatedly removes a secret racing with endpoint revocation. */
export type AutomationInboundWebhookSecretCleanup = {
  /** Automation schema version. */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Workspace that owns the cleanup intent. */
  workspaceId: string
  /** Revoked endpoint identifier. */
  endpointId: string
  /** Secret resource to remove. */
  secretId: string
  /** Immutable secret version to remove. */
  secretVersionId: string
  /** Secret generation captured at revocation. */
  secretGeneration: number
  /** Optimistic cleanup revision. */
  revision: number
  /** Next ISO cleanup attempt timestamp. */
  nextCleanupAt: string
  /** ISO deadline covering late provisioning writes. */
  cleanupUntil: string
  /** ISO creation timestamp. */
  createdAt: string
  /** ISO last-update timestamp. */
  updatedAt: string
}

/** Input for the atomic inbound-delivery receipt and audit transaction. */
export type AutomationInboundWebhookDeliveryInput<TAuditMutation = unknown> = {
  /** Sender-provided key held stable across retries. */
  idempotencyKey: string
  /** SHA-256 fingerprint of the raw request bytes. */
  bodyFingerprint: string
  /** SHA-256 fingerprint of the verified signature. */
  signatureFingerprint: string
  /** Verified sender epoch timestamp. */
  signatureTimestamp: string
  /** Audit outbox event identifier. */
  eventId: string
  /** Adapter-owned audit mutation committed atomically with the delivery receipt. */
  auditMutation: TAuditMutation
}

/** Result of atomically recording one inbound webhook delivery. */
export type AutomationInboundWebhookDeliveryResult = {
  /** Original or newly recorded audit outbox event identifier. */
  eventId: string
  /** Whether an existing delivery receipt was replayed. */
  replayed: boolean
}

/** Durable endpoint, delivery, and secret-cleanup capability for inbound webhooks. */
export interface AutomationInboundWebhookPort<TAuditMutation = unknown> {
  /** Lists public endpoint views in a Workspace. */
  listInboundWebhookEndpoints(
    workspaceId: string,
  ): Promise<AutomationInboundWebhookEndpoint[]>
  /** Reads a public endpoint view in a Workspace. */
  getInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
  ): Promise<AutomationInboundWebhookEndpoint | undefined>
  /** Resolves an opaque public identifier to an internal secret reference. */
  resolveInboundWebhookEndpoint(
    opaqueEndpointId: string,
  ): Promise<AutomationInboundWebhookEndpointRecord | undefined>
  /** Atomically reserves an idempotent create provisioning operation. */
  reserveCreateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    input: CreateAutomationInboundWebhookEndpointInput,
    idempotencyKey: string,
    endpointBaseUrl: string,
  ): Promise<AutomationInboundWebhookProvisioning>
  /** Atomically reserves a secret-rotation provisioning operation. */
  reserveRotateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    idempotencyKey: string,
  ): Promise<AutomationInboundWebhookProvisioning>
  /** Commits a secret-provisioned endpoint and operation atomically. */
  completeInboundWebhookProvisioning(
    provisioning: AutomationInboundWebhookProvisioning,
  ): Promise<AutomationInboundWebhookEndpointRecord>
  /** Updates an endpoint display name with revision compare-and-swap. */
  updateInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: UpdateAutomationInboundWebhookEndpointInput,
  ): Promise<AutomationInboundWebhookEndpoint>
  /** Pauses or resumes an endpoint with revision compare-and-swap. */
  setInboundWebhookEndpointStatus(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    status: 'active' | 'paused',
  ): Promise<AutomationInboundWebhookEndpoint>
  /** Revokes an endpoint and removes its global lookup atomically. */
  revokeInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
  ): Promise<AutomationInboundWebhookEndpointRecord>
  /** Atomically records endpoint guards, replay receipts, and the audit outbox event. */
  recordInboundWebhookDelivery(
    endpoint: AutomationInboundWebhookEndpointRecord,
    input: AutomationInboundWebhookDeliveryInput<TAuditMutation>,
  ): Promise<AutomationInboundWebhookDeliveryResult>
  /** Lists due durable secret-cleanup intents from one schedule shard. */
  listDueInboundWebhookSecretCleanups(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<AutomationInboundWebhookSecretCleanup[]>
  /** Requeues or completes one secret-cleanup intent after a delete attempt. */
  completeInboundWebhookSecretCleanup(
    cleanup: AutomationInboundWebhookSecretCleanup,
    attemptedAt: string,
  ): Promise<void>
}
