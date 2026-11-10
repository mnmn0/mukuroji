import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { AGENT_RUN_RUNTIMES, type AgentRunRuntime } from '@mukuroji/contracts'
import { z } from 'zod'
import { createCodingAgentMcpServer } from '../../modules/coding-agent-mcp/adapter-in/mcp/server'
import { createAgentWorkItemApi } from '../../modules/coding-agent-mcp/adapter-out/http/work-item-api'
import { AgentTaskError } from '../../modules/coding-agent-mcp/application/work-item-api'

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

/**
 * Composes the MCP server without initializing AWS clients or the HTTP application.
 * @param environment - Process environment or isolated test configuration.
 * @returns A server factory compatible with modern and legacy MCP stdio clients.
 */
export function composeCodingAgentMcp(environment: Record<string, string | undefined> = process.env) {
  const parsed = configSchema.safeParse(environment)
  if (!parsed.success) {
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_URL, MUKUROJI_MCP_TOKEN, MUKUROJI_MCP_TEAM_ID, and MUKUROJI_MCP_ASSIGNEE_ID. Check optional PROJECT_ID, AGENT_NAME, READ_ONLY, RUNTIME, and INSTANCE_ID values.')
  }
  const config = parsed.data
  const api = createAgentWorkItemApi({ origin: config.MUKUROJI_MCP_URL, token: config.MUKUROJI_MCP_TOKEN, teamId: config.MUKUROJI_MCP_TEAM_ID })
  return () => createCodingAgentMcpServer(api, {
    assigneeUserId: config.MUKUROJI_MCP_ASSIGNEE_ID,
    assignedProjectId: config.MUKUROJI_MCP_PROJECT_ID,
    agentName: config.MUKUROJI_MCP_AGENT_NAME,
    runtime: config.MUKUROJI_MCP_RUNTIME,
    instanceId: config.MUKUROJI_MCP_INSTANCE_ID ??
      deriveAgentInstanceId(config.MUKUROJI_MCP_RUNTIME, config.MUKUROJI_MCP_ASSIGNEE_ID),
  }, config.MUKUROJI_MCP_READ_ONLY === 'true')
}
