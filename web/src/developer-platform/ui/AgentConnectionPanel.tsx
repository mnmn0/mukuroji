import type { ApiKeySummary, PersonalAgentCredentialOverview } from '@mukuroji/contracts'
import { useId, useRef, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  AGENT_CONNECTION_CLIENTS,
  buildAgentConnectionSnippet,
  buildChecksumCommand,
  buildTokenEnvironmentCommand,
  MCP_RELEASE_URL,
  type AgentConnectionClient,
  type AgentConnectionShell,
} from '../model/agentConnection'

/** Client display names; product names are not translated. */
const clientLabels: Record<AgentConnectionClient, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kiro: 'Kiro',
}

/** Shells offered on the page. */
const shells: readonly AgentConnectionShell[] = ['posix', 'powershell']

/** Team option offered for the connection. */
export type AgentConnectionTeamOption = {
  /** Team ID used as `MUKUROJI_MCP_TEAM_ID`. */
  id: string
  /** Team display name. */
  name: string
}

/** Choices that shape the generated client configuration. */
export type AgentConnectionChoices = {
  /** Selected client. */
  client: AgentConnectionClient
  /** Selected Team ID; empty when the member has no Team. */
  teamId: string
  /** Shell family of the member's machine. */
  shell: AgentConnectionShell
  /** Absolute path of `mcp.mjs` typed by the member. */
  mcpPath: string
}

/** Values of the token issuance form. */
export type PersonalKeyForm = {
  /** Key name. */
  name: string
  /** Expiry date in `YYYY-MM-DD` form. */
  expiryDate: string
}

/** One-time token kept only until the member closes it. */
export type IssuedPersonalToken = {
  /** Name of the issued key. */
  name: string
  /** One-time secret. */
  secret: string
}

/** Data and actions rendered by the pure agent connection view. */
export type AgentConnectionPanelProps = {
  /** Resolves interface copy in the active locale. */
  t: (key: MessageKey) => string
  /** Member connection details; omitted while loading or after an error. */
  overview?: PersonalAgentCredentialOverview
  /** Whether the overview is loading for the first time. */
  isLoading: boolean
  /** Whether the overview failed to load. */
  hasLoadError: boolean
  /** Origin written into `MUKUROJI_MCP_URL`. */
  origin: string
  /** Teams the member can choose. */
  teams: readonly AgentConnectionTeamOption[]
  /** Current configuration choices. */
  choices: AgentConnectionChoices
  /** Current issuance form values. */
  form: PersonalKeyForm
  /** Earliest and latest selectable expiry dates. */
  expiryBounds: { min: string; max: string }
  /** Key of the mutation in progress, if any. */
  busyOperation?: string
  /** Whether the last mutation failed. */
  hasOperationError: boolean
  /** Token issued or reissued in this visit, shown once. */
  issuedToken?: IssuedPersonalToken
  /** Formats an ISO timestamp for display. */
  formatDateTime: (value: string) => string
  /** Updates the configuration choices. */
  onChoicesChange: (choices: AgentConnectionChoices) => void
  /** Updates the issuance form. */
  onFormChange: (form: PersonalKeyForm) => void
  /** Issues a token with the form values. */
  onIssue: () => void
  /** Reissues a token with the form expiry. */
  onRotate: (apiKey: ApiKeySummary) => void
  /** Revokes a token. */
  onRevoke: (apiKey: ApiKeySummary) => void
  /** Forgets the one-time token after the member saved it. */
  onDismissIssuedToken: () => void
  /** Reloads the overview. */
  onRetry: () => void
}

/**
 * Renders the steps a member follows to connect their own coding agent, without API access.
 *
 * @param props - Connection data, form state, and actions.
 * @returns The agent connection page content.
 */
export function AgentConnectionPanel(props: AgentConnectionPanelProps) {
  const { t, overview, isLoading, hasLoadError } = props

  if (isLoading) {
    return (
      <p aria-busy="true" className="workbench-panel p-5 text-sm text-[var(--workbench-muted)]" role="status">
        {t('agents.connect.loading')}
      </p>
    )
  }
  if (!overview) {
    return <LoadErrorAlert onRetry={props.onRetry} t={t} />
  }

  return (
    <div className="grid min-w-0 gap-5" data-testid="agent-connection-panel">
      {hasLoadError ? <LoadErrorAlert onRetry={props.onRetry} t={t} /> : null}
      {props.hasOperationError ? (
        <p className="rounded-lg border border-tone-f2c94c bg-tone-fff8e1 p-3 text-sm text-fg-amber-800" role="alert">
          {t('agents.connect.operationError')}
        </p>
      ) : null}
      <DownloadStep {...props} />
      <TokenStep {...props} overview={overview} />
      <ConfigurationStep {...props} overview={overview} />
      <Step number={4} title={t('agents.connect.verifyTitle')}>
        <p className="text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.connect.verifyDescription')}</p>
      </Step>
    </div>
  )
}

