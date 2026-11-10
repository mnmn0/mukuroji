import type { ApiKeySummary } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createPersonalApiKey,
  revokePersonalApiKey,
  rotatePersonalApiKey,
} from '../api/apiKeys'
import { shouldRetainDeveloperPlatformMutationContext } from '../api/errors'
import {
  resolveAgentConnectionOrigin,
  resolvePersonalKeyExpiryBounds,
  type AgentConnectionShell,
} from '../model/agentConnection'
import { toLocalEndOfDayIso } from '../model/credentials'
import { usePersonalAgentConnection } from '../queries/usePersonalAgentConnection'
import {
  AgentConnectionPanel,
  type AgentConnectionChoices,
  type AgentConnectionTeamOption,
  type IssuedPersonalToken,
  type PersonalKeyForm,
} from './AgentConnectionPanel'

/** Inputs for the agent connection page container. */
export type AgentConnectionPanelContainerProps = {
  /** Access token of the signed-in member. */
  accessToken: string
  /** Locale used for date formatting. */
  locale: Locale
  /** Resolves interface copy in the active locale. */
  t: (key: MessageKey) => string
  /** Teams the member belongs to. */
  teams: readonly AgentConnectionTeamOption[]
}

/**
 * Guesses the member's shell family from the browser platform.
 *
 * @returns PowerShell on Windows, otherwise a POSIX shell.
 */
function detectShell(): AgentConnectionShell {
  return /win/iu.test(globalThis.navigator?.platform ?? '') ? 'powershell' : 'posix'
}

/**
 * Connects the agent connection view to the member's personal key API.
 *
 * @param props - Session, locale, translator, and Teams.
 * @returns The agent connection page content.
 */
export function AgentConnectionPanelContainer({
  accessToken,
  locale,
  t,
  teams,
}: AgentConnectionPanelContainerProps) {
  const { data, error, isLoading, mutate } = usePersonalAgentConnection(accessToken)
  const requestRunner = useMemo(() => createMutationRequestRunner(), [])
  const expiryBounds = useMemo(() => resolvePersonalKeyExpiryBounds(new Date()), [])
  const origin = useMemo(
    () => resolveAgentConnectionOrigin(resolveApiBaseUrl('workspaceWithoutProjects'), window.location.origin),
    [],
  )
  const [choices, setChoices] = useState<AgentConnectionChoices>(() => ({
    client: 'claude-code',
    teamId: teams[0]?.id ?? '',
    shell: detectShell(),
    mcpPath: '',
  }))
  const [form, setForm] = useState<PersonalKeyForm>({ name: '', expiryDate: expiryBounds.defaultValue })
  const [busyOperation, setBusyOperation] = useState<string>()
  const [hasOperationError, setHasOperationError] = useState(false)
  const [issuedToken, setIssuedToken] = useState<IssuedPersonalToken>()
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )
  const selectedTeamId = teams.some((team) => team.id === choices.teamId)
    ? choices.teamId
    : teams[0]?.id ?? ''

  /**
   * Runs one mutation, retrying with the same idempotency key after a transient failure,
   * then reloads the member's tokens.
   *
   * @param operationKey - Logical mutation key.
   * @param fingerprint - Payload fingerprint for the logical mutation.
   * @param request - API call.
   * @returns The API result, or undefined when it failed.
   */
  async function runMutation<TResult>(
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof requestRunner.run<TResult>>[2],
  ) {
    setBusyOperation(operationKey)
    setHasOperationError(false)
    try {
      return await requestRunner.run(
        operationKey,
        fingerprint,
        request,
        shouldRetainDeveloperPlatformMutationContext,
      )
    } catch {
      setHasOperationError(true)
      return undefined
    } finally {
      setBusyOperation(undefined)
      try {
        await mutate()
      } catch {
        // The load error is shown by the query state.
      }
    }
  }

  /** Issues a token with the form values and keeps its secret until dismissed. */
  async function issue() {
    const input = { name: form.name.trim(), expiresAt: toLocalEndOfDayIso(form.expiryDate) }
    const result = await runMutation('issue', JSON.stringify(input), (context) =>
      createPersonalApiKey(accessToken, input, context))
    if (!result) return
    setIssuedToken({ name: result.apiKey.name, secret: result.secret })
    setForm({ name: '', expiryDate: expiryBounds.defaultValue })
  }

  /** Reissues a token with the form expiry. */
  async function rotate(apiKey: ApiKeySummary) {
    const input = { expiresAt: toLocalEndOfDayIso(form.expiryDate) }
    const result = await runMutation(`rotate:${apiKey.id}`, JSON.stringify(input), (context) =>
      rotatePersonalApiKey(accessToken, apiKey.id, input, context))
    if (result) setIssuedToken({ name: result.apiKey.name, secret: result.secret })
  }

  /** Revokes a token. */
  async function revoke(apiKey: ApiKeySummary) {
    await runMutation(`revoke:${apiKey.id}`, apiKey.id, (context) =>
      revokePersonalApiKey(accessToken, apiKey.id, context))
  }

  return (
    <AgentConnectionPanel
      busyOperation={busyOperation}
      choices={{ ...choices, teamId: selectedTeamId }}
      expiryBounds={expiryBounds}
      form={form}
      formatDateTime={(value) => dateTimeFormatter.format(new Date(value))}
      hasLoadError={Boolean(error)}
      hasOperationError={hasOperationError}
      isLoading={isLoading}
      issuedToken={issuedToken}
      onChoicesChange={setChoices}
      onDismissIssuedToken={() => setIssuedToken(undefined)}
      onFormChange={setForm}
      onIssue={() => void issue()}
      onRetry={() => void mutate()}
      onRevoke={(apiKey) => void revoke(apiKey)}
      onRotate={(apiKey) => void rotate(apiKey)}
      origin={origin}
      overview={data}
      t={t}
      teams={teams}
    />
  )
}
