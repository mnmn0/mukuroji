import { describe, expect, test } from 'bun:test'
import {
  checkAlarmSubscriptions,
  checkAppConfigDeployment,
  checkApiNotRewritten,
  checkCognitoEmail,
  checkCognitoMfa,
  checkDeadLetterQueues,
  checkHealth,
  checkHolidaySync,
  checkRuntimeMode,
  checkWebRoot,
  selectDeadLetterQueues,
  formatSmokeReport,
  nextHolidaySyncAt,
  parseSmokeArguments,
  runPostDeploySmoke,
  SmokeError,
  type SmokeCheckResult,
  type SmokeDependencies,
  type SmokeHttpResponse,
} from './post-deploy-smoke'

const COMMIT = 'a'.repeat(40)
const NOW = new Date('2026-11-22T01:00:00Z')

/** Headers the CloudFront response headers policy adds to every response. */
const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['strict-transport-security', 'max-age=63072000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['via', '1.1 abc.cloudfront.net (CloudFront)'],
  ['x-cache', 'Miss from cloudfront'],
]

/**
 * Builds a response with the CloudFront security headers.
 *
 * @param status - HTTP status.
 * @param body - Body text.
 * @param extra - Headers to add or replace.
 * @returns The response.
 */
function response(status: number, body: string, extra: Readonly<Record<string, string>> = {}): SmokeHttpResponse {
  const headers = new Map<string, string>(SECURITY_HEADERS)
  for (const [key, value] of Object.entries(extra)) headers.set(key, value)
  return { status, headers, body }
}

/**
 * Builds an HTML response from the Web bucket.
 *
 * @returns The response.
 */
