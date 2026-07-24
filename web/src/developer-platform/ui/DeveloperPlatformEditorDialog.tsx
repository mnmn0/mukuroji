import type { ApiScope } from '@mukuroji/contracts'
import type { FormEvent } from 'react'
import type { DeveloperOAuthGrantType } from '../model/credentials'
import type { DeveloperWebhookEventType } from '../model/webhooks'
import { OptionChecklist, TextField } from './DeveloperPlatformFields'
import type {
  DeveloperPlatformLabels,
  DeveloperPlatformOption,
  EditorDialogKind,
} from './DeveloperPlatformView'
import { trapDialogFocus } from './dialogFocus'

/**
 * Renders the controlled API key, OAuth application, or webhook creation dialog.
 *
 * @param props - Dialog kind, controlled form values, labels, and callbacks.
 * @returns The Developer Platform editor dialog.
 */
export function EditorDialog(props: {
  apiKeyExpiry: string
  apiKeyName: string
  apiKeyScopes: ApiScope[]
  busyOperation?: string
  kind: EditorDialogKind
  labels: DeveloperPlatformLabels
  oauthExpiry: string
  oauthGrantTypes: DeveloperOAuthGrantType[]
  oauthName: string
  oauthScopes: ApiScope[]
  webhookEvents: DeveloperWebhookEventType[]
  webhookName: string
  webhookScopes: ApiScope[]
  webhookTeamIds: string[]
  webhookTeamOptions: DeveloperPlatformOption[]
  webhookUrl: string
  onApiKeyExpiryChange: (value: string) => void
  onApiKeyNameChange: (value: string) => void
  onApiKeyScopesChange: (value: ApiScope[]) => void
  onOAuthExpiryChange: (value: string) => void
  onOAuthGrantTypesChange: (value: DeveloperOAuthGrantType[]) => void
  onOAuthNameChange: (value: string) => void
  onOAuthScopesChange: (value: ApiScope[]) => void
  onRequestClose: () => void
  onSubmitApiKey: (event: FormEvent<HTMLFormElement>) => void
  onSubmitOAuthApp: (event: FormEvent<HTMLFormElement>) => void
  onSubmitWebhook: (event: FormEvent<HTMLFormElement>) => void
  onWebhookEventsChange: (value: DeveloperWebhookEventType[]) => void
  onWebhookNameChange: (value: string) => void
  onWebhookScopesChange: (value: ApiScope[]) => void
  onWebhookTeamIdsChange: (value: string[]) => void
  onWebhookUrlChange: (value: string) => void
}) {
  const {
    apiKeyExpiry,
    apiKeyName,
    apiKeyScopes,
    busyOperation,
    kind,
    labels,
    oauthExpiry,
    oauthGrantTypes,
    oauthName,
    oauthScopes,
    webhookEvents,
    webhookName,
    webhookScopes,
    webhookTeamIds,
    webhookTeamOptions,
    webhookUrl,
    onApiKeyExpiryChange,
    onApiKeyNameChange,
    onApiKeyScopesChange,
    onOAuthExpiryChange,
    onOAuthGrantTypesChange,
    onOAuthNameChange,
    onOAuthScopesChange,
    onRequestClose,
    onSubmitApiKey,
    onSubmitOAuthApp,
    onSubmitWebhook,
    onWebhookEventsChange,
    onWebhookNameChange,
    onWebhookScopesChange,
    onWebhookTeamIdsChange,
    onWebhookUrlChange,
  } = props
  const title = labels.headings[`create-${kind}`]
  const description = labels.helpText[`create-${kind}`]
  const isBusy = busyOperation === `${kind}:create`

  return (
    <div
      aria-describedby="developer-editor-description"
      aria-labelledby="developer-editor-title"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/45 p-4"
      onKeyDown={(event) => {
        trapDialogFocus(event)
        if (event.key === 'Escape' && !isBusy) {
          onRequestClose()
        }
      }}
      role="dialog"
    >
      <form
        className="workbench-panel my-auto w-full max-w-[620px] overflow-hidden shadow-xl"
        onSubmit={
          kind === 'api-key'
            ? onSubmitApiKey
            : kind === 'oauth-app'
              ? onSubmitOAuthApp
              : onSubmitWebhook
        }
      >
        <div className="border-b border-[var(--workbench-border)] px-5 py-4">
          <h3
            className="text-lg font-semibold text-[var(--workbench-text)]"
            id="developer-editor-title"
          >
            {title}
          </h3>
          <p
            className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id="developer-editor-description"
          >
            {description}
          </p>
        </div>

        <div className="grid max-h-[65vh] gap-4 overflow-y-auto p-5">
          {kind === 'api-key' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.apiKeyName}
                value={apiKeyName}
                onChange={onApiKeyNameChange}
              />
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {labels.fields.expiry}
                <input
                  className="workbench-input min-h-10 px-3 normal-case tracking-normal"
                  type="date"
                  value={apiKeyExpiry}
                  onChange={(event) => onApiKeyExpiryChange(event.target.value)}
                />
              </label>
              <OptionChecklist
                errorMessage={
                  apiKeyScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={apiKeyScopes}
                onChange={onApiKeyScopesChange}
              />
            </>
          ) : null}

          {kind === 'oauth-app' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.oauthName}
                value={oauthName}
                onChange={onOAuthNameChange}
              />
              <OptionChecklist
                disabled
                legend={labels.fields.grantTypes}
                options={labels.grantTypeOptions}
                value={oauthGrantTypes}
                onChange={onOAuthGrantTypesChange}
              />
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {labels.fields.expiry}
                <input
                  className="workbench-input min-h-10 px-3 normal-case tracking-normal"
                  type="date"
                  value={oauthExpiry}
                  onChange={(event) => onOAuthExpiryChange(event.target.value)}
                />
              </label>
              <OptionChecklist
                errorMessage={
                  oauthScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={oauthScopes}
                onChange={onOAuthScopesChange}
              />
            </>
          ) : null}

          {kind === 'webhook' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.webhookName}
                value={webhookName}
                onChange={onWebhookNameChange}
              />
              <TextField
                label={labels.fields.url}
                placeholder={labels.placeholders.webhookUrl}
                type="url"
                value={webhookUrl}
                onChange={onWebhookUrlChange}
              />
              <OptionChecklist
                legend={labels.fields.webhookTeams}
                options={webhookTeamOptions}
                value={webhookTeamIds}
                onChange={onWebhookTeamIdsChange}
              />
              <OptionChecklist
                errorMessage={
                  webhookEvents.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.events}
                options={labels.webhookEventOptions}
                value={webhookEvents}
                onChange={onWebhookEventsChange}
              />
              <OptionChecklist
                errorMessage={
                  webhookScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={webhookScopes}
                onChange={onWebhookScopesChange}
              />
              <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium leading-5 text-blue-900">
                {labels.helpText.webhookDelivery}
              </p>
            </>
          ) : null}
        </div>

        <div className="flex justify-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <button
            className="workbench-button-secondary min-h-10 px-4"
            disabled={isBusy}
            onClick={onRequestClose}
            type="button"
          >
            {labels.actions.cancel}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
            disabled={
              isBusy ||
              (kind === 'api-key' && apiKeyScopes.length === 0) ||
              (kind === 'oauth-app' && oauthScopes.length === 0) ||
              (kind === 'webhook' &&
                (webhookTeamIds.length === 0 ||
                  webhookEvents.length === 0 ||
                  webhookScopes.length === 0))
            }
            type="submit"
          >
            {labels.actions[`submit-${kind}`]}
          </button>
        </div>
      </form>
    </div>
  )
}
