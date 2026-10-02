/**
 * Credential-free stdio MCP configuration matching the repository connection guide.
 * Paths, origin, and member identifiers are placeholders for the user's client.
 */
export const codingAgentConfigurationTemplate = JSON.stringify({
  mcpServers: {
    'mukuroji-tasks': {
      command: '/absolute/path/to/bun',
      args: ['/absolute/path/to/mukuroji/server/src/handlers/coding-agent-mcp.ts'],
      env: {
        MUKUROJI_MCP_URL: 'https://your-mukuroji.example.com',
        MUKUROJI_MCP_TEAM_ID: 'your-team-id',
        MUKUROJI_MCP_ASSIGNEE_ID: 'your-workspace-member-id',
        MUKUROJI_MCP_AGENT_NAME: 'coding-agent',
      },
    },
  },
}, null, 2)
