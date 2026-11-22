import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Repository root, where `bun run mcp:start` is defined. */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Protocol revision the smoke client offers; the server answers with the revision it speaks. */
const clientProtocolVersion = '2025-06-18'

/** Longest wait for one JSON-RPC response, in milliseconds. */
const responseTimeoutMs = 15_000

/** Settles one pending JSON-RPC request. */
type PendingRequest = {
  /** Resolves with the response's `result`. */
  resolve: (result: unknown) => void
  /** Rejects with the response's `error` or a transport failure. */
  reject: (error: Error) => void
  /** Timer that rejects the request when no response arrives. */
  timer: ReturnType<typeof setTimeout>
}

/** Result of one `tools/call`, reduced to what the smoke suite asserts. */
export type McpToolResult = {
  /** Whether the tool reported an error. */
  isError: boolean
  /** Structured content returned by the tool. */
  structuredContent: unknown
}

/**
 * Minimal MCP client that drives `bun run mcp:start` over stdio, the way a coding agent does.
 *
 * Speaks newline-delimited JSON-RPC directly so the smoke suite needs no MCP SDK dependency.
 */
export class McpStdioClient {
  /** The `bun run mcp:start` process. */
  private readonly child: ChildProcessWithoutNullStreams
  /** Requests waiting for a response, keyed by JSON-RPC id. */
  private readonly pending = new Map<number, PendingRequest>()
  /** Next JSON-RPC request id. */
  private nextId = 1
  /** Unparsed stdout bytes after the last newline. */
  private buffer = ''
  /** Recent stderr output, kept to explain startup failures. */
  private stderr = ''

  /**
   * Starts the MCP server process.
   *
   * @param environment - `MUKUROJI_MCP_*` variables for the server.
   */
  private constructor(environment: Record<string, string>) {
    this.child = spawn('bun', ['run', '--silent', 'mcp:start'], {
      cwd: repositoryRoot,
      // Only PATH and HOME from the runner, so the API credential under test is the only one the server sees.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => { this.readStdout(chunk) })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000) })
    this.child.on('exit', (code) => {
      this.rejectAll(new Error(`MCP server exited with code ${String(code)}. stderr: ${this.stderr}`))
    })
  }

  /**
   * Starts `bun run mcp:start` and completes the MCP initialize handshake.
   *
   * @param environment - `MUKUROJI_MCP_*` variables for the server.
   * @returns A client ready for tool calls.
   */
  static async connect(environment: Record<string, string>): Promise<McpStdioClient> {
    const client = new McpStdioClient(environment)
    try {
      await client.request('initialize', {
        protocolVersion: clientProtocolVersion,
        capabilities: {},
        clientInfo: { name: 'mukuroji-real-server-smoke', version: '1.0.0' },
      })
      client.notify('notifications/initialized')
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /**
   * Calls one MCP tool.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns Whether the tool failed and its structured content.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (!result || typeof result !== 'object') throw new Error(`tools/call ${name} returned no result object.`)
    return {
      isError: 'isError' in result && result.isError === true,
      structuredContent: 'structuredContent' in result ? result.structuredContent : undefined,
    }
  }

  /**
   * Stops the server process and fails any request still waiting.
   */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => { this.child.once('exit', () => { resolve() }) })
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    await exited
  }

  /**
   * Sends a JSON-RPC request and waits for its response.
   *
   * @param method - JSON-RPC method.
   * @param params - Method parameters.
   * @returns The response's `result`.
   */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out. stderr: ${this.stderr}`))
      }, responseTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /**
   * Sends a JSON-RPC notification.
   *
   * @param method - Notification method.
   */
  private notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  /**
   * Splits stdout into JSON-RPC messages and settles the matching requests.
   *
   * @param chunk - Newly received stdout text.
   */
  private readStdout(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.settle(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /**
   * Settles the request a response line answers. Server-initiated messages are ignored.
   *
   * @param line - One JSON-RPC message.
   */
  private settle(line: string): void {
    const message: unknown = JSON.parse(line)
    if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if ('error' in message && message.error !== undefined) {
      pending.reject(new Error(`MCP error: ${JSON.stringify(message.error)}`))
    } else {
      pending.resolve('result' in message ? message.result : undefined)
    }
  }

  /**
   * Fails every waiting request.
   *
   * @param error - Reason given to each request.
   */
  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
