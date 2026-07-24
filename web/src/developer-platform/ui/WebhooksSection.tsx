import type {
  WebhookDelivery,
  WebhookSubscription,
} from '@mukuroji/contracts'
import {
  ActionButtons,
  EmptyState,
  SectionHeader,
} from './DeveloperPlatformSectionParts'
import { StatusBadge } from './DeveloperPlatformStatus'
import type { DeveloperPlatformLabels } from './DeveloperPlatformView'

/**
 * Data and actions rendered by the pure Developer Platform webhooks view.
 */
export type WebhooksSectionProps = {
  /** Identifier of the webhook mutation currently in progress. */
  busyOperation?: string
  /** Whether webhook management actions are available. */
  canManage: boolean
  /** Webhook delivery attempts displayed in the delivery log. */
  deliveries: WebhookDelivery[]
  /** Formats an ISO 8601 timestamp for display. */
  formatDateTime: (value: string) => string
  /** Localized labels used by the webhooks section. */
  labels: DeveloperPlatformLabels
  /** Opens the webhook creation flow. */
  onCreate?: () => void
  /** Replays the selected failed webhook delivery. */
  onReplay?: (delivery: WebhookDelivery) => void
  /** Revokes the selected webhook subscription. */
  onRevoke?: (subscription: WebhookSubscription) => void
  /** Rotates the selected webhook subscription secret. */
  onRotate?: (subscription: WebhookSubscription) => void
  /** Webhook subscriptions displayed in the section. */
  subscriptions: WebhookSubscription[]
}

/**
 * Renders webhook subscriptions and delivery attempts without API or cache access.
 *
 * @param props - Webhook data, capability state, labels, and action callbacks.
 * @returns The pure webhooks section view.
 */
export function WebhooksSection({
  busyOperation,
  canManage,
  deliveries,
  formatDateTime,
  labels,
  onCreate,
  onReplay,
  onRevoke,
  onRotate,
  subscriptions,
}: WebhooksSectionProps) {
  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0">
        <SectionHeader
          action={
            canManage && onCreate
              ? { label: labels.actions.createWebhook, onClick: onCreate }
              : undefined
          }
          description={labels.helpText.webhooks}
          title={labels.headings.webhooks}
        />
        <p className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs font-medium leading-5 text-blue-900">
          {labels.helpText.webhookSigning}
        </p>
        {subscriptions.length ? (
          <div className="mt-4 grid gap-3">
            {subscriptions.map((subscription) => (
              <article
                className="rounded-lg border border-[var(--workbench-border)] p-4"
                key={subscription.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-[var(--workbench-text)]">
                        {subscription.name}
                      </h4>
                      <StatusBadge
                        labels={labels}
                        status={subscription.status}
                      />
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-[var(--workbench-muted)]">
                      {subscription.url}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {subscription.eventTypes.map((eventType) => (
                        <span className="workbench-badge" key={eventType}>
                          {labels.webhookEventOptions.find(
                            (option) => option.value === eventType,
                          )?.label ?? eventType}
                        </span>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-[var(--workbench-muted)]">
                      {labels.tableHeaders.failures}:{' '}
                      {subscription.failureCount}
                      {' · '}
                      {labels.tableHeaders.lastDelivery}:{' '}
                      {subscription.lastDeliveryAt
                        ? formatDateTime(subscription.lastDeliveryAt)
                        : labels.helpText.never}
                    </p>
                  </div>
                  {canManage && subscription.status === 'active' ? (
                    <ActionButtons
                      busy={busyOperation?.endsWith(subscription.id)}
                      labels={labels}
                      onRevoke={
                        onRevoke
                          ? () => onRevoke(subscription)
                          : undefined
                      }
                      onRotate={
                        onRotate
                          ? () => onRotate(subscription)
                          : undefined
                      }
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.webhooksEmpty}
            title={labels.headings.webhooksEmpty}
          />
        )}
      </section>

      <section className="min-w-0 border-t border-[var(--workbench-border)] pt-6">
        <SectionHeader
          description={labels.helpText.deliveries}
          title={labels.headings.deliveries}
        />
        {deliveries.length ? (
          <div className="mt-4 w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="bg-[var(--workbench-surface-muted)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                <tr>
                  {[
                    'event',
                    'status',
                    'attempts',
                    'response',
                    'created',
                    'actions',
                  ].map((header) => (
                    <th className="px-4 py-3" key={header} scope="col">
                      {labels.tableHeaders[header]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--workbench-border)]">
                {deliveries.map((delivery) => (
                  <tr
                    className={
                      delivery.status === 'failed' ? 'bg-red-50/60' : ''
                    }
                    key={delivery.id}
                  >
                    <td className="px-4 py-3">
                      <span className="block font-semibold">
                        {delivery.eventType}
                      </span>
                      <span className="mt-1 block font-mono text-xs text-[var(--workbench-muted)]">
                        {delivery.eventId}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        labels={labels}
                        status={delivery.status}
                      />
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {delivery.attempts}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {delivery.responseStatus ?? labels.helpText.pending}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {formatDateTime(delivery.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      {canManage &&
                      onReplay &&
                      delivery.status === 'failed' ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:opacity-50"
                          disabled={busyOperation?.endsWith(delivery.id)}
                          onClick={() => onReplay(delivery)}
                          type="button"
                        >
                          {labels.actions.replay}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.deliveriesEmpty}
            title={labels.headings.deliveriesEmpty}
          />
        )}
      </section>
    </div>
  )
}
