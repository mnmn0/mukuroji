import { useId, useState } from 'react'
import { isSlackIncomingWebhookUrl, type NotificationMessageLocale } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { SlackDestinationController, SlackDestinationOutcome } from '../mutations/useSlackDestination'

/** Props of {@link SlackDestinationPanel}. */
export type SlackDestinationPanelProps = {
  /** Whose destination the card edits. */
  kind: 'personal' | 'team' | 'project'
  /** Destination state and actions. */
  controller: SlackDestinationController
  /** Message translator. */
  t: (key: MessageKey) => string
}

/**
 * Settings card that registers, tests, and removes a Slack Incoming Webhook. The stored URL is
 * never shown; the card only says whether one is registered.
 *
 * @param props - Card kind, controller, and translator.
 * @returns The settings card.
 */
export function SlackDestinationPanel({ controller, kind, t }: SlackDestinationPanelProps) {
  const headingId = useId()
  const urlId = useId()
  const labelId = useId()
  const localeId = useId()
  const { view, pending, outcome } = controller
  const [webhookUrl, setWebhookUrl] = useState('')
  const [label, setLabel] = useState<string>()
  const [postLocale, setPostLocale] = useState<NotificationMessageLocale>()
  const isChannel = kind !== 'personal'
  const urlTyped = webhookUrl.trim().length > 0
  const urlInvalid = urlTyped && !isSlackIncomingWebhookUrl(webhookUrl)
  const canSave = Boolean(view?.canManage) && !pending && !urlInvalid && (urlTyped || (isChannel && Boolean(view?.configured)))

  return (
    <section aria-busy={pending} aria-labelledby={headingId} className="workbench-panel grid gap-4 p-5" data-testid={`slack-destination-${kind}`}>
      <div className="min-w-0 max-w-[680px]">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id={headingId}>
          {t(`workspace.slackDestination.${kind}.title`)}
        </h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t(`workspace.slackDestination.${kind}.description`)}
        </p>
      </div>
      {controller.loadFailed ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-fg-red-700">{t('workspace.slackDestination.loadError')}</p>
          <button className="workbench-button-secondary min-h-10 px-4" onClick={controller.retry} type="button">
            {t('workspace.slackDestination.retry')}
          </button>
        </div>
      ) : !view ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('workspace.slackDestination.loading')}</p>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            const submitted = webhookUrl
            void controller.save({
              webhookUrl: submitted,
              ...(isChannel ? { label: label ?? view.label ?? '', locale: postLocale ?? view.locale ?? 'ja' } : {}),
            }).then((saved) => {
              // Keep the URL after a failed save, and keep anything typed while the save ran.
              if (saved) setWebhookUrl((current) => (current === submitted ? '' : current))
            })
          }}
        >
          <p className="text-sm font-semibold text-[var(--workbench-text)]" data-testid="slack-destination-status">
            {view.configured
              ? view.label
                ? `${t('workspace.slackDestination.configured')} (${view.label})`
                : t('workspace.slackDestination.configured')
              : t('workspace.slackDestination.notConfigured')}
          </p>
          {view.canManage ? (
            <>
              <label className="grid gap-1 text-sm font-medium" htmlFor={urlId}>
                {t(view.configured ? 'workspace.slackDestination.replaceUrl' : 'workspace.slackDestination.url')}
                <input
                  aria-describedby={urlInvalid ? `${urlId}-error` : undefined}
                  aria-invalid={urlInvalid}
                  autoComplete="off"
                  className="workbench-input min-h-10 px-3"
                  id={urlId}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder="https://hooks.slack.com/services/…"
                  spellCheck={false}
                  type="url"
                  value={webhookUrl}
                />
              </label>
              {urlInvalid ? (
                <p className="text-sm text-fg-red-700" id={`${urlId}-error`}>{t('workspace.slackDestination.invalidUrl')}</p>
              ) : null}
              {isChannel ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm font-medium" htmlFor={labelId}>
                    {t('workspace.slackDestination.label')}
                    <input
                      className="workbench-input min-h-10 px-3"
                      id={labelId}
                      maxLength={80}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="#channel"
                      value={label ?? view.label ?? ''}
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-medium" htmlFor={localeId}>
                    {t('workspace.slackDestination.locale')}
                    <select
                      className="workbench-input min-h-10 px-3"
                      id={localeId}
                      onChange={(event) => setPostLocale(event.target.value === 'en' ? 'en' : 'ja')}
                      value={postLocale ?? view.locale ?? 'ja'}
                    >
                      <option value="ja">日本語</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button aria-disabled={!canSave} className="workbench-button-primary min-h-10 px-4 aria-disabled:cursor-not-allowed aria-disabled:opacity-55" type="submit">
                  {t('workspace.slackDestination.save')}
                </button>
                {view.configured ? (
                  <>
                    <button aria-disabled={pending} className="workbench-button-secondary min-h-10 px-4" onClick={() => { if (!pending) controller.test() }} type="button">
                      {t('workspace.slackDestination.test')}
                    </button>
                    <button aria-disabled={pending} className="workbench-button-secondary min-h-10 px-4" onClick={() => { if (!pending) controller.remove() }} type="button">
                      {t('workspace.slackDestination.remove')}
                    </button>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.slackDestination.readOnly')}</p>
          )}
          <p aria-live="polite" className={outcome?.kind === 'error' || outcome?.kind === 'test-failed' ? 'text-sm font-semibold text-fg-red-700' : 'text-sm text-[var(--workbench-muted)]'} data-testid="slack-destination-outcome">
            {outcome ? t(outcomeKey(outcome)) : null}
          </p>
        </form>
      )}
    </section>
  )
}

/**
 * Picks the message of the last action's outcome.
 * @param outcome - Last outcome.
 * @returns Message key.
 */
function outcomeKey(outcome: SlackDestinationOutcome): MessageKey {
  switch (outcome.kind) {
    case 'saved':
      return 'workspace.slackDestination.saved'
    case 'deleted':
      return 'workspace.slackDestination.deleted'
    case 'tested':
      return 'workspace.slackDestination.tested'
    case 'test-failed':
      return outcome.code === 'SlackDeliveryRejected' || outcome.code === 'SlackDestinationInvalid'
        ? 'workspace.slackDestination.testRejected'
        : 'workspace.slackDestination.testUnavailable'
    case 'error':
      if (outcome.code === 'NotificationDestinationConflict') return 'workspace.slackDestination.conflict'
      if (outcome.code === 'InvalidNotificationDestination') return 'workspace.slackDestination.invalidUrl'
      return 'workspace.slackDestination.failed'
  }
}