/**
 * Renders the load error with a retry button.
 *
 * It replaces the page only before the first load succeeds; after that it sits above the
 * loaded steps, so a one-time token from a finished action stays visible.
 *
 * @param props - Translator and retry action.
 * @returns The load error alert.
 */
function LoadErrorAlert(props: Pick<AgentConnectionPanelProps, 't' | 'onRetry'>) {
  return (
    <div className="workbench-panel flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
      <p className="text-sm text-[var(--workbench-text)]">{props.t('agents.connect.loadError')}</p>
      <button className="workbench-button-secondary min-h-10 px-4" onClick={props.onRetry} type="button">
        {props.t('agents.connect.retry')}
      </button>
    </div>
  )
}

/**
 * Renders one numbered step.
 *
 * @param props - Step number, heading, and content.
 * @returns The step section.
 */
function Step(props: { number: number; title: string; children: React.ReactNode }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="workbench-panel min-w-0 p-5">
      <h2 className="flex items-center gap-3 text-base font-semibold text-[var(--workbench-text)]" id={titleId}>
        <span
          aria-hidden="true"
          className="grid h-7 w-7 flex-none place-items-center rounded-full bg-[var(--workbench-primary)] text-xs font-semibold text-white"
        >
          {props.number}
        </span>
        {props.title}
      </h2>
      <div className="mt-4 grid min-w-0 gap-4">{props.children}</div>
    </section>
  )
}

/**
 * Renders the release download and checksum step.
 *
 * @param props - Page props.
 * @returns The download step.
 */
function DownloadStep({ t, choices, onChoicesChange }: AgentConnectionPanelProps) {
  return (
    <Step number={1} title={t('agents.connect.downloadTitle')}>
      <p className="text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.connect.downloadDescription')}</p>
      <a
        className="w-fit text-sm font-medium text-[var(--workbench-primary)] underline underline-offset-2"
        href={MCP_RELEASE_URL}
        rel="noreferrer"
        target="_blank"
      >
        {t('agents.connect.downloadLink')}
      </a>
      <ShellPicker choices={choices} onChoicesChange={onChoicesChange} t={t} />
      <CopyBlock label={t('agents.connect.checksumLabel')} t={t} value={buildChecksumCommand(choices.shell)} />
      {choices.shell === 'posix' ? (
        <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t('agents.connect.checksumPosixNote')}</p>
      ) : null}
    </Step>
  )
}

/**
 * Renders token issuance, the one-time token, and the member's tokens.
 *
 * @param props - Page props with a loaded overview.
 * @returns The token step.
 */
function TokenStep(props: AgentConnectionPanelProps & { overview: PersonalAgentCredentialOverview }) {
  const { t, overview, form, busyOperation, issuedToken, choices } = props
  const issuing = busyOperation === 'issue'
  const canSubmit = overview.canIssue && form.name.trim() !== '' && form.expiryDate !== '' && !busyOperation
  return (
    <Step number={2} title={t('agents.connect.tokenTitle')}>
      <p className="text-sm leading-6 text-[var(--workbench-muted)]">
        {t('agents.connect.tokenDescription').replace('{days}', String(overview.maxLifetimeDays))}
      </p>
      {overview.issuanceBlockedReason ? (
        <p className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 text-sm text-[var(--workbench-text)]" role="status">
          {overview.issuanceBlockedReason === 'guest'
            ? t('agents.connect.blockedGuest')
            : overview.issuanceBlockedReason === 'missing-permission'
              ? t('agents.connect.blockedPermission')
              : t('agents.connect.blockedPolicy')}
        </p>
      ) : null}
      {overview.canIssue ? (
        <form
          className="grid gap-3 min-[760px]:grid-cols-[minmax(0,1fr)_200px_auto] min-[760px]:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) props.onIssue()
          }}
        >
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('agents.connect.nameLabel')}
            <input
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              maxLength={120}
              onChange={(event) => props.onFormChange({ ...form, name: event.target.value })}
              placeholder={t('agents.connect.namePlaceholder')}
              required
              value={form.name}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('agents.connect.expiryLabel')}
            <input
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              max={props.expiryBounds.max}
              min={props.expiryBounds.min}
              onChange={(event) => props.onFormChange({ ...form, expiryDate: event.target.value })}
              required
              type="date"
              value={form.expiryDate}
            />
          </label>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
            disabled={!canSubmit}
            type="submit"
          >
            {issuing ? t('agents.connect.issuing') : t('agents.connect.issue')}
          </button>
        </form>
      ) : null}
      {issuedToken ? (
        <div
          className="grid gap-3 rounded-lg border border-tone-f2c94c bg-tone-fff8e1 p-4"
          data-testid="issued-agent-token"
        >
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('agents.connect.issuedTitle').replace('{name}', issuedToken.name)}
          </h3>
          <p className="text-sm leading-6 text-fg-amber-800">{t('agents.connect.issuedWarning')}</p>
          <CopyBlock label={t('agents.connect.issuedTokenLabel')} t={t} value={issuedToken.secret} />
          <CopyBlock
            label={t('agents.connect.issuedEnvLabel')}
            t={t}
            value={buildTokenEnvironmentCommand(choices.shell, issuedToken.secret)}
          />
          <p className="text-xs leading-5 text-[var(--workbench-muted)]">
            {choices.shell === 'powershell'
              ? t('agents.connect.envPowerShellNote')
              : t('agents.connect.envPosixNote')}
          </p>
          <div>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={props.onDismissIssuedToken} type="button">
              {t('agents.connect.issuedDismiss')}
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.connect.keysTitle')}</h3>
        {overview.apiKeys.length ? (
          <>
            <ul className="grid gap-2">
              {overview.apiKeys.map((apiKey) => (
                <PersonalKeyRow {...props} apiKey={apiKey} key={apiKey.id} />
              ))}
            </ul>
            {overview.canIssue ? (
              <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t('agents.connect.rotateHint')}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-[var(--workbench-muted)]">{t('agents.connect.keysEmpty')}</p>
        )}
      </div>
    </Step>
  )
}

