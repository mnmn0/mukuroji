import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { AGENT_RUN_RUNTIMES, type AgentRunRuntime } from '@mukuroji/contracts'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { createCodingAgentMcpServer } from '../../modules/coding-agent-mcp/adapter-in/mcp/server'
import { readServerCompatibility } from '../../modules/coding-agent-mcp/adapter-out/http/server-compatibility'
import { createAgentWorkItemApi } from '../../modules/coding-agent-mcp/adapter-out/http/work-item-api'
import { createWorkspaceApi } from '../../modules/coding-agent-mcp/adapter-out/http/workspace-api'
import { createWorkspaceMcpServer } from '../../modules/coding-agent-mcp/adapter-in/mcp/workspace-server'
import { assessServerCompatibility, type ServerCompatibility } from '../../modules/coding-agent-mcp/application/compatibility'
import { maximumAgentTeams } from '../../modules/coding-agent-mcp/application/multi-team-agent-tasks'
import { heartbeatOwnRuns, type HookHeartbeatResult } from '../../modules/coding-agent-mcp/application/hook-heartbeat'
import { AgentTaskError } from '../../modules/coding-agent-mcp/application/work-item-api'

const profileSchema = z.enum(['tasks', 'workspace']).default('tasks')

const workspaceConfigSchema = z.object({
  MUKUROJI_MCP_URL: z.url(),
  MUKUROJI_MCP_TOKEN: z.string().min(1),
  MUKUROJI_MCP_READ_ONLY: z.enum(['true', 'false']).default('false'),
})

const configSchema = z.object({
  MUKUROJI_MCP_URL: z.url(),
  MUKUROJI_MCP_TOKEN: z.string().min(1),
  MUKUROJI_MCP_TEAM_ID: z.string().trim().min(1).max(256).optional(),
  MUKUROJI_MCP_TEAM_IDS: z.string().trim().min(1).max(4096).optional(),
  MUKUROJI_MCP_ASSIGNEE_ID: z.string().trim().min(1).max(256),
  MUKUROJI_MCP_PROJECT_ID: z.string().trim().min(1).max(256).optional(),
  MUKUROJI_MCP_AGENT_NAME: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N} ._-]+$/u).default('coding-agent'),
  MUKUROJI_MCP_READ_ONLY: z.enum(['true', 'false']).default('false'),
  MUKUROJI_MCP_RUNTIME: z.enum(AGENT_RUN_RUNTIMES).default('other'),
  MUKUROJI_MCP_INSTANCE_ID: z.string().min(1).max(256)
    .refine((value) => value === value.trim() && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
    .optional(),
})

/**
 * Reads the OS account name without failing on hosts that do not expose one.
 *
 * @returns The account name, or an empty string.
 */
