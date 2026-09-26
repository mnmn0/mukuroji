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
})

/**
 * Composes the MCP server without initializing AWS clients or the HTTP application.
 * @param environment - Process environment or isolated test configuration.
 * @returns A server factory compatible with modern and legacy MCP stdio clients.
 */
export function composeCodingAgentMcp(environment: Record<string, string | undefined> = process.env) {
  const parsed = configSchema.safeParse(environment)
  if (!parsed.success) {
    throw new AgentTaskError('configuration', 'Set MUKUROJI_MCP_URL, MUKUROJI_MCP_TOKEN, MUKUROJI_MCP_TEAM_ID, and MUKUROJI_MCP_ASSIGNEE_ID. Check optional PROJECT_ID, AGENT_NAME, and READ_ONLY values.')
  }
  const config = parsed.data
  const api = createAgentWorkItemApi({ origin: config.MUKUROJI_MCP_URL, token: config.MUKUROJI_MCP_TOKEN, teamId: config.MUKUROJI_MCP_TEAM_ID })
  return () => createCodingAgentMcpServer(api, {
    assigneeUserId: config.MUKUROJI_MCP_ASSIGNEE_ID,
    assignedProjectId: config.MUKUROJI_MCP_PROJECT_ID,
    agentName: config.MUKUROJI_MCP_AGENT_NAME,
  }, config.MUKUROJI_MCP_READ_ONLY === 'true')
}