/**
 * Renders one of the member's tokens with its actions.
 *
 * @param props - Page props, the overview, and the token.
 * @returns The token row.
 */
function PersonalKeyRow(
  props: AgentConnectionPanelProps & { overview: PersonalAgentCredentialOverview; apiKey: ApiKeySummary },
) {
  const { t, apiKey, overview, busyOperation, formatDateTime } = props
  const nameId = useId()
  const statusKey: MessageKey = apiKey.status === 'active'
    ? 'agents.connect.status.active'
    : apiKey.status === 'expired'
      ? 'agents.connect.status.expired'
      : 'agents.connect.status.revoked'
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] p-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          <span className="break-all" id={nameId}>{apiKey.name}</span>
          <span className={apiKey.status === 'active' ? 'workbench-badge-success' : 'workbench-badge'}>{t(statusKey)}</span>
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--workbench-muted)]">
          <span className="font-mono">{apiKey.prefix}</span>
          {apiKey.expiresAt ? (
            <span>{t('agents.connect.keyExpires').replace('{date}', formatDateTime(apiKey.expiresAt))}</span>
          ) : null}
          <span>
            {apiKey.lastUsedAt
              ? t('agents.connect.keyLastUsed').replace('{date}', formatDateTime(apiKey.lastUsedAt))
              : t('agents.connect.keyNeverUsed')}
          </span>
        </p>
      </div>
      {apiKey.status === 'active' ? (
        <div className="flex flex-wrap gap-2">
          {overview.canIssue ? (
            <button
              aria-describedby={nameId}
              className="workbench-button-secondary min-h-9 px-3 text-xs disabled:opacity-50"
              disabled={Boolean(busyOperation) || !props.form.expiryDate}
              onClick={() => props.onRotate(apiKey)}
              type="button"
            >
              {t('agents.connect.rotate')}
            </button>
          ) : null}
          <button
            aria-describedby={nameId}
            className="workbench-button-secondary min-h-9 px-3 text-xs disabled:opacity-50"
            disabled={Boolean(busyOperation)}
            onClick={() => props.onRevoke(apiKey)}
            type="button"
          >
            {t('agents.connect.revoke')}
          </button>
        </div>
      ) : null}
    </li>
  )
}

/**
 * Renders the client, Team, and path choices with the generated configuration.
 *
 * @param props - Page props with a loaded overview.
 * @returns The configuration step.
 */
