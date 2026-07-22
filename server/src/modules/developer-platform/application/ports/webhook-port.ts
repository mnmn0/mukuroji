import type {
  ApiScope,
  UpdateWebhookSubscriptionInput,
  WebhookDelivery,
  WebhookEventEnvelope,
  WebhookSubscription,
} from '@mukuroji/contracts'
import type {
  IdempotentDomainMutationRequest,
  IdempotencyMutationResponse,
} from './request-control-port'

/** Validated input used to create a Webhook subscription. */
export type CreateWebhookSubscriptionInput = {
  /** Subscription display name. */
  name: string
  /** HTTPS delivery endpoint. */
  url: string
  /** Audit event types or wildcard patterns to subscribe to. */
  eventTypes: WebhookSubscription['eventTypes']
  /** Teams whose payloads may be delivered. */
  teamIds: string[]
  /** API scopes allowed in delivery payloads. */
  scopes?: ApiScope[]
}

/** Request used to create a Webhook subscription. */
export type CreateWebhookSubscriptionRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the subscription. */
  workspaceId: string
  /** Workspace user creating the subscription. */
  createdByUserId: string
  /** Validated subscription input. */
  input: CreateWebhookSubscriptionInput
}

/** Webhook subscription result containing its one-time signing secret. */
export type WebhookSecretResult = {
  /** Secret-free subscription. */
  subscription: WebhookSubscription
  /** Signing secret returned only once. */
  signingSecret: string
}

/** Request used to rotate a Webhook signing secret. */
export type RotateWebhookSecretRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the subscription. */
  workspaceId: string
  /** Subscription whose secret is rotated. */
  subscriptionId: string
}

/** Request used to update Webhook subscription status. */
export type SetWebhookSubscriptionStatusRequest = RotateWebhookSecretRequest & {
  /** New subscription status. */
  status: WebhookSubscription['status']
  /** Optional endpoint response committed with the status mutation. */
  idempotencyResponse?: IdempotencyMutationResponse
}

/** Request used to update Webhook subscription metadata. */
export type UpdateWebhookSubscriptionRequest = RotateWebhookSecretRequest & {
  /** Validated partial metadata update. */
  input: UpdateWebhookSubscriptionInput
  /** Optional endpoint response committed with the metadata mutation. */
  idempotencyResponse?: IdempotencyMutationResponse
}

/** Request used to enqueue a Webhook event. */
export type EnqueueWebhookEventRequest = {
  /** Workspace that owns the event. */
  workspaceId: string
  /** Subscription identifiers authorized by current RBAC. */
  authorizedSubscriptionIds: string[]
  /** Immutable event envelope to deliver. */
  event: WebhookEventEnvelope
}

/** Internal request for a bounded page of active subscriptions. */
export type ListActiveWebhookSubscriptionsPageRequest = {
  /** Workspace that owns the subscriptions. */
  workspaceId: string
  /** Maximum page size. */
  limit: number
  /** Opaque continuation returned by the previous page. */
  cursor?: string
}

/** Bounded page of strongly revalidated active subscriptions. */
export type ActiveWebhookSubscriptionsPage = {
  /** Active subscriptions in the page. */
  subscriptions: WebhookSubscription[]
  /** Opaque continuation when another page exists. */
  nextCursor?: string
}

/** Request used to list Webhook deliveries. */
export type ListWebhookDeliveriesRequest = {
  /** Workspace that owns the deliveries. */
  workspaceId: string
  /** Optional subscription filter. */
  subscriptionId?: string
  /** Optional page size. */
  limit?: number
  /** Opaque continuation returned by the previous page. */
  cursor?: string
}

/** Cursor-paginated Webhook delivery result. */
export type WebhookDeliveryPage = {
  /** Deliveries sorted by creation time descending. */
  deliveries: WebhookDelivery[]
  /** Opaque continuation when another page exists. */
  nextCursor?: string
}

/** Request used to read a Webhook delivery. */
export type GetWebhookDeliveryRequest = {
  /** Workspace that owns the delivery. */
  workspaceId: string
  /** Delivery identifier. */
  deliveryId: string
}

