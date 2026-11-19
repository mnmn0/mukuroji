import { describe, expect, test } from 'bun:test'
import {
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
    [['check', '--region', 'nowhere', '--table', 'mukuroji-agent-runs', '--page-size', '1', '--max-pages', '1', '--max-items', '1']],
    [['check', '--region', 'ap-northeast-1', '--table', 'mukuroji-agent-runs', '--page-size', '10', '--max-pages', '1', '--max-items', '11']],
    [['delete']],
  ])('rejects invalid arguments %#', (arguments_) => {
    expect(() => parseAgentRunsIntegrityCliArguments(arguments_)).toThrow()
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
    const { dependencies, out } = createDependencies([{
      Items: [{ directoryTeamId: 'workspace-1#team#core', recordKey: 'unexpected' }],
    }])
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
