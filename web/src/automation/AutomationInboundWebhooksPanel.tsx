import type {
  AutomationInboundWebhookEndpoint,
  AutomationInboundWebhookSecretResponse,
  CreateAutomationInboundWebhookEndpointInput,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../i18n'
import { reduceAutomationWebhookSecret } from './webhookSecretState'

const webhookStatusLabelKeys: Record<AutomationInboundWebhookEndpoint['status'], MessageKey> = {
  provisioning: 'automation.webhook.status.provisioning',
  active: 'automation.webhook.status.active',
  paused: 'automation.webhook.status.paused',
  revoked: 'automation.webhook.status.revoked',
}

/** Inbound Webhook 管理 panel の props です。 */
export type AutomationInboundWebhooksPanelProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Secret を含まない durable endpoint 一覧です。 */
  endpoints: AutomationInboundWebhookEndpoint[]
  /** Mutation 実行中の operation key です。 */
  busyOperation?: string
  /** Mutation controls を表示しない参照専用状態です。 */
  readOnly: boolean
  /** Endpoint 作成 callback です。 */
  onCreate?: (
    input: CreateAutomationInboundWebhookEndpointInput,
  ) => Promise<AutomationInboundWebhookSecretResponse>
  /** Active endpoint の pause callback です。 */
  onPause?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
  /** Paused endpoint の resume callback です。 */
  onResume?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
  /** Signing secret rotate callback です。 */
  onRotate?: (
    endpoint: AutomationInboundWebhookEndpoint,
  ) => Promise<AutomationInboundWebhookSecretResponse>
  /** Endpoint revoke callback です。 */
  onRevoke?: (endpoint: AutomationInboundWebhookEndpoint) => Promise<unknown> | unknown
}