/** Secret-bearing delivery prepared for the Webhook worker. */
export type PreparedWebhookDelivery = {
  /** Current delivery state. */
  delivery: WebhookDelivery
  /** Subscription containing the delivery endpoint. */
  subscription: WebhookSubscription
  /** Signing secret confined to the worker. */
  signingSecret: string
  /** Stable JSON payload to sign. */
  payload: string
}

/** Request used to prepare a Webhook delivery. */
export type PrepareWebhookDeliveryRequest = {
  /** Workspace that owns the delivery. */
  workspaceId: string
  /** Delivery identifier. */
  deliveryId: string
}

/** Request used to persist a Webhook delivery attempt. */
export type RecordWebhookDeliveryAttemptRequest = PrepareWebhookDeliveryRequest & {
  /** Delivery status after the attempt. */
  status: WebhookDelivery['status']
  /** HTTP status returned by the remote endpoint. */
  responseStatus?: number
  /** Earliest timestamp for a retry. */
  nextAttemptAt?: string
  /** Short secret-free error description. */
  error?: string
}

/** Request used to create a replay delivery. */
export type ReplayWebhookDeliveryRequest = PrepareWebhookDeliveryRequest & {
  /** Digest binding retries to one replay delivery. */
  operationId?: string
}

/** Request used to verify an incoming Webhook signature. */
export type VerifyWebhookSignatureRequest = {
  /** Workspace that owns the subscription. */
  workspaceId: string
  /** Subscription used to resolve the signing secret. */
  subscriptionId: string
  /** Original HTTP request body. */
  payload: string
  /** Epoch seconds from the signature timestamp header. */
  timestamp: number
  /** Version-prefixed signature supplied by the caller. */
  signature: string
  /** Optional allowed clock skew in seconds. */
  toleranceSeconds?: number
}

/** Application port for Webhook subscription lifecycle. */
export interface WebhookSubscriptionPort {
  /** Creates a subscription and returns its signing secret once. */
  createWebhookSubscription(
    request: CreateWebhookSubscriptionRequest,
  ): Promise<WebhookSecretResult>
  /** Lists secret-free subscriptions for a workspace. */
  listWebhookSubscriptions(workspaceId: string): Promise<WebhookSubscription[]>
  /** Returns a bounded page from the active subscription projection. */
  listActiveWebhookSubscriptionsPage(
    request: ListActiveWebhookSubscriptionsPageRequest,
  ): Promise<ActiveWebhookSubscriptionsPage>
  /** Rotates a subscription signing secret. */
  rotateWebhookSecret(request: RotateWebhookSecretRequest): Promise<WebhookSecretResult>
  /** Updates subscription status. */
  setWebhookSubscriptionStatus(
    request: SetWebhookSubscriptionStatusRequest,
  ): Promise<WebhookSubscription>
  /** Updates subscription metadata and status atomically. */
  updateWebhookSubscription(
    request: UpdateWebhookSubscriptionRequest,
  ): Promise<WebhookSubscription>
  /** Verifies an incoming signature with timing-safe comparison. */
  verifyWebhookSignature(request: VerifyWebhookSignatureRequest): Promise<boolean>
}

/** Application port for Webhook delivery persistence and worker access. */
export interface WebhookDeliveryPort {
  /** Enqueues an event for authorized matching subscriptions. */
  enqueueWebhookEvent(request: EnqueueWebhookEventRequest): Promise<WebhookDelivery[]>
  /** Lists a cursor-paginated delivery log. */
  listWebhookDeliveries(request: ListWebhookDeliveriesRequest): Promise<WebhookDeliveryPage>
  /** Reads one tenant-bound delivery. */
  getWebhookDelivery(request: GetWebhookDeliveryRequest): Promise<WebhookDelivery>
  /** Resolves the secret-bearing payload required by a worker. */
  prepareWebhookDelivery(
    request: PrepareWebhookDeliveryRequest,
  ): Promise<PreparedWebhookDelivery>
  /** Persists the outcome of a delivery attempt. */
  recordWebhookDeliveryAttempt(
    request: RecordWebhookDeliveryAttemptRequest,
  ): Promise<WebhookDelivery>
  /** Creates a new pending replay while preserving the original delivery. */
  replayWebhookDelivery(request: ReplayWebhookDeliveryRequest): Promise<WebhookDelivery>
}
