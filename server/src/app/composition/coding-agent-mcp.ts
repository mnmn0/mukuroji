import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { AGENT_RUN_RUNTIMES, type AgentRunRuntime } from '@mukuroji/contracts'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { createCodingAgentMcpServer } from '../../modules/coding-agent-mcp/adapter-in/mcp/server'
import { readServerCompatibility } from '../../modules/coding-agent-mcp/adapter-out/http/server-compatibility'
import { createAgentWorkItemApi } from '../../modules/coding-agent-mcp/adapter-out/http/work-item-api'
import { createWorkspaceApi } from '../../modules/coding-agent-mcp/adapter-out/http/workspace-api'
import { createWorkspaceMcpServer } from '../../modules/coding-agent-mcp/adapter-in/mcp/workspace-server'
import { assessServerCompatibility, type ServerCompatibility } from '../../modules/coding-agent-mcp/application/compatibility'
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
  MUKUROJI_MCP_TEAM_ID: z.string().trim().min(1).max(256),
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
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_URL, MUKUROJI_MCP_TOKEN, MUKUROJI_MCP_TEAM_ID, and MUKUROJI_MCP_ASSIGNEE_ID. Check optional PROJECT_ID, AGENT_NAME, READ_ONLY, RUNTIME, and INSTANCE_ID values.')
  }
  const config = parsed.data
  const api = createAgentWorkItemApi({ origin: config.MUKUROJI_MCP_URL, token: config.MUKUROJI_MCP_TOKEN, teamId: config.MUKUROJI_MCP_TEAM_ID })
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
