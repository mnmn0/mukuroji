import type {
  AiAssistanceExternalProvider,
  AiAssistanceProviderCredentialStatus,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import {
  type AiProviderCredentialFeedback,
  type AiProviderCredentialMutations,
  useAiProviderCredentialMutations,
} from '../mutations/useAiProviderCredentialMutations'
import { useAiProviderCredentials } from '../queries/useAiProviderCredentials'

/** Props for the manager-only external provider key section. */
export type AiProviderCredentialsSectionProps = {
  /** Bearer token for an authorized Workspace administrator. */
  accessToken: string
  /** Stable Workspace scope for the cache key. */
  workspaceId?: string
  /** Stable member scope for the cache key; never the bearer token. */
  cacheScope?: string
  /** Wraps authenticated requests so the owning route can handle session expiry. */
  guardRequest?: <Result>(request: Promise<Result>) => Promise<Result>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Lets a Workspace administrator register, replace, or remove Claude API and OpenAI keys.
 *
 * Keys are write-only: the input is cleared after each request and the server
 * returns only whether a key exists and its last four characters.
 *
 * @param props - Authentication, cache scope, and translator.
 * @returns The provider key section, or null until the scope is known.
 */
export function AiProviderCredentialsSection({
  accessToken,
  cacheScope,
  guardRequest,
  t,
  workspaceId,
}: AiProviderCredentialsSectionProps) {
  const query = useAiProviderCredentials(accessToken, guardRequest, cacheScope, workspaceId)
  const mutations = useAiProviderCredentialMutations({
    accessToken,
    mutateCredentials: query.mutate,
    ...(guardRequest === undefined ? {} : { guardRequest }),
  })

  if (!query.enabled) return null
  return (
    <section
      className="workbench-panel mt-4 px-5 py-6 sm:px-7"
      data-testid="ai-provider-credentials-section"
    >
      <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
        {t('ai.settings.providers.title')}
      </h3>
      <p className="mt-1 max-w-2xl text-app-caption leading-5 text-[var(--workbench-muted)]">
        {t('ai.settings.providers.description')}
      </p>
      {query.error ? (
        <p className="mt-4 text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
          {t('ai.settings.loadError')}
        </p>
      ) : !query.data ? (
        <p className="mt-4 text-app-caption text-[var(--workbench-muted)]" role="status">
          {t('ai.settings.providers.loading')}
        </p>
      ) : (
        <ul className="mt-4 grid gap-4">
          {query.data.providers.filter((status) => status.deploymentEnabled).map((status) => (
            <ProviderRow
              key={status.provider}
              mutations={mutations}
              status={status}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Props for one provider row. */
type ProviderRowProps = {
  /** Revision-fenced save and remove actions. */
  mutations: AiProviderCredentialMutations
  /** Current key-free status. */
  status: AiAssistanceProviderCredentialStatus
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Provider display names; product names, not translated. */
const PROVIDER_LABELS: Readonly<Record<AiAssistanceExternalProvider, string>> = {
  anthropic: 'Claude API (Anthropic)',
  openai: 'OpenAI',
}

/**
 * Renders one provider's status, a password-style key input, and save/remove actions.
 *
 * @param props - Status, key actions, and translator.
 * @returns One list item.
 */
function ProviderRow({ mutations, status, t }: ProviderRowProps) {
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<AiProviderCredentialFeedback>()
  const inputId = `ai-provider-key-${status.provider}`

  /** Runs one key action, clears the typed key, and shows its outcome. */
  async function run(action: () => Promise<AiProviderCredentialFeedback>) {
    setPending(true)
    setFeedback(undefined)
    try {
      setFeedback(await action())
    } finally {
      setApiKey('')
      setPending(false)
    }
  }

  return (
    <li className="grid gap-2 border-t border-[var(--workbench-border)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-app-caption font-semibold text-[var(--workbench-text)]" htmlFor={inputId}>
          {PROVIDER_LABELS[status.provider]}
        </label>
        <span className={status.configured ? 'workbench-badge-primary' : 'workbench-badge'}>
          {status.configured && status.keyHint
            ? t('ai.settings.providers.configured').replace('{hint}', status.keyHint)
            : t('ai.settings.providers.notConfigured')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          autoComplete="off"
          className="workbench-input min-h-[44px] min-w-0 flex-1 basis-64 px-3 font-normal text-[var(--workbench-text)]"
          disabled={pending}
          id={inputId}
          onChange={(event) => setApiKey(event.target.value.trim())}
          placeholder={status.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          spellCheck={false}
          type="password"
          value={apiKey}
        />
        <button
          className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending || apiKey.length === 0}
          onClick={() => void run(() => mutations.saveKey(status.provider, apiKey, status.revision))}
          type="button"
        >
          {status.configured ? t('ai.settings.providers.replace') : t('ai.settings.providers.save')}
        </button>
        {status.configured ? (
          <button
            className="workbench-button-secondary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={() => void run(() => mutations.removeKey(status.provider, status.revision))}
            type="button"
          >
            {t('ai.settings.providers.remove')}
          </button>
        ) : null}
      </div>
      {feedback ? (
        <p
          className={`text-app-caption font-semibold ${feedback === 'saved' || feedback === 'removed' ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-danger)]'}`}
          role={feedback === 'saved' || feedback === 'removed' ? 'status' : 'alert'}
        >
          {t(`ai.settings.providers.feedback.${feedback}`)}
        </p>
      ) : null}
    </li>
  )
}
