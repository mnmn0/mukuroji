import { describe, expect, test } from 'bun:test'
import {
  buildChangeDescription,
  buildRuntimeControlDocument,
  classifyDeploymentState,
  parseRuntimeControlArguments,
  readDocumentMode,
  readDocumentRevision,
  maintenanceMatchesMode,
  readyMatchesMode,
  runRuntimeControl,
  RuntimeControlError,
  type RuntimeControlDependencies,
} from './runtime-control'
import { buildRuntimeControlAuditEvent, readGitHubRun, toDynamoDbItemJson } from './runtime-control-audit'

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
  { OutputKey: 'AuditEventsTableName', OutputValue: 'Mukuroji-AuditEventsTable1-ABC' },
  { OutputKey: 'WorkspaceDirectoryId', OutputValue: 'workspace#production' },
]

const stackParameters = [{ ParameterKey: 'AuditRetentionDays', ParameterValue: '400' }]

/**
 * Options for the fake AWS account used by {@link fakeDependencies}.
 */
interface FakeOptions {
  /** States returned by successive `get-deployment` calls. */
  readonly deploymentStates?: readonly string[]
  /** Statuses returned by successive `/api/ready` requests. */
  readonly readyStatuses?: readonly (number | undefined)[]
  /** States returned by successive `/api/maintenance` requests; defaults to the one the mode expects. */
  readonly maintenanceStates?: readonly (string | undefined)[]
  /** `StateValue` and `ActionsEnabled` of the alarm. */
  readonly alarm?: readonly [string, boolean]
  /** AppConfig environment state. */
  readonly environmentState?: string
  /** Audit phases whose `put-item` fails. */
  readonly failingAuditPhases?: readonly string[]
  /** GitHub Actions run passed to the script. */
  readonly gitHubRun?: RuntimeControlDependencies['gitHubRun']
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
  /** DynamoDB JSON of the audit items stored, in order. */
  readonly auditItems: Record<string, unknown>[]
  /** Every progress line. */
  readonly lines: string[]
}

/**
 * Builds side effects that answer like an AWS account whose latest hosted version has revision 4.
 *
 * @param options - Responses to vary per test.
 * @returns The dependencies and what they recorded.
 */