function readAccountName(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/**
 * Derives a stable instance ID for this machine, account, runtime, and assignee.
 *
 * Only the digest leaves the process, so the host and account names are never sent.
 *
 * @param runtime - Client runtime.
 * @param assigneeUserId - Configured assignee.
 * @returns Hexadecimal SHA-256 digest.
 */
export function deriveAgentInstanceId(runtime: AgentRunRuntime, assigneeUserId: string): string {
  return createHash('sha256')
    .update(['mukuroji-mcp-instance', hostname(), readAccountName(), runtime, assigneeUserId].join('\u0000'))
    .digest('hex')
}

/** Server factory for stdio clients, with the shared server compatibility check. */
export type CodingAgentMcpFactory = {
  /**
   * Creates one MCP server for a client connection.
   *
   * @returns An unconnected MCP server.
   */
  (): McpServer
  /**
   * Compares this MCP build with the configured server. A known result is reused for the
   * process; an unknown one is read again on the next call.
   *
   * @returns The compatibility status and message.
   */
  serverCompatibility: () => Promise<ServerCompatibility>
}

/**
 * Composes the MCP server without initializing AWS clients or the HTTP application.
 * @param environment - Process environment or isolated test configuration.
 * @returns A server factory compatible with modern and legacy MCP stdio clients.
 */
export function composeCodingAgentMcp(environment: Record<string, string | undefined> = process.env): CodingAgentMcpFactory {
  const profile = profileSchema.safeParse(environment.MUKUROJI_MCP_PROFILE)
  if (!profile.success) {
    throw new AgentTaskError('configuration', 'MUKUROJI_MCP_PROFILE must be tasks or workspace.')
  }
  if (profile.data === 'workspace') return composeWorkspaceMcp(environment)
  const parsed = configSchema.safeParse(environment)
  if (!parsed.success) {
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_URL, MUKUROJI_MCP_TOKEN, MUKUROJI_MCP_TEAM_ID (or MUKUROJI_MCP_TEAM_IDS), and MUKUROJI_MCP_ASSIGNEE_ID. Check optional PROJECT_ID, AGENT_NAME, READ_ONLY, RUNTIME, and INSTANCE_ID values.')
  }
  const config = parsed.data
  const teamIds = readTeamIds(config.MUKUROJI_MCP_TEAM_ID, config.MUKUROJI_MCP_TEAM_IDS)
  // A Project belongs to one Team, so a Project restriction only makes sense for one Team.
  if (teamIds.length > 1 && config.MUKUROJI_MCP_PROJECT_ID !== undefined) {
    throw new AgentTaskError('configuration', 'MUKUROJI_MCP_PROJECT_ID needs exactly one Team. Remove it or configure a single Team.')
  }
  const apiFor = (teamId: string) => createAgentWorkItemApi({ origin: config.MUKUROJI_MCP_URL, token: config.MUKUROJI_MCP_TOKEN, teamId })
  // One Team keeps the single-Team server unchanged; several Teams route each task to its Team.
  const api = teamIds.length === 1 ? apiFor(teamIds[0]) : teamIds.map((teamId) => ({ teamId, api: apiFor(teamId) }))
  const serverCompatibility = createServerCompatibilityReader(config.MUKUROJI_MCP_URL)
  const createServer = () => createCodingAgentMcpServer(api, {
    assigneeUserId: config.MUKUROJI_MCP_ASSIGNEE_ID,
    assignedProjectId: config.MUKUROJI_MCP_PROJECT_ID,
    agentName: config.MUKUROJI_MCP_AGENT_NAME,
    runtime: config.MUKUROJI_MCP_RUNTIME,
    instanceId: config.MUKUROJI_MCP_INSTANCE_ID ??
      deriveAgentInstanceId(config.MUKUROJI_MCP_RUNTIME, config.MUKUROJI_MCP_ASSIGNEE_ID),
  }, config.MUKUROJI_MCP_READ_ONLY === 'true', serverCompatibility)
  return Object.assign(createServer, { serverCompatibility })
}

/**
 * Composes the heartbeat an agent hook runs between tool calls (`mcp.mjs --heartbeat`). It reads
 * the same configuration as the tasks profile and derives the same instance ID, so it renews only
 * the runs this machine, account, runtime, and assignee started.
 *
 * @param environment - Process environment or isolated test configuration.
 * @returns A call that renews this instance's active runs.
 * @throws AgentTaskError configuration when the tasks profile is not fully configured.
 */
export function composeCodingAgentHeartbeat(
  environment: Record<string, string | undefined> = process.env,
): () => Promise<HookHeartbeatResult & { throttled: boolean }> {
  const profile = profileSchema.safeParse(environment.MUKUROJI_MCP_PROFILE)
  if (!profile.success || profile.data !== 'tasks') {
    throw new AgentTaskError('configuration', 'The heartbeat needs the tasks profile configuration.')
  }
  const parsed = configSchema.safeParse(environment)
  if (!parsed.success) {
    throw new AgentTaskError('configuration', 'Set the same MUKUROJI_MCP_* values as the MCP server for the heartbeat.')
  }
  const config = parsed.data
  const teams = readTeamIds(config.MUKUROJI_MCP_TEAM_ID, config.MUKUROJI_MCP_TEAM_IDS).map((teamId) => ({
    teamId,
    api: createAgentWorkItemApi({ origin: config.MUKUROJI_MCP_URL, token: config.MUKUROJI_MCP_TOKEN, teamId }),
  }))
  const owner = {
    assigneeUserId: config.MUKUROJI_MCP_ASSIGNEE_ID,
    instanceId: config.MUKUROJI_MCP_INSTANCE_ID ??
      deriveAgentInstanceId(config.MUKUROJI_MCP_RUNTIME, config.MUKUROJI_MCP_ASSIGNEE_ID),
  }
  // Hooks fire on every tool call, so one machine-local stamp per instance keeps the API calls
  // to one heartbeat a minute; leases are several minutes long. The stamp lives in the account's
  // own cache directory, not a shared temporary directory another account could plant files in.
  const stampDirectory = join(environment.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'mukuroji-mcp')
  const stampPath = join(stampDirectory, `heartbeat-${createHash('sha256')
    .update([config.MUKUROJI_MCP_URL, owner.assigneeUserId, owner.instanceId].join('\u0000')).digest('hex').slice(0, 32)}`)
  return async () => {
    if (await readStampAgeMs(stampPath) < HOOK_HEARTBEAT_INTERVAL_MS) return { renewed: 0, recent: 0, failed: 0, throttled: true }
    const result = await heartbeatOwnRuns(teams, owner)
    if (result.failed === 0) {
      await mkdir(stampDirectory, { recursive: true, mode: 0o700 })
        .then(() => writeFile(stampPath, '', { mode: 0o600 }))
        .catch(() => undefined)
    }
    return { ...result, throttled: false }
  }
}

/** Shortest interval between two hook heartbeats of one instance. */
const HOOK_HEARTBEAT_INTERVAL_MS = 60_000

/**
 * Reads how long ago the last hook heartbeat of an instance succeeded.
 *
 * @param path - Stamp file of the instance.
 * @returns Age in milliseconds, or infinity when no heartbeat was recorded.
 */
async function readStampAgeMs(path: string): Promise<number> {
  try {
    return Date.now() - (await stat(path)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Reads the configured Teams: `MUKUROJI_MCP_TEAM_ID` first, then the comma-separated
 * `MUKUROJI_MCP_TEAM_IDS` in order, without duplicates.
 *
 * @param teamId - Single Team ID, as older configurations set it.
 * @param teamIds - Comma-separated Team IDs.
 * @returns At least one and at most `maximumAgentTeams` Team IDs.
 * @throws AgentTaskError configuration when no Team, an empty entry, or too many Teams are set.
 */
export function readTeamIds(teamId: string | undefined, teamIds: string | undefined): string[] {
  const listed = teamIds === undefined ? [] : teamIds.split(',').map((entry) => entry.trim())
  if (listed.some((entry) => entry.length === 0 || entry.length > 256)) {
    throw new AgentTaskError('configuration', 'MUKUROJI_MCP_TEAM_IDS must be Team IDs separated by commas.')
  }
  const unique = [...new Set([...(teamId === undefined ? [] : [teamId]), ...listed])]
  if (unique.length === 0) {
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_TEAM_ID or MUKUROJI_MCP_TEAM_IDS.')
  }
  if (unique.length > maximumAgentTeams) {
    throw new AgentTaskError('configuration', `MUKUROJI_MCP_TEAM_IDS may list at most ${maximumAgentTeams} Teams.`)
  }
  return unique
}

/**
 * Creates a reader of the server's served MCP API revisions that reuses a known result for the
 * process and reads again after an unknown one.
 *
 * @param origin - Mukuroji origin.
 * @returns The compatibility reader.
 */
function createServerCompatibilityReader(origin: string): () => Promise<ServerCompatibility> {
  let compatibility: Promise<ServerCompatibility> | undefined
  return () => {
    const pending = compatibility ?? readServerCompatibility(origin).then((server) => {
      const assessed = assessServerCompatibility(server)
      // A transient failure must not hide the server's range for the rest of the process.
      if (assessed.status === 'unknown') compatibility = undefined
      return assessed
    })
    compatibility = pending
    return pending
  }
}

/**
 * Composes the Workspace profile: Linear-style tools that need only the origin and the token,
 * because each call names its Team. `MUKUROJI_MCP_READ_ONLY=true` leaves out the write tools.
 *
 * @param environment - Process environment or isolated test configuration.
 * @returns A server factory for stdio clients.
 */
function composeWorkspaceMcp(environment: Record<string, string | undefined>): CodingAgentMcpFactory {
  const parsed = workspaceConfigSchema.safeParse(environment)
  if (!parsed.success) {
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_URL and MUKUROJI_MCP_TOKEN for the workspace profile. MUKUROJI_MCP_READ_ONLY must be true or false.')
  }
  const api = createWorkspaceApi({ origin: parsed.data.MUKUROJI_MCP_URL, token: parsed.data.MUKUROJI_MCP_TOKEN })
  const serverCompatibility = createServerCompatibilityReader(parsed.data.MUKUROJI_MCP_URL)
  const readOnly = parsed.data.MUKUROJI_MCP_READ_ONLY === 'true'
  return Object.assign(() => createWorkspaceMcpServer(api, readOnly), { serverCompatibility })
}
