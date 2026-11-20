import { describe, expect, test } from 'bun:test'
import {
  buildChangeDescription,
  buildRuntimeControlDocument,
  classifyDeploymentState,
  parseRuntimeControlArguments,
  readDocumentRevision,
  readyMatchesMode,
  runRuntimeControl,
  RuntimeControlError,
  type RuntimeControlDependencies,
} from './runtime-control'

const timing = {
  deploymentPollMilliseconds: 1,
  deploymentTimeoutMilliseconds: 1_000,
  readyPollMilliseconds: 1,
  readyTimeoutMilliseconds: 1_000,
}

const stackOutputs = [
  { OutputKey: 'RuntimeControlApplicationId', OutputValue: 'app1' },
  { OutputKey: 'RuntimeControlEnvironmentId', OutputValue: 'env1' },
  { OutputKey: 'RuntimeControlConfigurationProfileId', OutputValue: 'prof1' },
  { OutputKey: 'RuntimeControlCanaryDeploymentStrategyId', OutputValue: 'canary1' },
  { OutputKey: 'WebUrl', OutputValue: 'https://app.example.com/' },
]

/**
 * Options for the fake AWS account used by {@link fakeDependencies}.
 */
interface FakeOptions {
  /** States returned by successive `get-deployment` calls. */
  readonly deploymentStates?: readonly string[]
  /** Statuses returned by successive `/api/ready` requests. */
  readonly readyStatuses?: readonly (number | undefined)[]
  /** `StateValue` and `ActionsEnabled` of the alarm. */
  readonly alarm?: readonly [string, boolean]
  /** AppConfig environment state. */
  readonly environmentState?: string
}

/**
 * Fake side effects with the calls and files they saw.
 */
interface Fake {
  /** Dependencies to pass to the script. */
  readonly dependencies: RuntimeControlDependencies
  /** Every `aws` call, as its arguments. */
  readonly calls: string[][]
  /** Files written by the script. */
  readonly files: Map<string, string>
}

/**
 * Builds side effects that answer like an AWS account whose latest hosted version has revision 4.
 *
 * @param options - Responses to vary per test.
 * @returns The dependencies and what they recorded.
 */
function fakeDependencies(options: FakeOptions = {}): Fake {
  const calls: string[][] = []
  const files = new Map<string, string>([['/work/latest.json', '{"schemaVersion":1,"mode":"disabled","revision":4}']])
  const deploymentStates = [...(options.deploymentStates ?? ['DEPLOYING', 'BAKING', 'COMPLETE'])]
  const readyStatuses = [...(options.readyStatuses ?? [200])]
  const answer = (args: readonly string[]): unknown => {
    const command = `${args[0]} ${args[1]}`
    switch (command) {
      case 'cloudformation describe-stacks':
        return stackOutputs
      case 'cloudformation describe-stack-resources':
        return ['mukuroji-runtime-control-alarm']
      case 'cloudwatch describe-alarms':
        return [options.alarm ?? ['OK', true]]
      case 'appconfig get-environment':
        return { State: options.environmentState ?? 'READY_FOR_DEPLOYMENT' }
      case 'appconfig list-hosted-configuration-versions':
        return [2, 3]
      case 'appconfig get-hosted-configuration-version':
        return { VersionNumber: 3 }
      case 'appconfig create-hosted-configuration-version':
        return { VersionNumber: 5 }
      case 'appconfig start-deployment':
        return { DeploymentNumber: 7, State: 'DEPLOYING' }
      case 'appconfig get-deployment':
        return { State: deploymentStates.shift() ?? 'COMPLETE', PercentageComplete: 100 }
      default:
        throw new Error(`unexpected aws ${command}`)
    }
  }
  return {
    calls,
    files,
    dependencies: {
      aws: async (args) => {
        calls.push([...args])
        if (args[0] === 'sts') return 'arn:aws:iam::123456789012:user/operator\n'
        return JSON.stringify(answer(args))
      },
      httpStatus: async () => readyStatuses.shift(),
      readText: async (path) => files.get(path) ?? '',
      writeText: async (path, content) => {
        files.set(path, content)
      },
      workDirectory: '/work',
      sleep: async () => {},
      now: () => new Date('2026-11-20T06:00:00.000Z'),
      log: () => {},
    },
  }
}

describe('parseRuntimeControlArguments', () => {
  test('reads the mode and the all-at-once flag', () => {
    expect(parseRuntimeControlArguments(['enable'])).toEqual({ mode: 'enabled', allAtOnce: false })
    expect(parseRuntimeControlArguments(['disable', '--all-at-once'])).toEqual({ mode: 'disabled', allAtOnce: true })
  })

  test('rejects a missing, repeated, or unknown argument', () => {
    expect(() => parseRuntimeControlArguments([])).toThrow(RuntimeControlError)
    expect(() => parseRuntimeControlArguments(['enable', 'disable'])).toThrow(RuntimeControlError)
    expect(() => parseRuntimeControlArguments(['enable', '--force'])).toThrow(RuntimeControlError)
  })
})

