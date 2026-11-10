import type { ApiKeySummary } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  resolveAgentConnectionOrigin,
  resolvePersonalKeyExpiryBounds,
  type AgentConnectionShell,
} from '../model/agentConnection'
import { toLocalEndOfDayIso } from '../model/credentials'
import { usePersonalAgentCredentials } from '../mutations/usePersonalAgentCredentials'
import {
  AgentConnectionPanel,
  type AgentConnectionChoices,
  type AgentConnectionTeamOption,
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
  const credentials = usePersonalAgentCredentials(accessToken)
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
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )
  const selectedTeamId = teams.some((team) => team.id === choices.teamId)
    ? choices.teamId
    : teams[0]?.id ?? ''

  /** Issues a token with the form values and clears the form once it is issued. */
  function issue() {
    void credentials.issue(
      { name: form.name.trim(), expiresAt: toLocalEndOfDayIso(form.expiryDate) },
      () => setForm({ name: '', expiryDate: expiryBounds.defaultValue }),
    )
  }

  /** Reissues a token with the form expiry. */
  function rotate(apiKey: ApiKeySummary) {
    void credentials.rotate(apiKey, toLocalEndOfDayIso(form.expiryDate))
  }

  return (
    <AgentConnectionPanel
      busyOperation={credentials.busyOperation}
      choices={{ ...choices, teamId: selectedTeamId }}
      expiryBounds={expiryBounds}
      form={form}
      formatDateTime={(value) => dateTimeFormatter.format(new Date(value))}
      hasLoadError={credentials.hasLoadError}
      hasOperationError={credentials.hasOperationError}
      isLoading={credentials.isLoading}
      issuedToken={credentials.issuedToken}
      onChoicesChange={setChoices}
      onDismissIssuedToken={credentials.dismissIssuedToken}
      onFormChange={setForm}
      onIssue={issue}
      onRetry={() => void credentials.reload()}
      onRevoke={(apiKey) => void credentials.revoke(apiKey)}
      onRotate={rotate}
      origin={origin}
      overview={credentials.overview}
      t={t}
      teams={teams}
    />
  )
}
