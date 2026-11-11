import { PERSONAL_API_KEY_MAX_LIFETIME_DAYS } from '@mukuroji/contracts'

/** Coding agent clients the connection page writes a configuration for. */
export const AGENT_CONNECTION_CLIENTS = ['claude-code', 'codex', 'kiro'] as const

/** Coding agent client selected on the connection page. */
export type AgentConnectionClient = (typeof AGENT_CONNECTION_CLIENTS)[number]

/** Shell family whose quoting, paths, and commands the snippets use. */
export type AgentConnectionShell = 'posix' | 'powershell'

/** Values that the connection page fills into a client configuration. */
export type AgentConnectionSettings = {
  /** Mukuroji origin without `/api`, used as `MUKUROJI_MCP_URL`. */
  origin: string
  /** Team the connection works in. */
  teamId: string
  /** Current member's Workspace member ID, used as `MUKUROJI_MCP_ASSIGNEE_ID`. */
  memberId: string
  /** Client the configuration is written for; also the recorded runtime. */
  client: AgentConnectionClient
  /** Absolute path of the downloaded `mcp.mjs`; empty uses a placeholder. */
  mcpPath: string
  /** Shell family of the member's machine. */
  shell: AgentConnectionShell
}

/** One copyable configuration snippet. */
export type AgentConnectionSnippet = {
  /** Where the snippet is run or saved. */
  location: string
  /** Snippet text. */
  content: string
}

/** MCP server name registered in every client. */
const MCP_SERVER_NAME = 'mukuroji-tasks'

/**
 * Resolves the origin that the MCP server calls, from the Web app's API base URL.
 *
 * @param apiBaseUrl - Configured API base URL, absolute or relative to the page.
 * @param pageOrigin - Origin of the current page.
 * @returns Origin without path, as `MUKUROJI_MCP_URL` requires.
 */
export function resolveAgentConnectionOrigin(apiBaseUrl: string, pageOrigin: string) {
  return new URL(apiBaseUrl, pageOrigin).origin
}

/**
 * Returns the path shown in snippets for the downloaded `mcp.mjs`.
 *
 * @param mcpPath - Path typed by the member.
 * @param shell - Shell family of the member's machine.
 * @returns The trimmed path, or an absolute placeholder for the shell.
 */
export function resolveMcpScriptPath(mcpPath: string, shell: AgentConnectionShell) {
  const trimmed = mcpPath.trim()
  if (trimmed) return trimmed
  return shell === 'powershell'
    ? 'C:\\Users\\you\\mukuroji\\mcp.mjs'
    : '/Users/you/mukuroji/mcp.mjs'
}

/**
 * Builds the non-secret environment the MCP server needs.
 *
 * @param settings - Connection values.
 * @returns Environment entries in display order.
 */
function buildEnvironment(settings: AgentConnectionSettings): Array<[string, string]> {
  return [
    ['MUKUROJI_MCP_URL', settings.origin],
    ['MUKUROJI_MCP_TEAM_ID', settings.teamId],
    ['MUKUROJI_MCP_ASSIGNEE_ID', settings.memberId],
    ['MUKUROJI_MCP_AGENT_NAME', settings.client],
    ['MUKUROJI_MCP_RUNTIME', settings.client],
  ]
}

/**
 * Quotes one shell word only when it needs quoting.
 *
 * @param value - Word to quote.
 * @param shell - Shell family.
 * @returns A word that the shell passes through unchanged.
 */