describe('document helpers', () => {
  test('reads a valid revision and rejects anything else', () => {
    expect(readDocumentRevision('{"schemaVersion":1,"mode":"enabled","revision":12}')).toBe(12)
    expect(() => readDocumentRevision('not json')).toThrow(RuntimeControlError)
    expect(() => readDocumentRevision('{"mode":"enabled"}')).toThrow(RuntimeControlError)
    expect(() => readDocumentRevision('{"revision":0}')).toThrow(RuntimeControlError)
    expect(() => readDocumentRevision('{"revision":"2"}')).toThrow(RuntimeControlError)
  })

  test('builds a document with only the schema properties', () => {
    expect(JSON.parse(buildRuntimeControlDocument('enabled', 2))).toEqual({ schemaVersion: 1, mode: 'enabled', revision: 2 })
  })

  test('classifies deployment states and readiness', () => {
    expect(classifyDeploymentState('COMPLETE')).toBe('complete')
    expect(classifyDeploymentState('ROLLED_BACK')).toBe('failed')
    expect(classifyDeploymentState('BAKING')).toBe('pending')
    expect(readyMatchesMode('enabled', 200)).toBe(true)
    expect(readyMatchesMode('enabled', 503)).toBe(false)
    expect(readyMatchesMode('disabled', 503)).toBe(true)
    expect(readyMatchesMode('disabled', undefined)).toBe(false)
  })

  test('keeps the description within the AppConfig limit', () => {
    const description = buildChangeDescription('disabled', 3, 'x'.repeat(2_000), new Date(0))
    expect(description.length).toBe(1024)
    expect(buildChangeDescription('enabled', 3, 'arn:op', new Date(0))).toBe(
      'mode=enabled revision=3 by arn:op at 1970-01-01T00:00:00.000Z via bun run runtime-control',
    )
  })
})

describe('runRuntimeControl', () => {
  test('enables with the next revision and the canary strategy, then checks /api/ready', async () => {
    const fake = fakeDependencies({ readyStatuses: [503, 200] })
    const result = await runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'ap-northeast-1', 'Mukuroji', fake.dependencies, timing)

    expect(result).toEqual({ revision: 5, versionNumber: 5, deploymentNumber: 7, readyStatus: 200 })
    expect(JSON.parse(fake.files.get('/work/runtime-control.json') ?? '')).toEqual({ schemaVersion: 1, mode: 'enabled', revision: 5 })
    const latestRead = fake.calls.find((call) => call[1] === 'get-hosted-configuration-version')
    expect(latestRead).toContain('3')
    const deployment = fake.calls.find((call) => call[1] === 'start-deployment') ?? []
    expect(deployment[deployment.indexOf('--deployment-strategy-id') + 1]).toBe('canary1')
    expect(deployment[deployment.indexOf('--configuration-version') + 1]).toBe('5')
    expect(deployment[deployment.indexOf('--description') + 1]).toContain('by arn:aws:iam::123456789012:user/operator')
    expect(fake.calls.some((call) => call[1] === 'describe-alarms')).toBe(true)
  })

  test('disables all at once without the alarm check and expects 503', async () => {
    const fake = fakeDependencies({ alarm: ['ALARM', true], readyStatuses: [200, 503] })
    const result = await runRuntimeControl({ mode: 'disabled', allAtOnce: true }, 'ap-northeast-1', 'Mukuroji', fake.dependencies, timing)

    expect(result.readyStatus).toBe(503)
    const deployment = fake.calls.find((call) => call[1] === 'start-deployment') ?? []
    expect(deployment[deployment.indexOf('--deployment-strategy-id') + 1]).toBe('AppConfig.AllAtOnce')
    expect(fake.calls.some((call) => call[1] === 'describe-alarms')).toBe(false)
  })

  test('refuses to enable while the alarm is not OK', async () => {
    const fake = fakeDependencies({ alarm: ['INSUFFICIENT_DATA', true] })
    await expect(runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('must be OK')
    expect(fake.calls.some((call) => call[1] === 'create-hosted-configuration-version')).toBe(false)
  })

  test('refuses to start while another deployment runs', async () => {
    const fake = fakeDependencies({ environmentState: 'DEPLOYING' })
    await expect(runRuntimeControl({ mode: 'disabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('Wait for that deployment')
  })

  test('fails when AppConfig rolls the deployment back', async () => {
    const fake = fakeDependencies({ deploymentStates: ['DEPLOYING', 'ROLLED_BACK'] })
    await expect(runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('ROLLED_BACK')
  })
})
