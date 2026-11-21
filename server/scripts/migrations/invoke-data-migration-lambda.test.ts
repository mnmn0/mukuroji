import { describe, expect, test } from 'bun:test'
import {
  computeDataMigrationRequestBinding,
  createStsDataMigrationOperatorVerifier,
  DATA_MIGRATION_OPERATOR_PROOF_HEADER,
} from '../../src/modules/data-migration'
import {
  createStsOperatorProof,
  parseDataMigrationLambdaCliArguments,
  runDataMigrationLambdaCli,
  type DataMigrationLambdaCliDependencies,
} from './invoke-data-migration-lambda'

/**
 * Builds CLI dependencies with a recording fake Lambda.
 *
 * @param response - Payload the fake Lambda returns.
 * @returns The dependencies and captured calls.
 */
function createDependencies(response: unknown = { operation: 'run', status: 'completed' }) {
  const invocations: { functionName: string; region: string; payload: string }[] = []
  const proofs: { region: string; binding: string }[] = []
  const output: string[] = []
  const errors: string[] = []
  const dependencies: DataMigrationLambdaCliDependencies = {
    invoke: async (input) => {
      invocations.push({ ...input })
      return { payload: JSON.stringify(response) }
    },
    createProof: async (input) => {
      proofs.push({ ...input })
      return 'https://sts.ap-northeast-1.amazonaws.com/?proof'
    },
    createNonce: () => '6b0f3c39-3f0c-4e43-8f0a-111111111111',
    environment: { AWS_REGION: 'ap-northeast-1' },
    writeOutput: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  }
  return { dependencies, invocations, proofs, output, errors }
}

describe('data migration Lambda operator command', () => {
  test('dry-runs without signing a proof', async () => {
    const { dependencies, invocations, proofs, output } = createDependencies()
    expect(await runDataMigrationLambdaCli([
      'run', '--function-name', 'Mukuroji-DataMigrationFunction', '--migration', '0001-x', '--segments', '2',
    ], dependencies)).toBe(0)
    expect(proofs).toEqual([])
    expect(invocations).toEqual([{
      functionName: 'Mukuroji-DataMigrationFunction',
      region: 'ap-northeast-1',
      payload: JSON.stringify({ command: 'run', migrationId: '0001-x', segments: 2 }),
    }])
    expect(JSON.parse(output[0] ?? '{}')).toEqual({ operation: 'run', status: 'completed' })
  })

  test('binds the proof of an applying run to the exact payload and function', async () => {
    const { dependencies, invocations, proofs } = createDependencies({ operation: 'run', status: 'paused' })
    expect(await runDataMigrationLambdaCli([
      'run', '--function-name', 'Mukuroji-DataMigrationFunction', '--region', 'us-west-2',
      '--migration', '0001-x', '--apply', '--max-pages', '5',
    ], dependencies)).toBe(3)
    const payload = JSON.parse(invocations[0]?.payload ?? '{}')
    expect(payload).toEqual({
      command: 'run',
      migrationId: '0001-x',
      apply: true,
      maxPages: 5,
      nonce: '6b0f3c39-3f0c-4e43-8f0a-111111111111',
      operatorProof: 'https://sts.ap-northeast-1.amazonaws.com/?proof',
    })
    expect(proofs).toEqual([{
      region: 'us-west-2',
      binding: computeDataMigrationRequestBinding('Mukuroji-DataMigrationFunction', payload),
    }])
  })

  test('maps responses to exit codes and refuses bad usage', async () => {
    const failed = createDependencies({ operation: 'verify', status: 'error', code: 'TABLE_NOT_CONFIGURED' })
    expect(await runDataMigrationLambdaCli([
      'verify', '--function-name', 'f', '--migration', '0001-x',
    ], failed.dependencies)).toBe(1)
    expect(failed.errors).toHaveLength(1)
    const listed = createDependencies({ operation: 'list', migrations: [] })
    expect(await runDataMigrationLambdaCli(['list', '--function-name', 'f'], listed.dependencies)).toBe(0)
    const usage = createDependencies()
    for (const arguments_ of [
      ['run', '--function-name', 'arn:aws:lambda:ap-northeast-1:123456789012:function:f', '--migration', 'x'],
      ['verify', '--function-name', 'f', '--migration', 'x', '--apply'],
      ['run', '--function-name', 'f'],
      ['list', '--function-name', 'f', '--migration', 'x'],
      ['drop', '--function-name', 'f'],
    ]) {
      expect(await runDataMigrationLambdaCli(arguments_, usage.dependencies)).toBe(2)
    }
    expect(usage.invocations).toEqual([])
    expect(() => parseDataMigrationLambdaCliArguments(['list', '--function-name', 'f'], {})).toThrow()
  })

  test('reports a function error without printing its payload', async () => {
    const { dependencies, errors } = createDependencies()
    const failing: DataMigrationLambdaCliDependencies = {
      ...dependencies,
      invoke: async () => ({ functionError: 'Unhandled', payload: '{"errorMessage":"secret"}' }),
    }
    expect(await runDataMigrationLambdaCli(['list', '--function-name', 'f'], failing)).toBe(1)
    expect(errors.join('\n')).not.toContain('secret')
  })
})

describe('createStsOperatorProof', () => {
  test('presigns GetCallerIdentity with the binding header signed, in a form the Lambda verifier accepts', async () => {
    const binding = 'c'.repeat(64)
    const proof = await createStsOperatorProof({
      region: 'ap-northeast-1',
      binding,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' },
    })
    const url = new URL(proof)
    expect(url.hostname).toBe('sts.ap-northeast-1.amazonaws.com')
    expect(url.searchParams.get('Action')).toBe('GetCallerIdentity')
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(['host', DATA_MIGRATION_OPERATOR_PROOF_HEADER])
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token')
    expect(proof).not.toContain(binding)

    const sent: RequestInit[] = []
    const verify = createStsDataMigrationOperatorVerifier({
      region: 'ap-northeast-1',
      fetch: async (_url, init) => {
        sent.push(init)
        return new Response(JSON.stringify({
          GetCallerIdentityResponse: {
            GetCallerIdentityResult: { Arn: 'arn:aws:iam::123456789012:user/alice', Account: '123456789012' },
          },
        }))
      },
    })
    expect(await verify({ proof, binding, accountId: '123456789012' })).toBe('arn:aws:iam::123456789012:user/alice')
    expect(sent[0]?.headers).toMatchObject({ [DATA_MIGRATION_OPERATOR_PROOF_HEADER]: binding })
  })
})