function html(): SmokeHttpResponse {
  return response(200, '<!doctype html>', { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" })
}

/**
 * Builds a JSON response from the API.
 *
 * @param status - HTTP status.
 * @param body - Value to serialize.
 * @returns The response.
 */
function json(status: number, body: unknown): SmokeHttpResponse {
  return response(status, JSON.stringify(body), {
    'content-type': 'application/json',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  })
}

/**
 * Finds a result by name.
 *
 * @param results - Results to search.
 * @param name - Check name.
 * @returns The result.
 */
function find(results: readonly SmokeCheckResult[], name: string): SmokeCheckResult {
  const result = results.find((entry) => entry.name === name)
  if (result === undefined) throw new Error(`No ${name} result`)
  return result
}

describe('parseSmokeArguments', () => {
  test('defaults to an enabled runtime with AWS checks', () => {
    expect(parseSmokeArguments([])).toEqual({ runtime: 'enabled', expectCommit: undefined, skipAws: false, ownerEmail: undefined })
  })

  test('reads every option', () => {
    expect(parseSmokeArguments(['--runtime', 'disabled', '--expect-commit', COMMIT, '--skip-aws', '--owner-email', 'Owner@Example.com']))
      .toEqual({ runtime: 'disabled', expectCommit: COMMIT, skipAws: true, ownerEmail: 'owner@example.com' })
  })

  test('rejects unknown and malformed values', () => {
    expect(() => parseSmokeArguments(['--runtime', 'on'])).toThrow(SmokeError)
    expect(() => parseSmokeArguments(['--expect-commit', 'abc'])).toThrow(SmokeError)
    expect(() => parseSmokeArguments(['--runtime'])).toThrow(SmokeError)
    expect(() => parseSmokeArguments(['--apply'])).toThrow(SmokeError)
  })
})

describe('HTTP checks', () => {
  test('accepts the Web root through CloudFront', () => {
    expect(checkWebRoot(html()).map((result) => result.status)).toEqual(['pass', 'pass', 'pass'])
  })

  test('fails without CloudFront or security headers', () => {
    const bare: SmokeHttpResponse = { status: 200, headers: new Map([['content-type', 'text/html']]), body: '' }
    const results = checkWebRoot(bare)
    expect(find(results, 'cloudfront').status).toBe('fail')
    expect(find(results, 'web-security-headers').detail).toContain('Strict-Transport-Security')
  })

  test('requires the API CSP and a non-HTML answer for unknown API paths', () => {
    expect(checkApiNotRewritten(json(404, { title: 'Not Found' })).map((result) => result.status)).toEqual(['pass', 'pass'])
    expect(checkApiNotRewritten(html()).map((result) => result.status)).toEqual(['fail', 'fail'])
  })

  test('compares the health commit', () => {
    expect(checkHealth('api-health', json(200, { ok: true, applicationCommitSha: COMMIT }), COMMIT).result.status).toBe('pass')
    const stale = checkHealth('api-health', json(200, { ok: true, applicationCommitSha: 'b'.repeat(40) }), COMMIT)
    expect(stale.result.status).toBe('fail')
    expect(stale.commit).toBe('b'.repeat(40))
    expect(checkHealth('api-health', undefined, undefined).result.status).toBe('fail')
  })

  test('matches the runtime mode', () => {
    expect(checkRuntimeMode('enabled', json(200, {}), json(200, { state: 'none' })).status).toBe('pass')
    expect(checkRuntimeMode('disabled', json(503, {}), json(200, { state: 'stopped' })).status).toBe('pass')
    expect(checkRuntimeMode('read-only', json(503, {}), json(200, { state: 'read-only' })).status).toBe('pass')
    const notYet = checkRuntimeMode('enabled', json(503, {}), json(200, { state: 'stopped' }))
    expect(notYet.status).toBe('fail')
    expect(notYet.detail).toContain('runtime-control-enable')
  })
})

describe('AWS checks', () => {
  const mfaConfig = { MfaConfiguration: 'OPTIONAL', SoftwareTokenMfaConfiguration: { Enabled: true } }

  test('reports the owner MFA state', () => {
    expect(checkCognitoMfa(mfaConfig, { UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }).map((r) => r.status))
      .toEqual(['pass', 'pass'])
    expect(checkCognitoMfa(mfaConfig, { UserStatus: 'FORCE_CHANGE_PASSWORD' })[1]?.status).toBe('warn')
    expect(checkCognitoMfa(mfaConfig, { UserStatus: 'CONFIRMED' })[1]?.detail).toContain('Settings')
    expect(checkCognitoMfa({ MfaConfiguration: 'OFF' }, undefined).map((r) => r.status)).toEqual(['fail', 'skip'])
  })

  test('warns while Cognito sends its own email or SES is in the sandbox', () => {
    expect(checkCognitoEmail({ UserPool: { EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' } } }, undefined, undefined).status)
      .toBe('warn')
    const ses = { UserPool: { EmailConfiguration: { EmailSendingAccount: 'DEVELOPER' } } }
    expect(checkCognitoEmail(ses, { ProductionAccessEnabled: false }, { VerifiedForSendingStatus: true }).status).toBe('warn')
    expect(checkCognitoEmail(ses, { ProductionAccessEnabled: true }, { VerifiedForSendingStatus: true }).status).toBe('pass')
    expect(checkCognitoEmail(ses, { ProductionAccessEnabled: true }, { VerifiedForSendingStatus: false }).status).toBe('fail')
  })

  test('accepts a holiday list fetched this month in Japan', () => {
    const item = { Item: { fetchedMonth: { S: '2026-11' }, fetchedAt: { S: '2026-11-22T00:00:01Z' } } }
    expect(checkHolidaySync(item, 0, NOW).status).toBe('pass')
    // 2026-11-30T16:00Z is already December in Japan.
    expect(checkHolidaySync(item, 0, new Date('2026-11-30T16:00:00Z')).status).toBe('warn')
  })

  test('warns with the next run time when no list is stored', () => {
    const result = checkHolidaySync({}, 2, NOW)
    expect(result.status).toBe('warn')
    expect(result.detail).toContain('2026-11-22T06:00:00.000Z')
    expect(result.detail).toContain('2 failed attempt(s)')
    expect(nextHolidaySyncAt(new Date('2026-11-22T06:00:00Z')).toISOString()).toBe('2026-11-22T12:00:00.000Z')
  })

  test('fails on a non-empty or unreadable dead-letter queue', () => {
    expect(checkDeadLetterQueues([['ADlqUrl', 0], ['BDlqUrl', 0]]).status).toBe('pass')
    expect(checkDeadLetterQueues([['ADlqUrl', 3]]).detail).toContain('ADlqUrl=3')
    expect(checkDeadLetterQueues([['ADlqUrl', undefined]]).status).toBe('fail')
  })

  test('finds every DLQ among the stack queues, with or without an output', () => {
    const resources = {
      StackResourceSummaries: [
        { LogicalResourceId: 'AuditExportDlq1A2B', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/audit-dlq' },
        { LogicalResourceId: 'AuditExportQueue3C4D', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/audit' },
        { LogicalResourceId: 'ApiFunctionDeadLetterQueue5E', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/api-dlq' },
        { LogicalResourceId: 'ScheduledJobsDlqAlarm', ResourceType: 'AWS::CloudWatch::Alarm', PhysicalResourceId: 'alarm' },
      ],
    }
    expect(selectDeadLetterQueues(resources)).toEqual([
      ['AuditExportDlq1A2B', 'https://sqs/audit-dlq'],
      ['ApiFunctionDeadLetterQueue5E', 'https://sqs/api-dlq'],
    ])
  })

  test('needs a confirmed subscription on each alarm topic', () => {
    const confirmed = { Subscriptions: [{ SubscriptionArn: 'arn:aws:sns:ap-northeast-1:1:t:1' }] }
    expect(checkAlarmSubscriptions([['p', confirmed], ['s', confirmed]]).status).toBe('pass')
    const pending = { Subscriptions: [{ SubscriptionArn: 'PendingConfirmation' }] }
    expect(checkAlarmSubscriptions([['p', confirmed], ['s', pending]]).detail).toContain('s is waiting for confirmation')
    expect(checkAlarmSubscriptions([['p', {}]]).detail).toContain('no subscription')
  })

  test('reads the latest AppConfig deployment', () => {
    expect(checkAppConfigDeployment({ Items: [{ DeploymentNumber: 1, State: 'ROLLED_BACK' }, { DeploymentNumber: 2, State: 'COMPLETE' }] }).status)
      .toBe('pass')
    expect(checkAppConfigDeployment({ Items: [{ DeploymentNumber: 3, State: 'BAKING' }] }).status).toBe('warn')
    expect(checkAppConfigDeployment({ Items: [] }).status).toBe('fail')
  })
})

/**
 * Options for the fake account used by {@link fakeDependencies}.
 */
interface FakeOptions {
  /** Messages in the scheduled jobs DLQ. */
  readonly scheduledJobsDlqDepth?: string
  /** Whether `/api/ready` answers 200. */
  readonly ready?: boolean
}

/**
 * Builds side effects that answer like a freshly deployed, enabled stack.
 *
 * @param options - Variations on the healthy account.
 * @returns The dependencies and every `aws` call.
 */
function fakeDependencies(options: FakeOptions = {}): { readonly dependencies: SmokeDependencies; readonly calls: string[][] } {
  const calls: string[][] = []
  const outputs = [
    ['WebUrl', 'https://d1.cloudfront.net'],
    ['ApiGatewayUrl', 'https://api1.execute-api.ap-northeast-1.amazonaws.com/'],
    ['WebBucketName', 'web-bucket'],
    ['UserPoolId', 'pool1'],
    ['RuntimeControlApplicationId', 'app1'],
    ['RuntimeControlEnvironmentId', 'env1'],
    ['TenantAdministrationTableName', 'tenant-admin'],
    ['ScheduledJobsFunctionName', 'scheduled-jobs'],
    ['ScheduledJobsDlqUrl', 'https://sqs/scheduled-dlq'],
    ['WebhookDeliveryDlqUrl', 'https://sqs/webhook-dlq'],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }))
  const answers: Readonly<Record<string, unknown>> = {
    'cloudformation describe-stacks': { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Outputs: outputs }] },
    'cloudformation list-stack-resources': {
      StackResourceSummaries: [
        { LogicalResourceId: 'ScheduledJobsDlqA1', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/scheduled-dlq' },
        { LogicalResourceId: 'AuditExportDlqB2', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/audit-dlq' },
        { LogicalResourceId: 'AuditExportQueueC3', ResourceType: 'AWS::SQS::Queue', PhysicalResourceId: 'https://sqs/audit' },
      ],
    },
    's3api head-object': { ContentType: 'text/html' },
    'appconfig list-deployments': { Items: [{ DeploymentNumber: 1, State: 'COMPLETE' }] },
    'cognito-idp get-user-pool-mfa-config': { MfaConfiguration: 'OPTIONAL', SoftwareTokenMfaConfiguration: { Enabled: true } },
    'cognito-idp admin-get-user': { UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] },
    'cognito-idp describe-user-pool': { UserPool: { EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' } } },
    'dynamodb get-item': { Item: { fetchedMonth: { S: '2026-11' }, fetchedAt: { S: '2026-11-22T00:00:02Z' } } },
    'lambda get-function-configuration': { LoggingConfig: { LogGroup: '/mukuroji/scheduled-jobs' } },
    'logs filter-log-events': { events: [] },
    'cloudwatch describe-alarms': { MetricAlarms: [], CompositeAlarms: [] },
    'sts get-caller-identity': { Account: '123456789012' },
    'sns list-subscriptions-by-topic': { Subscriptions: [{ SubscriptionArn: 'arn:aws:sns:ap-northeast-1:123456789012:t:1' }] },
  }
  const dependencies: SmokeDependencies = {
    aws: async (args) => {
      calls.push([...args])
      const command = args.slice(0, 2).join(' ')
      if (command === 'ssm get-parameter') {
        const name = args[args.indexOf('--name') + 1] ?? ''
        const value = name.endsWith('initial-owner-email') ? 'owner@example.com' : name.split('/').at(-1)
        return JSON.stringify({ Parameter: { Value: value } })
      }
      if (command === 'sqs get-queue-attributes') {
        const url = args[args.indexOf('--queue-url') + 1]
        const depth = url === 'https://sqs/scheduled-dlq' ? options.scheduledJobsDlqDepth ?? '0' : '0'
        return JSON.stringify({ Attributes: { ApproximateNumberOfMessages: depth, ApproximateNumberOfMessagesNotVisible: '0' } })
      }
      if (!(command in answers)) throw new Error(`unexpected aws ${command}`)
      return JSON.stringify(answers[command])
    },
    get: async (url) => {
      if (url.includes('.s3.')) return response(403, '<Error/>', { 'content-type': 'application/xml' })
      const path = new URL(url).pathname
      if (path === '/' || path === '/login') return html()
      if (path.endsWith('/health')) return json(200, { ok: true, status: 'alive', applicationCommitSha: COMMIT })
      if (path === '/api/ready') return json(options.ready === false ? 503 : 200, {})
      if (path === '/api/maintenance') return json(200, { state: options.ready === false ? 'stopped' : 'none' })
      if (path.endsWith('teams/projects')) return json(200, { teams: [] })
      return json(404, { title: 'Not Found' })
    },
    now: () => NOW,
  }
  return { dependencies, calls }
}

const environment = { region: 'ap-northeast-1', stackName: 'Mukuroji', webUrl: undefined, accessToken: undefined }

describe('runPostDeploySmoke', () => {
  test('passes on a healthy enabled stack and only reads from AWS', async () => {
    const fake = fakeDependencies()
    const results = await runPostDeploySmoke(parseSmokeArguments([]), environment, fake.dependencies)
    const failing = results.filter((result) => result.status === 'fail' || result.status === 'warn')
    // Cognito still sends its own email right after the first deploy.
    expect(failing.map((result) => result.name)).toEqual(['cognito-email'])
    expect(find(results, 'authenticated-api').status).toBe('skip')
    expect(find(results, 'web-release').detail).toContain(COMMIT.slice(0, 12))
    const verbs = new Set(fake.calls.map((args) => args[1]?.split('-')[0]))
    for (const verb of verbs) expect(['describe', 'get', 'list', 'head', 'admin', 'filter']).toContain(verb)
    expect(fake.calls.filter((args) => args[1] === 'admin-get-user').length).toBe(1)
    expect(formatSmokeReport(results)).toContain('0 fail')
  })

  test('compares the authenticated routes when a token is given', async () => {
    const fake = fakeDependencies()
    const results = await runPostDeploySmoke(parseSmokeArguments([]), { ...environment, accessToken: 'token' }, fake.dependencies)
    expect(find(results, 'authenticated-api').status).toBe('pass')
  })

  test('fails on a waiting dead-letter message and a stopped runtime', async () => {
    const fake = fakeDependencies({ scheduledJobsDlqDepth: '2', ready: false })
    const results = await runPostDeploySmoke(parseSmokeArguments([]), environment, fake.dependencies)
    expect(find(results, 'dead-letter-queues').detail).toContain('ScheduledJobsDlqA1=2')
    expect(find(results, 'runtime-control').status).toBe('fail')
  })

  test('runs only HTTP checks with --skip-aws', async () => {
    const fake = fakeDependencies()
    const results = await runPostDeploySmoke(
      parseSmokeArguments(['--skip-aws']),
      { ...environment, region: '', webUrl: 'https://d1.cloudfront.net/' },
      fake.dependencies,
    )
    expect(fake.calls).toEqual([])
    expect(results.every((result) => result.status === 'pass' || result.status === 'skip')).toBe(true)
  })

  test('needs a region or a Web URL', async () => {
    const fake = fakeDependencies()
    await expect(runPostDeploySmoke(parseSmokeArguments([]), { ...environment, region: '' }, fake.dependencies)).rejects.toThrow(SmokeError)
    await expect(runPostDeploySmoke(parseSmokeArguments(['--skip-aws']), environment, fake.dependencies)).rejects.toThrow(SmokeError)
  })
})
