import { describe, expect, test } from 'bun:test'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import {
  createWorkItemLookup,
  parseAgentRunsIntegrityCliArguments,
  runAgentRunsIntegrityCli,
  type AgentRunsIntegrityCliDependencies,
} from './verify-agent-runs-integrity'

const baseArguments = [
  'check',
  '--region', 'ap-northeast-1',
  '--table', 'mukuroji-agent-runs',
  '--page-size', '100',
  '--max-pages', '10',
  '--max-items', '1000',
]

/**
 * Builds CLI dependencies that capture output and serve fixed pages.
 *
 * @param pages - Pages returned in order.
 * @returns Dependencies and captured lines.
 */
function createDependencies(pages: Array<{
  /** Page items. */
  Items?: Record<string, unknown>[]
  /** Continuation key. */
  LastEvaluatedKey?: Record<string, unknown>
} | Error>) {
  const out: string[] = []
  const error: string[] = []
  const dependencies: AgentRunsIntegrityCliDependencies = {
    createClient: () => ({
      send: async () => {
        const next = pages.shift()
        if (next === undefined) return { Items: [] }
        if (next instanceof Error) throw next
        return next
      },
    }),
    now: () => new Date('2026-11-20T00:00:00.000Z'),
    writeOut: (line) => out.push(line),
    writeError: (line) => error.push(line),
  }
  return { dependencies, out, error }
}

describe('parseAgentRunsIntegrityCliArguments', () => {
  test('parses a check with explicit Teams', () => {
    expect(parseAgentRunsIntegrityCliArguments([
      ...baseArguments,
      '--team', 'workspace-1/core',
      '--team', 'workspace-1/web',
      '--profile', 'reviewed',
      '--correlation-id', 'corr-1',
    ])).toEqual({
      command: 'check',
      region: 'ap-northeast-1',
      tableName: 'mukuroji-agent-runs',
      profile: 'reviewed',
      teams: [{ directoryId: 'workspace-1', teamId: 'core' }, { directoryId: 'workspace-1', teamId: 'web' }],
      bounds: { pageSize: 100, maxPages: 10, maxItems: 1000 },
      correlationId: 'corr-1',
    })
  })

  test.each([
    [['check', '--region', 'ap-northeast-1']],
    [[...baseArguments, '--unknown', 'x']],
    [[...baseArguments, '--team', 'no-separator']],
    [[...baseArguments, '--team', 'a/b/c']],
    [[...baseArguments, '--profile', 'a', '--profile', 'b']],
    [[...baseArguments, '--work-items-table', 'x']],
    [[...baseArguments, '--work-items-table', 'mukuroji-work-items', '--work-items-table', 'mukuroji-work-items']],
    [['check', '--region', 'nowhere', '--table', 'mukuroji-agent-runs', '--page-size', '1', '--max-pages', '1', '--max-items', '1']],
    [['check', '--region', 'ap-northeast-1', '--table', 'mukuroji-agent-runs', '--page-size', '10', '--max-pages', '1', '--max-items', '11']],
    [['delete']],
  ])('rejects invalid arguments %#', (arguments_) => {
    expect(() => parseAgentRunsIntegrityCliArguments(arguments_)).toThrow()
  })
})

describe('parseAgentRunsIntegrityCliArguments --work-items-table', () => {
  test('parses the Work Items table', () => {
    expect(parseAgentRunsIntegrityCliArguments([...baseArguments, '--work-items-table', 'mukuroji-work-items'])).toMatchObject({
      tableName: 'mukuroji-agent-runs',
      workItemsTableName: 'mukuroji-work-items',
    })
  })
})

