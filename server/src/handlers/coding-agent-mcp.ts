import { CODING_AGENT_MCP_API_REVISION } from '@mukuroji/contracts'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { composeCodingAgentHeartbeat, composeCodingAgentMcp } from '../app/composition/coding-agent-mcp'
import { CODING_AGENT_MCP_VERSION } from '../modules/coding-agent-mcp/application/compatibility'
import { AgentTaskError } from '../modules/coding-agent-mcp/application/work-item-api'

if (process.argv.includes('--version')) {
  console.log(CODING_AGENT_MCP_VERSION)
} else if (process.argv.includes('--heartbeat')) {
  // An agent hook runs this between tool calls; it reports on stderr and always exits 0, so a
  // failed heartbeat never blocks the agent.
  try {
    const result = await composeCodingAgentHeartbeat()()
    console.error(result.throttled
      ? 'mukuroji heartbeat: skipped, renewed within the last minute'
      : `mukuroji heartbeat: ${result.renewed} renewed, ${result.recent} recent, ${result.failed} failed`)
  } catch (error) {
    console.error(error instanceof AgentTaskError ? error.message : 'Heartbeat failed; check connection configuration.')
  }
} else {
  try {
    const createServer = composeCodingAgentMcp()
    // stdout carries the MCP protocol, so startup information goes to stderr.
    console.error(`mukuroji MCP ${CODING_AGENT_MCP_VERSION} (MCP API revision ${CODING_AGENT_MCP_API_REVISION})`)
    const handle = serveStdio(createServer, {
      onerror: () => { console.error('MCP protocol error; check the client connection.') },
    })
    void createServer.serverCompatibility().then((compatibility) => {
      if (compatibility.status !== 'compatible') console.error(`Warning: ${compatibility.message}`)
    })
    /** Closes stdio cleanly when the host terminates its child process. */
    const shutdown = async () => { await handle.close(); process.exit(0) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    console.error(error instanceof AgentTaskError ? error.message : 'MCP startup failed; check connection configuration.')
    process.exitCode = 1
  }
}