function quoteShellWord(value: string, shell: AgentConnectionShell) {
  if (/^[\w/.:=@%+,-]+$/u.test(value)) return value
  return shell === 'powershell'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Builds the configuration snippet for the selected client.
 *
 * The token is never written into the snippet; each client reads it from the
 * `MUKUROJI_MCP_TOKEN` environment variable at start-up.
 *
 * @param settings - Connection values.
 * @returns Where to run or save the snippet, and its text.
 */
export function buildAgentConnectionSnippet(settings: AgentConnectionSettings): AgentConnectionSnippet {
  const environment = buildEnvironment(settings)
  const scriptPath = resolveMcpScriptPath(settings.mcpPath, settings.shell)
  const windows = settings.shell === 'powershell'
  if (settings.client === 'claude-code') {
    const continuation = windows ? ' `\n  ' : ' \\\n  '
    const words = [
      'claude mcp add --scope user --transport stdio',
      ...environment.map(([name, value]) => `--env ${quoteShellWord(`${name}=${value}`, settings.shell)}`),
      // Single quotes keep the shell from expanding the variable; Claude Code expands it at start-up.
      "--env 'MUKUROJI_MCP_TOKEN=${MUKUROJI_MCP_TOKEN}'",
      `${MCP_SERVER_NAME} -- node ${quoteShellWord(scriptPath, settings.shell)}`,
    ]
    return {
      location: windows ? 'PowerShell' : 'Terminal',
      content: words.join(continuation),
    }
  }
  if (settings.client === 'codex') {
    return {
      location: windows ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml',
      content: [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        'command = "node"',
        `args = [${JSON.stringify(scriptPath)}]`,
        'env_vars = ["MUKUROJI_MCP_TOKEN"]',
        '',
        `[mcp_servers.${MCP_SERVER_NAME}.env]`,
        ...environment.map(([name, value]) => `${name} = ${JSON.stringify(value)}`),
      ].join('\n'),
    }
  }
  return {
    location: windows ? '%USERPROFILE%\\.kiro\\settings\\mcp.json' : '~/.kiro/settings/mcp.json',
    content: JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'node',
          args: [scriptPath],
          env: {
            ...Object.fromEntries(environment),
            MUKUROJI_MCP_TOKEN: '${MUKUROJI_MCP_TOKEN}',
          },
        },
      },
    }, null, 2),
  }
}

/** Page that lists the published `mcp.mjs` release files. */
export const MCP_RELEASE_URL = 'https://github.com/mnmn0/mukuroji/releases/latest'

/**
 * Builds the command that stores the token in the member's user environment.
 *
 * On PowerShell it also sets the token in the current session, because a user-scope update
 * reaches only processes started afterwards, not the shell that ran it.
 *
 * @param shell - Shell family.
 * @param token - One-time secret; omitted writes a placeholder.
 * @returns A command to run once, then restart the client.
 */
export function buildTokenEnvironmentCommand(shell: AgentConnectionShell, token?: string) {
  const value = token ?? '<token>'
  if (shell === 'powershell') {
    const quoted = `'${value.replaceAll("'", "''")}'`
    return [
      `[Environment]::SetEnvironmentVariable('MUKUROJI_MCP_TOKEN', ${quoted}, 'User')`,
      `$env:MUKUROJI_MCP_TOKEN = ${quoted}`,
    ].join('\n')
  }
  return `export MUKUROJI_MCP_TOKEN=${quoteShellWord(value, shell)}`
}

/**
 * Builds the command that verifies the downloaded `mcp.mjs` against `mcp.mjs.sha256`.
 *
 * @param shell - Shell family.
 * @returns A command run in the folder that holds the three release files.
 */
export function buildChecksumCommand(shell: AgentConnectionShell) {
  if (shell === 'powershell') {
    return [
      "$expected = ((Get-Content .\\mcp.mjs.sha256 | Select-String '\\smcp\\.mjs$').Line -split '\\s+')[0]",
      '$actual = (Get-FileHash .\\mcp.mjs -Algorithm SHA256).Hash.ToLower()',
      "if ($expected -eq $actual) { 'OK' } else { 'MISMATCH' }",
    ].join('\n')
  }
  return 'shasum -a 256 -c mcp.mjs.sha256'
}

/**
 * Formats a local date for a `date` input.
 *
 * @param date - Date to format.
 * @returns `YYYY-MM-DD` in local time.
 */
function toDateInputValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Returns the default and latest expiry dates a member can choose for a personal key.
 *
 * A chosen date expires at the end of that local day, so the latest date is the last one
 * whose local end of day is still within the server's fixed lifetime from `now`. Deriving
 * it from that absolute deadline keeps daylight-saving changes from pushing it past the limit.
 *
 * @param now - Current time.
 * @param maxLifetimeDays - Server limit in days.
 * @returns Date-input values for the default (30 days or the latest), the minimum, and the maximum.
 */
export function resolvePersonalKeyExpiryBounds(
  now: Date,
  maxLifetimeDays = PERSONAL_API_KEY_MAX_LIFETIME_DAYS,
) {
  const addDays = (days: number) => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    return toDateInputValue(date)
  }
  const deadline = now.getTime() + maxLifetimeDays * 24 * 60 * 60 * 1_000
  const latest = new Date(deadline)
  latest.setHours(23, 59, 59, 999)
  if (latest.getTime() > deadline) latest.setDate(latest.getDate() - 1)
  const min = addDays(1)
  const max = toDateInputValue(latest) < min ? min : toDateInputValue(latest)
  const thirtyDays = addDays(30)
  return {
    min,
    defaultValue: thirtyDays < max ? thirtyDays : max,
    max,
  }
}
