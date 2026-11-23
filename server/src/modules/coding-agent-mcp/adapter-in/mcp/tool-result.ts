import type { CallToolResult } from '@modelcontextprotocol/server'
import { AgentTaskError } from '../../application/work-item-api'

/**
 * Converts a use-case result or safe failure into MCP text and structured content.
 * @param run - Use case to run.
 * @returns The tool result; a failure carries only trusted codes and messages.
 */
export async function result(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await run()
    const output = { data }
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
  } catch (error) {
    const safe = error instanceof AgentTaskError ? error : new AgentTaskError('internal', 'The operation could not be completed. No success is implied; verify task state before retrying.')
    const output = { error: { code: safe.code, message: safe.message, retryable: safe.retryable, retryAfterSeconds: safe.retryAfterSeconds } }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
  }
}
