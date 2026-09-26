import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { composeCodingAgentMcp } from '../app/composition/coding-agent-mcp'
import { AgentTaskError } from '../modules/coding-agent-mcp/application/work-item-api'

try {
  const handle = serveStdio(composeCodingAgentMcp(), {
    onerror: () => { console.error('MCP protocol error; check the client connection.') },
  })
  /** Closes stdio cleanly when the host terminates its child process. */
  const shutdown = async () => { await handle.close(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch (error) {
  console.error(error instanceof AgentTaskError ? error.message : 'MCP startup failed; check connection configuration.')
  process.exitCode = 1
}