function fakeDependencies(options: FakeOptions = {}): Fake {
  const calls: string[][] = []
  const auditItems: Record<string, unknown>[] = []
  const lines: string[] = []
  const files = new Map<string, string>([['/work/latest.json', '{"schemaVersion":1,"mode":"disabled","revision":4}']])
  const deploymentStates = [...(options.deploymentStates ?? ['DEPLOYING', 'BAKING', 'COMPLETE'])]
  const readyStatuses = [...(options.readyStatuses ?? [200])]
  const maintenanceStates = options.maintenanceStates === undefined ? undefined : [...options.maintenanceStates]
  let clock = Date.parse('2026-11-20T06:00:00.000Z')
  const answer = (args: readonly string[]): unknown => {
    const command = `${args[0]} ${args[1]}`
    switch (command) {
      case 'cloudformation describe-stacks':
        return { Outputs: stackOutputs, Parameters: stackParameters }
      case 'cloudformation list-stack-resources':
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
      case 'dynamodb put-item': {
        const itemArgument = args[args.indexOf('--item') + 1] ?? ''
        const path = itemArgument.replace(/^file:\/\//, '')
        const phase = /audit-(\w+)\.json$/.exec(path)?.[1] ?? ''
        if (options.failingAuditPhases?.includes(phase)) throw new RuntimeControlError('aws dynamodb put-item failed: AccessDenied')
        auditItems.push(JSON.parse(files.get(path) ?? '{}'))
        return {}
      }
      default:
        throw new Error(`unexpected aws ${command}`)
    }
  }
  return {
    calls,
    files,
    auditItems,
    lines,
    dependencies: {
      aws: async (args) => {
        calls.push([...args])
        if (args[0] === 'sts') return 'arn:aws:iam::123456789012:user/operator\n'
        return JSON.stringify(answer(args))
      },
      httpStatus: async () => (readyStatuses.length > 1 ? readyStatuses.shift() : readyStatuses[0]),
      maintenanceState: async () => {
        if (maintenanceStates) return maintenanceStates.length > 1 ? maintenanceStates.shift() : maintenanceStates[0]
        // Follow the document the script deployed, like the API does once the deployment completes.
        const deployed: unknown = JSON.parse(files.get('/work/runtime-control.json') ?? '{}')
        const mode = typeof deployed === 'object' && deployed !== null && 'mode' in deployed ? deployed.mode : undefined
        return mode === 'enabled' ? 'none' : mode === 'read-only' ? 'read-only' : 'stopped'
      },
      readText: async (path) => files.get(path) ?? '',
      writeText: async (path, content) => {
        files.set(path, content)
      },
      workDirectory: '/work',
      gitHubRun: options.gitHubRun,
      randomId: () => 'switch-1',
      sleep: async (milliseconds) => {
        clock += milliseconds
      },
      now: () => new Date(clock),
      log: (line) => {
        lines.push(line)
      },
    },
  }
}

describe('parseRuntimeControlArguments', () => {
  test('reads the mode and the all-at-once flag', () => {
    expect(parseRuntimeControlArguments(['enable'])).toEqual({ mode: 'enabled', allAtOnce: false })
    expect(parseRuntimeControlArguments(['disable', '--all-at-once'])).toEqual({ mode: 'disabled', allAtOnce: true })
    expect(parseRuntimeControlArguments(['read-only'])).toEqual({ mode: 'read-only', allAtOnce: false })
  })

  test('rejects a missing, repeated, or unknown argument', () => {
    expect(() => parseRuntimeControlArguments([])).toThrow(RuntimeControlError)
    expect(() => parseRuntimeControlArguments(['enable', 'disable'])).toThrow(RuntimeControlError)
    expect(() => parseRuntimeControlArguments(['read-only', 'enable'])).toThrow(RuntimeControlError)
    expect(() => parseRuntimeControlArguments(['toString'])).toThrow(RuntimeControlError)
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

  test('fails when /api/ready does not reach the new mode in time', async () => {
    const fake = fakeDependencies({ readyStatuses: [200] })
    await expect(runRuntimeControl({ mode: 'disabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('returned 200 (expected 503)')
  })

  test('switches to read-only without the alarm check and waits for the maintenance state', async () => {
    const fake = fakeDependencies({ alarm: ['ALARM', true], readyStatuses: [503], maintenanceStates: ['none', 'read-only'] })
    const result = await runRuntimeControl({ mode: 'read-only', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing)

    expect(result.readyStatus).toBe(503)
    expect(JSON.parse(fake.files.get('/work/runtime-control.json') ?? '')).toEqual({ schemaVersion: 1, mode: 'read-only', revision: 5 })
    expect(fake.calls.some((call) => call[1] === 'describe-alarms')).toBe(false)
  })

  test('fails when /api/maintenance keeps reporting another state', async () => {
    const fake = fakeDependencies({ readyStatuses: [503], maintenanceStates: ['stopped'] })
    await expect(runRuntimeControl({ mode: 'read-only', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('reported stopped')
  })

  test('fails when AppConfig rolls the deployment back', async () => {
    const fake = fakeDependencies({ deploymentStates: ['DEPLOYING', 'ROLLED_BACK'] })
    await expect(runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('ROLLED_BACK')
  })
})

describe('maintenanceMatchesMode', () => {
  test('maps each mode to the state the API reports', () => {
    expect(maintenanceMatchesMode('enabled', 'none')).toBe(true)
    expect(maintenanceMatchesMode('disabled', 'stopped')).toBe(true)
    expect(maintenanceMatchesMode('read-only', 'read-only')).toBe(true)
    expect(maintenanceMatchesMode('read-only', 'stopped')).toBe(false)
    expect(maintenanceMatchesMode('enabled', undefined)).toBe(false)
  })
})

/**
 * Reads a string attribute from DynamoDB JSON.
 *
 * @param item - Stored item.
 * @param key - Attribute name.
 * @returns The string, or `undefined` when the attribute is not a string.
 */
function stringAttribute(item: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = item?.[key]
  if (typeof value !== 'object' || value === null || !('S' in value)) return undefined
  return typeof value.S === 'string' ? value.S : undefined
}

/**
 * Reads `metadata.runtimeControl` of a stored audit item as plain values.
 *
 * @param item - Stored item.
 * @returns Metadata keys with their string or number values.
 */
function metadataOf(item: Record<string, unknown> | undefined): Record<string, string | number> {
  const metadata = item?.metadata
  if (typeof metadata !== 'object' || metadata === null || !('M' in metadata)) return {}
  const outer: unknown = metadata.M
  if (typeof outer !== 'object' || outer === null || !('runtimeControl' in outer)) return {}
  const runtimeControl: unknown = outer.runtimeControl
  if (typeof runtimeControl !== 'object' || runtimeControl === null || !('M' in runtimeControl)) return {}
  const map: unknown = runtimeControl.M
  if (typeof map !== 'object' || map === null) return {}
  const result: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'object' || value === null) continue
    if ('S' in value && typeof value.S === 'string') result[key] = value.S
    if ('N' in value && typeof value.N === 'string') result[key] = Number(value.N)
  }
  return result
}

describe('audit log records', () => {
  test('records the start before AppConfig changes and the completion after the checks', async () => {
    const fake = fakeDependencies({ readyStatuses: [200] })
    await runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'ap-northeast-1', 'Mukuroji', fake.dependencies, timing)

    const commands = fake.calls.map((call) => `${call[0]} ${call[1]}`)
    expect(commands.indexOf('dynamodb put-item')).toBeLessThan(commands.indexOf('appconfig create-hosted-configuration-version'))
    expect(commands.lastIndexOf('dynamodb put-item')).toBeGreaterThan(commands.lastIndexOf('appconfig get-deployment'))
    const put = fake.calls.find((call) => call[1] === 'put-item') ?? []
    expect(put[put.indexOf('--table-name') + 1]).toBe('Mukuroji-AuditEventsTable1-ABC')
    expect(put[put.indexOf('--condition-expression') + 1]).toContain('attribute_not_exists(#eventId)')

    expect(fake.auditItems.map((item) => stringAttribute(item, 'eventType'))).toEqual([
      'runtime-control.change-started',
      'runtime-control.change-completed',
    ])
    const [started, completed] = fake.auditItems
    expect(stringAttribute(started, 'workspaceId')).toBe('workspace#production')
    expect(stringAttribute(started, 'actorUserId')).toBe('arn:aws:iam::123456789012:user/operator')
    expect(stringAttribute(started, 'outboxStatus')).toBe('suppressed')
    expect(stringAttribute(started, 'entityId')).toBe('appconfig:app1:prof1')
    expect(stringAttribute(started, 'correlationId')).toBe(stringAttribute(completed, 'correlationId'))
    expect(stringAttribute(started, 'eventId')).not.toBe(stringAttribute(completed, 'eventId'))
    expect(metadataOf(started)).toEqual({ switchId: 'switch-1', mode: 'enabled', revision: 5, strategy: 'canary', previousMode: 'disabled' })
    expect(metadataOf(completed)).toMatchObject({ hostedVersionNumber: 5, deploymentNumber: 7 })
    // Retention follows the stack parameter: 400 days after the event.
    const occurredAt = Date.parse(stringAttribute(completed, 'occurredAt') ?? '')
    expect(completed?.expiresAt).toEqual({ N: String(Math.floor(occurredAt / 1000) + 400 * 86_400) })
  })

  test('changes nothing when the start cannot be recorded for an enable or read-only switch', async () => {
    for (const mode of ['enabled', 'read-only'] as const) {
      const fake = fakeDependencies({ failingAuditPhases: ['started'] })
      await expect(runRuntimeControl({ mode, allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
        .rejects.toThrow('Nothing was changed')
      expect(fake.calls.some((call) => call[1] === 'create-hosted-configuration-version')).toBe(false)
    }
  })

  test('still stops when the start cannot be recorded, and warns', async () => {
    const fake = fakeDependencies({ failingAuditPhases: ['started'], readyStatuses: [503] })
    const result = await runRuntimeControl({ mode: 'disabled', allAtOnce: true }, 'r', 'Mukuroji', fake.dependencies, timing)

    expect(result.readyStatus).toBe(503)
    expect(fake.lines.some((line) => line.startsWith('Warning: Could not record runtime-control.change-started'))).toBe(true)
    expect(fake.auditItems.map((item) => stringAttribute(item, 'eventType'))).toEqual(['runtime-control.change-completed'])
  })

  test('only warns when the completion cannot be recorded', async () => {
    const fake = fakeDependencies({ failingAuditPhases: ['completed'], readyStatuses: [503] })
    await runRuntimeControl({ mode: 'disabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing)
    expect(fake.lines.some((line) => line.includes('completed step is missing from the audit log'))).toBe(true)
  })

  test('records a failure with its reason and the deployment it reached', async () => {
    const fake = fakeDependencies({ deploymentStates: ['DEPLOYING', 'ROLLED_BACK'] })
    await expect(runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('ROLLED_BACK')

    const failed = fake.auditItems.at(-1)
    expect(stringAttribute(failed, 'eventType')).toBe('runtime-control.change-failed')
    expect(metadataOf(failed)).toMatchObject({ failureReason: 'deployment-rolled-back', hostedVersionNumber: 5, deploymentNumber: 7 })
  })

  test('records a readiness timeout as its own reason', async () => {
    const fake = fakeDependencies({ readyStatuses: [200] })
    await expect(runRuntimeControl({ mode: 'disabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing))
      .rejects.toThrow('expected 503')
    expect(metadataOf(fake.auditItems.at(-1))).toMatchObject({ failureReason: 'readiness-timeout' })
  })

  test('names the GitHub Actions run that made the switch', async () => {
    const gitHubRun = readGitHubRun({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'mnmn0/mukuroji',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_ACTOR: 'someone',
      GITHUB_TRIGGERING_ACTOR: 'approver',
    })
    const fake = fakeDependencies({ readyStatuses: [503], gitHubRun })
    await runRuntimeControl({ mode: 'disabled', allAtOnce: false }, 'r', 'Mukuroji', fake.dependencies, timing)

    expect(JSON.stringify(fake.auditItems[0]?.metadata)).toContain(
      '"runUrl":{"S":"https://github.com/mnmn0/mukuroji/actions/runs/42/attempts/2"}',
    )
    expect(JSON.stringify(fake.auditItems[0]?.metadata)).toContain('"actor":{"S":"approver"}')
    const actor = fake.auditItems[0]?.actor
    expect(JSON.stringify(actor)).toContain('GitHub Actions (approver)')
  })

  test('reads no GitHub run outside GitHub Actions', () => {
    expect(readGitHubRun({ GITHUB_RUN_ID: '42' })).toBeUndefined()
    expect(readGitHubRun({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42' })).toBeUndefined()
  })

  test('reads the previous mode only when the schema accepts it', () => {
    expect(readDocumentMode('{"mode":"read-only","revision":3}')).toBe('read-only')
    expect(readDocumentMode('{"mode":"paused"}')).toBeUndefined()
    expect(readDocumentMode('nope')).toBeUndefined()
  })

  test('refuses a stack without the audit outputs before changing anything', async () => {
    const fake = fakeDependencies()
    const original = fake.dependencies.aws
    const aws: RuntimeControlDependencies['aws'] = async (args) =>
      args[1] === 'describe-stacks'
        ? JSON.stringify({ Outputs: stackOutputs.filter((output) => output.OutputKey !== 'AuditEventsTableName') })
        : await original(args)
    await expect(runRuntimeControl({ mode: 'enabled', allAtOnce: false }, 'r', 'Mukuroji', { ...fake.dependencies, aws }, timing))
      .rejects.toThrow('has no AuditEventsTableName output')
  })
})

describe('toDynamoDbItemJson', () => {
  test('writes nested values as DynamoDB JSON', () => {
    const event = buildRuntimeControlAuditEvent(
      { tableName: 't', workspaceId: 'workspace#a', retentionDays: 30 },
      {
        switchId: 's', applicationId: 'a', configurationProfileId: 'p', mode: 'read-only', previousMode: undefined,
        revision: 2, allAtOnce: false, callerArn: 'arn:x', gitHubRun: undefined,
      },
      { phase: 'started', occurredAt: new Date(0) },
    )
    const item: unknown = JSON.parse(toDynamoDbItemJson(event))
    expect(item).toMatchObject({
      schemaVersion: { N: '1' },
      changes: { L: [{ M: { field: { S: 'mode' }, after: { S: 'read-only' } } }] },
      actor: { M: { kind: { S: 'service' } } },
    })
  })
})
