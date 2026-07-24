import type {
  CreateWebhookSubscriptionRequest,
  EnqueueWebhookEventRequest,
  GetWebhookDeliveryRequest,
  ListActiveWebhookSubscriptionsPageRequest,
  ListWebhookDeliveriesRequest,
  PrepareWebhookDeliveryRequest,
  RecordWebhookDeliveryAttemptRequest,
  ReplayWebhookDeliveryRequest,
  RotateWebhookSecretRequest,
  SetWebhookSubscriptionStatusRequest,
  UpdateWebhookSubscriptionRequest,
  VerifyWebhookSignatureRequest,
  WebhookDeliveryPort,
  WebhookSubscriptionPort,
} from '../../application/ports'

/** Focused adapter for Webhook subscription lifecycle operations. */
export class WebhookSubscriptionAdapter implements WebhookSubscriptionPort {
  /** Storage implementation that owns Webhook subscription records. */
  readonly #source: WebhookSubscriptionPort

  /** Creates a focused Webhook subscription adapter. */
  constructor(source: WebhookSubscriptionPort) {
    this.#source = source
  }

  /** Creates a Webhook subscription. */
  createWebhookSubscription(request: CreateWebhookSubscriptionRequest) {
    return this.#source.createWebhookSubscription(request)
  }

  /** Lists Webhook subscriptions. */
  listWebhookSubscriptions(workspaceId: string) {
    return this.#source.listWebhookSubscriptions(workspaceId)
  }

  /** Lists a bounded page of active subscriptions. */
  listActiveWebhookSubscriptionsPage(
    request: ListActiveWebhookSubscriptionsPageRequest,
  ) {
    return this.#source.listActiveWebhookSubscriptionsPage(request)
  }

  /** Rotates a Webhook signing secret. */
  rotateWebhookSecret(request: RotateWebhookSecretRequest) {
    return this.#source.rotateWebhookSecret(request)
  }

  /** Updates Webhook subscription status. */
  setWebhookSubscriptionStatus(request: SetWebhookSubscriptionStatusRequest) {
    return this.#source.setWebhookSubscriptionStatus(request)
  }

  /** Updates Webhook subscription metadata. */
  updateWebhookSubscription(request: UpdateWebhookSubscriptionRequest) {
    return this.#source.updateWebhookSubscription(request)
  }

  /** Verifies a Webhook signature. */
  verifyWebhookSignature(request: VerifyWebhookSignatureRequest) {
    return this.#source.verifyWebhookSignature(request)
  }
}

/** Focused adapter for Webhook delivery persistence and worker operations. */
export class WebhookDeliveryAdapter implements WebhookDeliveryPort {
  /** Storage implementation that owns Webhook delivery records. */
  readonly #source: WebhookDeliveryPort

  /** Creates a focused Webhook delivery adapter. */
  constructor(source: WebhookDeliveryPort) {
    this.#source = source
  }

  /** Enqueues a Webhook event. */
  enqueueWebhookEvent(request: EnqueueWebhookEventRequest) {
    return this.#source.enqueueWebhookEvent(request)
  }

  /** Lists Webhook deliveries. */
  listWebhookDeliveries(request: ListWebhookDeliveriesRequest) {
    return this.#source.listWebhookDeliveries(request)
  }

  /** Reads one Webhook delivery. */
  getWebhookDelivery(request: GetWebhookDeliveryRequest) {
    return this.#source.getWebhookDelivery(request)
  }

  /** Prepares one Webhook delivery for transport. */
  prepareWebhookDelivery(request: PrepareWebhookDeliveryRequest) {
    return this.#source.prepareWebhookDelivery(request)
  }

  /** Records one Webhook delivery attempt. */
  recordWebhookDeliveryAttempt(request: RecordWebhookDeliveryAttemptRequest) {
    return this.#source.recordWebhookDeliveryAttempt(request)
  }

  /** Replays one Webhook delivery. */
  replayWebhookDelivery(request: ReplayWebhookDeliveryRequest) {
    return this.#source.replayWebhookDelivery(request)
  }
}