describe('createWorkItemLookup', () => {
  const workItem = { directoryId: 'workspace-1', teamId: 'core', workItemId: 'task-1' }

  /**
   * Reads the Work Item through a lookup whose client returns one fixed Get response.
   *
   * @param item - Item the Get returns, or undefined for none.
   * @returns The state and the sent commands.
   */
  async function read(item: Record<string, unknown> | undefined) {
    const commands: unknown[] = []
    const lookup = createWorkItemLookup({
      send: async (command) => {
        commands.push(command)
        return item === undefined ? {} : { Item: item }
      },
    }, 'mukuroji-work-items')
    return { state: await lookup.read(workItem), commands }
  }

  test('reads the key, creation time, and archive time with a strongly consistent Get', async () => {
    const { state, commands } = await read({ issueId: 'task-1', createdAt: '2026-10-01T00:00:00.000Z' })
    expect(state).toEqual({ kind: 'present', createdAt: '2026-10-01T00:00:00.000Z', archived: false })
    const command = commands[0]
    if (!(command instanceof GetCommand)) throw new Error('Expected a Get.')
    expect(command.input).toEqual({
      TableName: 'mukuroji-work-items',
      Key: { directoryTeamId: 'workspace-1#team#core', issueId: 'task-1' },
      ConsistentRead: true,
      ProjectionExpression: '#issueId, #createdAt, #archivedAt',
      ExpressionAttributeNames: { '#issueId': 'issueId', '#createdAt': 'createdAt', '#archivedAt': 'archivedAt' },
    })
  })

  test('classifies missing, archived, and malformed rows', async () => {
    expect((await read(undefined)).state).toEqual({ kind: 'missing' })
    expect((await read({ issueId: 'task-1', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: '2026-10-02T00:00:00.000Z' })).state)
      .toEqual({ kind: 'present', createdAt: '2026-10-01T00:00:00.000Z', archived: true })
    expect((await read({ issueId: 'task-2', createdAt: '2026-10-01T00:00:00.000Z' })).state).toEqual({ kind: 'malformed' })
    expect((await read({ issueId: 'task-1' })).state).toEqual({ kind: 'malformed' })
    expect((await read({ issueId: 'task-1', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: null })).state).toEqual({ kind: 'malformed' })
  })
})

describe('runAgentRunsIntegrityCli', () => {
  test('prints the evidence and exits 0 when the table passes', async () => {
    const { dependencies, out, error } = createDependencies([{ Items: [] }])
    expect(await runAgentRunsIntegrityCli([...baseArguments, '--team', 'workspace-1/core', '--correlation-id', 'corr-1'], dependencies)).toBe(0)
    expect(error).toEqual([])
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ status: 'pass', correlationId: 'corr-1', counts: { partitions: 1 } })
  })

  test('exits 1 when an invariant is broken', async () => {
    const page = { Items: [{ directoryTeamId: 'workspace-1#team#core', recordKey: 'unexpected' }] }
    // The partition is read again to confirm the violation.
    const { dependencies, out } = createDependencies([page, page])
    expect(await runAgentRunsIntegrityCli([...baseArguments, '--team', 'workspace-1/core'], dependencies)).toBe(1)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ status: 'fail', failures: [{ code: 'AGENT_RUN_ROW_UNRECOGNIZED', count: 1 }] })
  })

  test('exits 2 with a stable error that omits the raw AWS message', async () => {
    const failure = new Error('Requested resource not found: Table: secret-table-name')
    failure.name = 'ResourceNotFoundException'
    const { dependencies, out, error } = createDependencies([failure])
    expect(await runAgentRunsIntegrityCli([...baseArguments, '--correlation-id', 'corr-2'], dependencies)).toBe(2)
    expect(out).toEqual([])
    expect(JSON.parse(error[0] ?? '')).toEqual({ status: 'error', code: 'READ_FAILED', correlationId: 'corr-2', errorName: 'ResourceNotFoundException' })
  })

  test('exits 2 on a usage error without echoing the values', async () => {
    const { dependencies, error } = createDependencies([])
    expect(await runAgentRunsIntegrityCli(['check', '--secret-flag', 'secret-value'], dependencies)).toBe(2)
    expect(error[0]).not.toContain('secret')
  })

  test('prints help', async () => {
    const { dependencies, out } = createDependencies([])
    expect(await runAgentRunsIntegrityCli(['help'], dependencies)).toBe(0)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ status: 'help' })
  })
})