/** Inbound Webhook endpoint と一回限りの signing secret を管理します。 */
export function AutomationInboundWebhooksPanel({
  busyOperation,
  endpoints,
  locale,
  onCreate,
  onPause,
  onResume,
  onRevoke,
  onRotate,
  readOnly,
}: AutomationInboundWebhooksPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [name, setName] = useState('')
  const [oneTimeSecret, dispatchSecret] = useReducer(
    reduceAutomationWebhookSecret,
    undefined,
  )
  const readOnlyRef = useRef(readOnly)
  const isMutationBusy = Boolean(busyOperation)

  useEffect(() => {
    readOnlyRef.current = readOnly
    if (!readOnly) return
    // 権限変更時は secret を component state から即時に破棄します。
    dispatchSecret({ readOnly, type: 'access-change' })
  }, [readOnly])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedName = name.trim()
    if (!normalizedName || !onCreate) return
    try {
      const response = await onCreate({ name: normalizedName })
      dispatchSecret({ readOnly: readOnlyRef.current, response, type: 'reveal' })
    } catch {
      return
    }
    setName('')
  }

  async function handleRotate(endpoint: AutomationInboundWebhookEndpoint) {
    if (!onRotate) return
    try {
      const response = await onRotate(endpoint)
      dispatchSecret({ readOnly: readOnlyRef.current, response, type: 'reveal' })
    } catch {
      return
    }
  }

  async function handleLifecycle(request: () => Promise<unknown> | unknown) {
    try {
      await request()
    } catch {
      return
    }
  }

  async function handleRevoke(endpoint: AutomationInboundWebhookEndpoint) {
    if (!onRevoke) return
    try {
      await onRevoke(endpoint)
    } catch {
      return
    }
    dispatchSecret({ endpointId: endpoint.id, type: 'revoke' })
  }

  return (
    <div className="grid gap-5" data-testid="automation-inbound-webhooks-panel">
      {!readOnly && onCreate ? (
        <form
          className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
          onSubmit={(event) => void handleCreate(event)}
        >
          <div>
            <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('automation.webhook.createTitle')}
            </h3>
            <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('automation.webhook.createDescription')}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <label className="grid min-w-[240px] flex-1 gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.common.name')}
              <input
                className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                data-testid="automation-webhook-name"
                maxLength={160}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
              data-testid="automation-webhook-create"
              disabled={isMutationBusy || !name.trim()}
              type="submit"
            >
              {t(busyOperation === 'webhook:create'
                ? 'automation.common.saving'
                : 'automation.webhook.create')}
            </button>
          </div>
        </form>
      ) : null}

      {!readOnly && oneTimeSecret ? (
        <AutomationWebhookSecretNotice
          endpointName={oneTimeSecret.endpointName}
          locale={locale}
          signingSecret={oneTimeSecret.signingSecret}
          onDismiss={() => dispatchSecret({ type: 'dismiss' })}
        />
      ) : null}

      {endpoints.length === 0 ? (
        <div className="grid min-h-28 place-items-center rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] p-5 text-center">
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('automation.webhook.empty')}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {endpoints.map((endpoint) => {
            const canRotate = endpoint.status === 'active' || endpoint.status === 'paused'
            return (
              <article
                className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-white p-4"
                data-testid={`automation-webhook-${endpoint.id}`}
                key={endpoint.id}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="break-words text-sm font-semibold text-[var(--workbench-text)]">
                        {endpoint.name}
                      </h3>
                      <span className={endpoint.status === 'active'
                        ? 'workbench-badge-primary'
                        : 'workbench-badge'}>
                        {t(webhookStatusLabelKeys[endpoint.status])}
                      </span>
                      <span className="workbench-badge">
                        {t('automation.version').replace('{version}', String(endpoint.version))}
                      </span>
                    </div>
                    <p className="mt-2 break-all text-xs font-medium text-[var(--workbench-muted)]">
                      {t('automation.webhook.endpointId').replace('{id}', endpoint.id)}
                    </p>
                  </div>
                  {!readOnly ? (
                    <div className="flex min-w-0 flex-wrap justify-end gap-2">
                      {endpoint.status === 'active' && onPause ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                          data-testid={`automation-webhook-pause-${endpoint.id}`}
                          disabled={isMutationBusy}
                          type="button"
                          onClick={() => void handleLifecycle(() => onPause(endpoint))}
                        >
                          {t('automation.pause')}
                        </button>
                      ) : null}
                      {endpoint.status === 'paused' && onResume ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                          data-testid={`automation-webhook-resume-${endpoint.id}`}
                          disabled={isMutationBusy}
                          type="button"
                          onClick={() => void handleLifecycle(() => onResume(endpoint))}
                        >
                          {t('automation.webhook.resume')}
                        </button>
                      ) : null}
                      {canRotate && onRotate ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                          data-testid={`automation-webhook-rotate-${endpoint.id}`}
                          disabled={isMutationBusy}
                          type="button"
                          onClick={() => void handleRotate(endpoint)}
                        >
                          {t('automation.webhook.rotate')}
                        </button>
                      ) : null}
                      {endpoint.status !== 'revoked' && onRevoke ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                          data-testid={`automation-webhook-revoke-${endpoint.id}`}
                          disabled={isMutationBusy}
                          type="button"
                          onClick={() => void handleRevoke(endpoint)}
                        >
                          {t('automation.webhook.revoke')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {endpoint.status === 'provisioning' ? (
                  <section
                    className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-3 text-amber-950"
                    data-testid={`automation-webhook-provisioning-warning-${endpoint.id}`}
                    role="status"
                  >
                    <h4 className="text-xs font-bold">
                      {t('automation.webhook.provisioningWarningTitle')}
                    </h4>
                    <p className="mt-1 text-xs font-medium leading-5">
                      {t('automation.webhook.provisioningWarningDescription')}
                    </p>
                  </section>
                ) : null}
                <dl className="grid gap-2 rounded-lg bg-[var(--workbench-surface-muted)] px-3 py-3">
                  <div className="grid gap-1">
                    <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
                      {t('automation.webhook.endpointUrl')}
                    </dt>
                    <dd>
                      <code className="break-all text-xs font-semibold text-[var(--workbench-text)]">
                        {endpoint.endpointUrl}
                      </code>
                    </dd>
                  </div>
                  <div className="text-xs font-medium text-[var(--workbench-muted)]">
                    {t('automation.webhook.secretGeneration')
                      .replace('{generation}', String(endpoint.secretGeneration))}
                  </div>
                </dl>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 一回限りの Webhook signing secret notice の props です。 */
export type AutomationWebhookSecretNoticeProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Secret を発行した endpoint 表示名です。 */
  endpointName: string
  /** Create/rotate response だけから受け取る secret です。 */
  signingSecret: string
  /** Secret を React state から破棄する callback です。 */
  onDismiss: () => void
}

/** Create/rotate 直後だけ signing secret を表示します。 */
export function AutomationWebhookSecretNotice({
  endpointName,
  locale,
  onDismiss,
  signingSecret,
}: AutomationWebhookSecretNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  return (
    <section
      className="rounded-lg border border-amber-300 bg-amber-50 p-4"
      data-testid="automation-webhook-one-time-secret"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-950">
            {t('automation.webhook.secretTitle')} · {endpointName}
          </h3>
          <p className="mt-1 text-xs font-medium leading-5 text-amber-900">
            {t('automation.webhook.secretDescription')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          data-testid="automation-webhook-secret-dismiss"
          type="button"
          onClick={onDismiss}
        >
          {t('automation.webhook.secretDismiss')}
        </button>
      </div>
      <div className="mt-3 grid gap-1 rounded-lg border border-amber-300 bg-white px-3 py-3">
        <span className="text-xs font-semibold text-amber-900">
          {t('automation.webhook.secretLabel')}
        </span>
        <code className="break-all text-sm font-semibold text-[var(--workbench-text)]">
          {signingSecret}
        </code>
      </div>
    </section>
  )
}