function ConfigurationStep(props: AgentConnectionPanelProps & { overview: PersonalAgentCredentialOverview }) {
  const { t, overview, choices, onChoicesChange, teams, origin } = props
  const pathInputId = useId()
  const snippet = buildAgentConnectionSnippet({
    origin,
    teamId: choices.teamId || 'your-team-id',
    memberId: overview.memberId,
    client: choices.client,
    mcpPath: choices.mcpPath,
    shell: choices.shell,
  })
  const runsCommand = choices.client === 'claude-code'
  return (
    <Step number={3} title={t('agents.connect.configTitle')}>
      <p className="text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.connect.configDescription')}</p>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1.5 text-xs font-semibold text-[var(--workbench-muted)]">{t('agents.connect.clientLabel')}</legend>
        {AGENT_CONNECTION_CLIENTS.map((client) => (
          <label
            className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${
              choices.client === client
                ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary-text)]'
                : 'border-[var(--workbench-border)] text-[var(--workbench-text)]'
            }`}
            key={client}
          >
            <input
              checked={choices.client === client}
              className="accent-[var(--workbench-primary)]"
              name="agent-connection-client"
              onChange={() => onChoicesChange({ ...choices, client })}
              type="radio"
            />
            {clientLabels[client]}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 min-[760px]:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('agents.connect.teamLabel')}
          {teams.length ? (
            <select
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              onChange={(event) => onChoicesChange({ ...choices, teamId: event.target.value })}
              value={choices.teamId}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-normal text-[var(--workbench-text)]">{t('agents.connect.noTeams')}</span>
          )}
        </label>
        <ShellPicker choices={choices} onChoicesChange={onChoicesChange} t={t} />
        <div className="grid gap-1.5 min-[760px]:col-span-2">
          <label className="text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={pathInputId}>
            {t('agents.connect.pathLabel')}
          </label>
          <input
            className="workbench-input min-h-10 px-3 font-mono text-sm"
            id={pathInputId}
            onChange={(event) => onChoicesChange({ ...choices, mcpPath: event.target.value })}
            placeholder={choices.shell === 'powershell' ? 'C:\\Users\\you\\mukuroji\\mcp.mjs' : '/Users/you/mukuroji/mcp.mjs'}
            spellCheck={false}
            value={choices.mcpPath}
          />
        </div>
      </div>
      <dl className="grid gap-3 text-xs min-[760px]:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-semibold text-[var(--workbench-muted)]">{t('agents.connect.originLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-[var(--workbench-text)]">{origin}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[var(--workbench-muted)]">{t('agents.connect.memberLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-[var(--workbench-text)]">{overview.memberId}</dd>
        </div>
      </dl>
      <CopyBlock
        label={(runsCommand ? t('agents.connect.snippetRun') : t('agents.connect.snippetLabel'))
          .replace('{location}', snippet.location)}
        t={t}
        tall
        value={snippet.content}
      />
      <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t(`agents.connect.clientNote.${choices.client}`)}</p>
      {choices.shell === 'powershell' ? (
        <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t('agents.connect.windowsNote')}</p>
      ) : null}
    </Step>
  )
}

/**
 * Renders the OS choice shared by the checksum, token, and configuration snippets.
 *
 * @param props - Translator and configuration choices.
 * @returns The OS selector.
 */
function ShellPicker(props: Pick<AgentConnectionPanelProps, 't' | 'choices' | 'onChoicesChange'>) {
  const { t, choices, onChoicesChange } = props
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
      {t('agents.connect.shellLabel')}
      <select
        className="workbench-input min-h-10 px-3 text-sm font-normal"
        onChange={(event) => {
          const shell = shells.find((candidate) => candidate === event.target.value)
          if (shell) onChoicesChange({ ...choices, shell })
        }}
        value={choices.shell}
      >
        {shells.map((shell) => (
          <option key={shell} value={shell}>{t(`agents.connect.shell.${shell}`)}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * Renders read-only text with a copy button that falls back to selecting the text.
 *
 * @param props - Label, text, and whether the block is tall.
 * @returns The copyable block.
 */
function CopyBlock(props: { label: string; value: string; t: (key: MessageKey) => string; tall?: boolean }) {
  const { label, value, t, tall } = props
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const textRef = useRef<HTMLTextAreaElement>(null)
  const textId = useId()
  const lines = value.split('\n').length

  /** Copies the text, or selects it when the clipboard is unavailable. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
      textRef.current?.focus()
      textRef.current?.select()
    }
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={textId}>{label}</label>
        <button className="workbench-button-secondary min-h-9 px-3 text-xs" onClick={() => void copy()} type="button">
          {t('agents.connect.copy')}
        </button>
      </div>
      <textarea
        className="block w-full min-w-0 resize-y rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 font-mono text-xs leading-5 text-[var(--workbench-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workbench-focus)]"
        id={textId}
        readOnly
        ref={textRef}
        rows={tall ? Math.min(Math.max(lines, 6), 20) : Math.min(Math.max(lines, 1), 4)}
        spellCheck={false}
        value={value}
        wrap="off"
      />
      {state === 'idle' ? null : (
        <p className={`text-xs ${state === 'failed' ? 'text-fg-amber-800' : 'text-[var(--workbench-primary-text)]'}`} role="status">
          {state === 'failed' ? t('agents.connect.copyFailed') : t('agents.connect.copied')}
        </p>
      )}
    </div>
  )
}
