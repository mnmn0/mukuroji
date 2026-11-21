/**
 * Read-only smoke test for the production stack, run right after a deploy.
 *
 * Usage:
 *   AWS_REGION=ap-northeast-1 bun run deploy:smoke
 *   AWS_REGION=ap-northeast-1 bun run deploy:smoke -- --runtime disabled
 *   AWS_REGION=ap-northeast-1 bun run deploy:smoke -- --expect-commit <40-character SHA>
 *   MUKUROJI_WEB_URL=https://dxxxx.cloudfront.net bun run deploy:smoke -- --skip-aws
 *
 * It checks what the Floci emulator cannot: CloudFront and its security headers, AppConfig delivery
 * through `/api/ready` and `/api/maintenance`, the Cognito MFA settings and the owner's MFA, how
 * Cognito sends email, the Cabinet Office holiday sync, alarms, alarm subscriptions, and dead-letter
 * queues. With `MUKUROJI_SMOKE_ACCESS_TOKEN` set to a fresh owner access token it also compares the
 * Workspace response through CloudFront and through the HTTP API.
 *
 * Every AWS call is a read (`describe`, `get`, `list`), so the script never changes the stack or data.
 * It calls the `aws` CLI with the caller's normal credentials. The exit code is 1 when a check fails;
 * a warning (for example a holiday sync that has not run yet) does not fail the run.
 */

/** Runtime-control mode the stack is expected to serve. */
export type ExpectedRuntimeMode = 'enabled' | 'disabled' | 'read-only'

/** Outcome of one check. */
export type SmokeCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

/**
 * Result of one check, printed as one line.
 */
export interface SmokeCheckResult {
  /** Short, stable name of the check. */
  readonly name: string
  /** Outcome. */
  readonly status: SmokeCheckStatus
  /** What was observed, or what to do next. */
  readonly detail: string
}

/**
 * Parsed command-line request.
 */
export interface SmokeRequest {
  /** Mode that `/api/ready` and `/api/maintenance` should report. */
  readonly runtime: ExpectedRuntimeMode
  /** Commit that `/api/health` and the Web release should match, when given. */
  readonly expectCommit: string | undefined
  /** Whether to run only the HTTP checks against `MUKUROJI_WEB_URL`. */
  readonly skipAws: boolean
  /** Initial owner email; read from SSM when omitted. */
  readonly ownerEmail: string | undefined
}

/**
 * HTTP response reduced to what the checks read.
 */
export interface SmokeHttpResponse {
  /** HTTP status. */
  readonly status: number
  /** Response headers with lower-case names. */
  readonly headers: ReadonlyMap<string, string>
  /** Response body as text. */
  readonly body: string
}

/**
 * Side effects used by {@link runPostDeploySmoke}, replaceable in tests.
 */
export interface SmokeDependencies {
  /**
   * Runs one read-only `aws` CLI command.
   *
   * @param args - Arguments after `aws`.
   * @returns The command's standard output.
   */
  readonly aws: (args: readonly string[]) => Promise<string>
  /**
   * Sends a GET request without following redirects or caching.
   *
   * @param url - URL to request.
   * @param headers - Extra request headers.
   * @returns The response, or `undefined` when the request failed.
   */
  readonly get: (url: string, headers?: Readonly<Record<string, string>>) => Promise<SmokeHttpResponse | undefined>
  /**
   * Returns the current time.
   *
   * @returns The current time.
   */
  readonly now: () => Date
}

/**
 * Settings read from the environment.
 */
export interface SmokeEnvironment {
  /** AWS region; required unless `--skip-aws`. */
  readonly region: string
  /** CloudFormation stack name. */
  readonly stackName: string
  /** Web URL used with `--skip-aws`. */
  readonly webUrl: string | undefined
  /** Fresh owner access token for the authenticated comparison, when given. */
  readonly accessToken: string | undefined
}

/** Error for a request the script refuses, printed without a stack trace. */
export class SmokeError extends Error {}

/** SSM parameter that the deploy access stack writes with the initial owner email. */
const OWNER_EMAIL_PARAMETER = '/mukuroji/deploy/config/initial-owner-email'

/** SSM parameters that name the two alarm topics. */
const ALARM_TOPIC_PARAMETERS: readonly string[] = [
  '/mukuroji/deploy/config/alarm-primary-topic-name',
  '/mukuroji/deploy/config/alarm-secondary-topic-name',
]

/** Partition and sort key of the stored Cabinet Office holiday list. */
const HOLIDAY_RECORD_KEY = JSON.stringify({
  workspaceId: { S: 'system#public-holidays' },
  recordKey: { S: 'JAPAN' },
})

/** Interval of the holiday sync job, in minutes; it runs when the UTC minute count divides by it. */
const HOLIDAY_SYNC_INTERVAL_MINUTES = 360

/** Stack states that mean the last operation finished successfully. */
const STACK_COMPLETE_STATES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE'])

/**
 * Parses the command-line arguments.
 *
 * @param argv - Arguments after the script name.
 * @returns The parsed request.
 * @throws SmokeError for an unknown argument or a malformed value.
 */
export function parseSmokeArguments(argv: readonly string[]): SmokeRequest {
  let runtime: ExpectedRuntimeMode = 'enabled'
  let expectCommit: string | undefined
  let skipAws = false
  let ownerEmail: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new SmokeError(`${argument} needs a value.`)
      index += 1
      return next
    }
    if (argument === '--runtime') {
      const mode = value()
      if (mode !== 'enabled' && mode !== 'disabled' && mode !== 'read-only') {
        throw new SmokeError('--runtime must be enabled, disabled, or read-only.')
      }
      runtime = mode
    } else if (argument === '--expect-commit') {
      const sha = value()
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new SmokeError('--expect-commit must be a 40-character lower-case SHA.')
      expectCommit = sha
    } else if (argument === '--owner-email') {
      ownerEmail = value().toLowerCase()
    } else if (argument === '--skip-aws') {
      skipAws = true
    } else {
      throw new SmokeError(`Unknown argument: ${argument}`)
    }
  }
  return { runtime, expectCommit, skipAws, ownerEmail }
}

/**
 * Narrows a value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses JSON, returning `undefined` instead of throwing.
 *
 * @param text - Text to parse.
 * @returns The parsed value, or `undefined` when the text is not JSON.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Reads a string property of a parsed JSON object.
 *
 * @param value - Parsed value.
 * @param key - Property name.
 * @returns The string, or `undefined` when missing or not a string.
 */
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * Reads an array property of a parsed JSON object.
 *
 * @param value - Parsed value.
 * @param key - Property name.
 * @returns The array, or an empty array when missing.
 */
function arrayField(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return []
  const field = value[key]
  return Array.isArray(field) ? field : []
}

/**
 * Formats an error for a check's detail.
 *
 * @param error - Thrown value.
 * @returns A one-line message.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim()
}

/**
 * Runs an `aws` command and parses its JSON output.
 *
 * @param dependencies - Side effects.
 * @param args - Arguments after `aws`; `--output json` is appended.
 * @returns The parsed output.
 * @throws SmokeError when the output is not JSON.
 */
async function awsJson(dependencies: SmokeDependencies, args: readonly string[]): Promise<unknown> {
  const output = await dependencies.aws([...args, '--output', 'json'])
  const parsed = tryParseJson(output)
  if (parsed === undefined) throw new SmokeError(`aws ${args.slice(0, 2).join(' ')} did not print JSON.`)
  return parsed
}

/**
 * Joins a base URL and an absolute path without doubling the slash.
 *
 * @param base - Base URL, with or without a trailing slash.
 * @param path - Path starting with `/`.
 * @returns The joined URL.
 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * Checks the Web root through CloudFront and its security headers.
 *
 * @param response - Response of `GET <WebUrl>/`.
 * @returns The check results.
 */
export function checkWebRoot(response: SmokeHttpResponse | undefined): readonly SmokeCheckResult[] {
  if (response === undefined) {
    return [{ name: 'web-root', status: 'fail', detail: 'WebUrl did not answer.' }]
  }
  const results: SmokeCheckResult[] = []
  const contentType = response.headers.get('content-type') ?? ''
  results.push(response.status === 200 && contentType.includes('text/html')
    ? { name: 'web-root', status: 'pass', detail: 'GET / returned the Web app (200, text/html).' }
    : { name: 'web-root', status: 'fail', detail: `GET / returned ${response.status} ${contentType || 'without content-type'}.` })
  const edge = `${response.headers.get('via') ?? ''} ${response.headers.get('x-cache') ?? ''}`
  results.push(/cloudfront/i.test(edge)
    ? { name: 'cloudfront', status: 'pass', detail: `Served by CloudFront (${(response.headers.get('x-cache') ?? 'via header').trim()}).` }
    : { name: 'cloudfront', status: 'fail', detail: 'No CloudFront Via or X-Cache header; WebUrl may not point at the distribution.' })
  results.push(checkSecurityHeaders('web-security-headers', response, undefined))
  return results
}

/**
 * Checks the security headers that the CloudFront response headers policy adds.
 *
 * @param name - Check name.
 * @param response - Response to inspect.
 * @param cspMustContain - Directive the Content-Security-Policy must contain, when any.
 * @returns The check result.
 */
function checkSecurityHeaders(
  name: string,
  response: SmokeHttpResponse,
  cspMustContain: string | undefined,
): SmokeCheckResult {
  const problems: string[] = []
  const hsts = response.headers.get('strict-transport-security') ?? ''
  if (!/max-age=\d+/.test(hsts)) problems.push('Strict-Transport-Security')
  if ((response.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') problems.push('X-Content-Type-Options')
  if ((response.headers.get('x-frame-options') ?? '').toUpperCase() !== 'DENY') problems.push('X-Frame-Options')
  if ((response.headers.get('referrer-policy') ?? '').toLowerCase() !== 'no-referrer') problems.push('Referrer-Policy')
  const csp = response.headers.get('content-security-policy') ?? ''
  if (!csp || (cspMustContain !== undefined && !csp.includes(cspMustContain))) problems.push('Content-Security-Policy')
  return problems.length === 0
    ? { name, status: 'pass', detail: 'HSTS, nosniff, DENY, no-referrer, and CSP are set.' }
    : { name, status: 'fail', detail: `Missing or unexpected: ${problems.join(', ')}.` }
}

/**
 * Checks that a client-side route is rewritten to `index.html`.
 *
 * @param response - Response of `GET <WebUrl>/login`.
 * @returns The check result.
 */
export function checkSpaRoute(response: SmokeHttpResponse | undefined): SmokeCheckResult {
  const contentType = response?.headers.get('content-type') ?? ''
  return response?.status === 200 && contentType.includes('text/html')
    ? { name: 'spa-route', status: 'pass', detail: 'GET /login returned index.html.' }
    : { name: 'spa-route', status: 'fail', detail: `GET /login returned ${response?.status ?? 'no response'}; the CloudFront Function may not rewrite paths.` }
}

/**
 * Checks that an unknown `/api/*` path reaches the API instead of `index.html`.
 *
 * @param response - Response of `GET <WebUrl>/api/<unknown>`.
 * @returns The check results.
 */
export function checkApiNotRewritten(response: SmokeHttpResponse | undefined): readonly SmokeCheckResult[] {
  if (response === undefined) return [{ name: 'api-not-rewritten', status: 'fail', detail: 'The API did not answer.' }]
  const contentType = response.headers.get('content-type') ?? ''
  return [
    response.status !== 200 && !contentType.includes('text/html')
      ? { name: 'api-not-rewritten', status: 'pass', detail: `An unknown /api path returned ${response.status} from the API.` }
      : { name: 'api-not-rewritten', status: 'fail', detail: `An unknown /api path returned ${response.status} ${contentType}; /api/* may be served from the bucket.` },
    checkSecurityHeaders('api-security-headers', response, "default-src 'none'"),
  ]
}

/**
 * Checks `/api/health` and the deployed commit.
 *
 * @param name - Check name.
 * @param response - Response of `GET .../api/health`.
 * @param expectCommit - Commit the API should report, when known.
 * @returns The check result and the reported commit.
 */
export function checkHealth(
  name: string,
  response: SmokeHttpResponse | undefined,
  expectCommit: string | undefined,
): { readonly result: SmokeCheckResult; readonly commit: string | undefined } {
  if (response === undefined) return { result: { name, status: 'fail', detail: '/api/health did not answer.' }, commit: undefined }
  const body = tryParseJson(response.body)
  const ok = isRecord(body) && body.ok === true
  const commit = stringField(body, 'applicationCommitSha')
  if (response.status !== 200 || !ok) {
    return { result: { name, status: 'fail', detail: `/api/health returned ${response.status}.` }, commit }
  }
  if (expectCommit !== undefined && commit !== expectCommit) {
    return { result: { name, status: 'fail', detail: `/api/health reports ${commit ?? 'no commit'}, expected ${expectCommit}.` }, commit }
  }
  return { result: { name, status: 'pass', detail: `/api/health is alive at ${commit ?? 'an unknown commit'}.` }, commit }
}

/**
 * Checks that `/api/ready` and `/api/maintenance` show the runtime-control mode AppConfig delivered.
 *
 * @param expected - Mode the stack should serve.
 * @param ready - Response of `GET <WebUrl>/api/ready`.
 * @param maintenance - Response of `GET <WebUrl>/api/maintenance`.
 * @returns The check result.
 */
export function checkRuntimeMode(
  expected: ExpectedRuntimeMode,
  ready: SmokeHttpResponse | undefined,
  maintenance: SmokeHttpResponse | undefined,
): SmokeCheckResult {
  const expectedState = expected === 'enabled' ? 'none' : expected === 'read-only' ? 'read-only' : 'stopped'
  const expectedReady = expected === 'enabled' ? 200 : 503
  const state = maintenance === undefined ? undefined : stringField(tryParseJson(maintenance.body), 'state')
  const observed = `/api/ready ${ready?.status ?? 'no response'}, /api/maintenance ${state ?? 'no state'}`
  if (ready?.status === expectedReady && state === expectedState) {
    return { name: 'runtime-control', status: 'pass', detail: `AppConfig delivers ${expected} (${observed}).` }
  }
  const hint = expected === 'enabled' && state === 'stopped'
    ? ' Run the runtime-control-enable operation first.'
    : ''
  return { name: 'runtime-control', status: 'fail', detail: `Expected ${expected}, saw ${observed}.${hint}` }
}

/**
 * Compares the owner's Workspace response through CloudFront and the HTTP API.
 *
 * @param responses - Responses of the three `teams/projects` paths, labelled.
 * @returns The check result.
 */
export function checkAuthenticatedPaths(
  responses: readonly (readonly [string, SmokeHttpResponse | undefined])[],
): SmokeCheckResult {
  const failed = responses.filter(([, response]) => response?.status !== 200)
  if (failed.length > 0) {
    const list = failed.map(([label, response]) => `${label} ${response?.status ?? 'no response'}`).join(', ')
    return { name: 'authenticated-api', status: 'fail', detail: `Not 200: ${list}. Use a fresh owner access token.` }
  }
  const bodies = new Set(responses.map(([, response]) => JSON.stringify(tryParseJson(response?.body ?? '') ?? null)))
  return bodies.size === 1
    ? { name: 'authenticated-api', status: 'pass', detail: 'CloudFront and the HTTP API return the same teams/projects response.' }
    : { name: 'authenticated-api', status: 'fail', detail: 'The teams/projects responses differ between CloudFront and the HTTP API.' }
}

/**
 * Checks the user pool's MFA settings and the owner's sign-in state.
 *
 * @param mfaConfig - Output of `cognito-idp get-user-pool-mfa-config`.
 * @param owner - Output of `cognito-idp admin-get-user` for the owner, or `undefined` when unknown.
 * @returns The check results.
 */
export function checkCognitoMfa(mfaConfig: unknown, owner: unknown): readonly SmokeCheckResult[] {
  const totp = isRecord(mfaConfig) && isRecord(mfaConfig.SoftwareTokenMfaConfiguration) &&
    mfaConfig.SoftwareTokenMfaConfiguration.Enabled === true
  const mode = stringField(mfaConfig, 'MfaConfiguration')
  const results: SmokeCheckResult[] = [
    totp && (mode === 'OPTIONAL' || mode === 'ON')
      ? { name: 'cognito-mfa', status: 'pass', detail: `Authenticator (TOTP) MFA is available (${mode}).` }
      : { name: 'cognito-mfa', status: 'fail', detail: `User pool MFA is ${mode ?? 'unknown'} with TOTP ${totp ? 'on' : 'off'}.` },
  ]
  if (owner === undefined) {
    results.push({ name: 'owner-sign-in', status: 'skip', detail: 'Owner email unknown; pass --owner-email.' })
    return results
  }
  const status = stringField(owner, 'UserStatus')
  const mfa = arrayField(owner, 'UserMFASettingList').includes('SOFTWARE_TOKEN_MFA')
  if (status !== 'CONFIRMED') {
    results.push({ name: 'owner-sign-in', status: 'warn', detail: `Owner is ${status ?? 'unknown'}; sign in and change the temporary password.` })
  } else if (!mfa) {
    results.push({ name: 'owner-sign-in', status: 'warn', detail: 'Owner signed in but has no authenticator MFA; set it in Settings.' })
  } else {
    results.push({ name: 'owner-sign-in', status: 'pass', detail: 'Owner is CONFIRMED with authenticator MFA.' })
  }
  return results
}

/**
 * Checks how Cognito sends invitation and reset email.
 *
 * @param userPool - Output of `cognito-idp describe-user-pool`.
 * @param account - Output of `sesv2 get-account`, when Cognito sends through SES.
 * @param identity - Output of `sesv2 get-email-identity` for the sending identity, when known.
 * @returns The check result.
 */
export function checkCognitoEmail(userPool: unknown, account: unknown, identity: unknown): SmokeCheckResult {
  const pool = isRecord(userPool) ? userPool.UserPool : undefined
  const configuration = isRecord(pool) ? pool.EmailConfiguration : undefined
  const sendingAccount = stringField(configuration, 'EmailSendingAccount') ?? 'COGNITO_DEFAULT'
  if (sendingAccount !== 'DEVELOPER') {
    return {
      name: 'cognito-email',
      status: 'warn',
      detail: 'Cognito sends email itself (50 per day, from no-reply@verificationemail.com). Switch to SES before inviting everyone.',
    }
  }
  const production = isRecord(account) && account.ProductionAccessEnabled === true
  const verified = isRecord(identity) && identity.VerifiedForSendingStatus === true
  if (!verified) {
    return { name: 'cognito-email', status: 'fail', detail: 'Cognito uses SES, but the sending identity is not verified.' }
  }
  return production
    ? { name: 'cognito-email', status: 'pass', detail: 'Cognito sends through a verified SES identity with production access.' }
    : { name: 'cognito-email', status: 'warn', detail: 'SES is still in the sandbox; only verified addresses receive invitations.' }
}

/**
 * Returns the next time the holiday sync job runs.
 *
 * @param now - Current time.
 * @returns The next UTC time whose minute count divides by the job interval.
 */
export function nextHolidaySyncAt(now: Date): Date {
  const minutes = Math.floor(now.getTime() / 60_000)
  const next = (Math.floor(minutes / HOLIDAY_SYNC_INTERVAL_MINUTES) + 1) * HOLIDAY_SYNC_INTERVAL_MINUTES
  return new Date(next * 60_000)
}

/**
 * Returns the month in Japan for a time, as `YYYY-MM`.
 *
 * @param now - Time to convert.
 * @returns The Japan month.
 */
function japanMonth(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 7)
}

/**
 * Checks the stored Cabinet Office holiday list.
 *
 * @param item - Output of `dynamodb get-item` for the holiday record.
 * @param failures - Number of logged holiday sync failures in the last day.
 * @param now - Current time.
 * @returns The check result.
 */
export function checkHolidaySync(item: unknown, failures: number, now: Date): SmokeCheckResult {
  const record = isRecord(item) ? item.Item : undefined
  const fetchedMonth = isRecord(record) ? stringField(record.fetchedMonth, 'S') : undefined
  const failureNote = failures > 0 ? ` ${failures} failed attempt(s) in the last 24 hours.` : ''
  if (fetchedMonth === japanMonth(now)) {
    const fetchedAt = isRecord(record) ? stringField(record.fetchedAt, 'S') : undefined
    return { name: 'holiday-sync', status: 'pass', detail: `Cabinet Office list stored at ${fetchedAt ?? fetchedMonth}.${failureNote}` }
  }
  const next = nextHolidaySyncAt(now).toISOString()
  const stored = fetchedMonth === undefined ? 'No list stored yet' : `Stored list is from ${fetchedMonth}`
  return {
    name: 'holiday-sync',
    status: 'warn',
    detail: `${stored}; the bundled holidays are in use. The job next runs at ${next} once runtime control is enabled.${failureNote}`,
  }
}

/**
 * Checks dead-letter queue depths.
 *
 * @param depths - Visible plus in-flight message count per queue output name.
 * @returns The check result.
 */
export function checkDeadLetterQueues(depths: readonly (readonly [string, number | undefined])[]): SmokeCheckResult {
  const unknown = depths.filter(([, depth]) => depth === undefined).map(([name]) => name)
  const nonEmpty = depths.filter(([, depth]) => depth !== undefined && depth > 0).map(([name, depth]) => `${name}=${depth}`)
  if (nonEmpty.length > 0) {
    return { name: 'dead-letter-queues', status: 'fail', detail: `Messages waiting: ${nonEmpty.join(', ')}.` }
  }
  if (unknown.length > 0) {
    return { name: 'dead-letter-queues', status: 'fail', detail: `Could not read: ${unknown.join(', ')}.` }
  }
  return { name: 'dead-letter-queues', status: 'pass', detail: `${depths.length} queues are empty.` }
}

/**
 * Picks the dead-letter queues out of a stack's resources.
 *
 * @param resources - Output of `cloudformation list-stack-resources`.
 * @returns Logical ID and queue URL of each queue whose logical ID names a DLQ.
 */
export function selectDeadLetterQueues(resources: unknown): readonly (readonly [string, string])[] {
  const queues: (readonly [string, string])[] = []
  for (const resource of arrayField(resources, 'StackResourceSummaries')) {
    if (stringField(resource, 'ResourceType') !== 'AWS::SQS::Queue') continue
    const logicalId = stringField(resource, 'LogicalResourceId')
    // An SQS queue's physical ID is its URL.
    const url = stringField(resource, 'PhysicalResourceId')
    if (logicalId === undefined || url === undefined || !/dlq|deadletter/i.test(logicalId)) continue
    queues.push([logicalId, url])
  }
  return queues
}

/**
 * Checks alarms that are firing.
 *
 * @param alarms - Output of `cloudwatch describe-alarms --state-value ALARM`.
 * @returns The check result.
 */
export function checkAlarms(alarms: unknown): SmokeCheckResult {
  const names = arrayField(alarms, 'MetricAlarms')
    .concat(arrayField(alarms, 'CompositeAlarms'))
    .map((alarm) => stringField(alarm, 'AlarmName'))
    .filter((name): name is string => name !== undefined)
  return names.length === 0
    ? { name: 'alarms', status: 'pass', detail: 'No stack alarm is in ALARM.' }
    : { name: 'alarms', status: 'fail', detail: `In ALARM: ${names.join(', ')}.` }
}

/**
 * Checks that each alarm topic has a confirmed subscription.
 *
 * @param topics - Subscriptions per topic name, from `sns list-subscriptions-by-topic`.
 * @returns The check result.
 */
export function checkAlarmSubscriptions(topics: readonly (readonly [string, unknown])[]): SmokeCheckResult {
  const problems: string[] = []
  for (const [topic, output] of topics) {
    const arns = arrayField(output, 'Subscriptions').map((subscription) => stringField(subscription, 'SubscriptionArn'))
    const confirmed = arns.filter((arn) => arn !== undefined && arn.startsWith('arn:')).length
    if (confirmed === 0) {
      problems.push(arns.length === 0 ? `${topic} has no subscription` : `${topic} is waiting for confirmation`)
    }
  }
  return problems.length === 0
    ? { name: 'alarm-subscriptions', status: 'pass', detail: `${topics.length} alarm topics have a confirmed subscription.` }
    : { name: 'alarm-subscriptions', status: 'fail', detail: `${problems.join('; ')}. Press Confirm subscription in the SNS email.` }
}

/**
 * Checks the latest AppConfig deployment of the runtime-control environment.
 *
 * @param deployments - Output of `appconfig list-deployments`.
 * @returns The check result.
 */
export function checkAppConfigDeployment(deployments: unknown): SmokeCheckResult {
  let latest: Record<string, unknown> | undefined
  for (const item of arrayField(deployments, 'Items')) {
    if (!isRecord(item) || typeof item.DeploymentNumber !== 'number') continue
    if (latest === undefined || (typeof latest.DeploymentNumber === 'number' && item.DeploymentNumber > latest.DeploymentNumber)) {
      latest = item
    }
  }
  if (latest === undefined) {
    // The stack deploys the first (disabled) document itself, so an empty list means it did not finish.
    return { name: 'appconfig-deployment', status: 'fail', detail: 'No AppConfig deployment; the stack should have deployed the first document.' }
  }
  const state = stringField(latest, 'State') ?? 'unknown'
  const number = String(latest.DeploymentNumber)
  if (state === 'COMPLETE') return { name: 'appconfig-deployment', status: 'pass', detail: `Deployment ${number} is COMPLETE.` }
  if (state === 'ROLLED_BACK') return { name: 'appconfig-deployment', status: 'fail', detail: `Deployment ${number} was ROLLED_BACK.` }
  return { name: 'appconfig-deployment', status: 'warn', detail: `Deployment ${number} is ${state}; run the smoke test again after it completes.` }
}

/**
 * Reads the stack status and outputs.
 *
 * @param dependencies - Side effects.
 * @param environment - Region and stack name.
 * @returns The status and the outputs by key.
 */
async function readStack(
  dependencies: SmokeDependencies,
  environment: SmokeEnvironment,
): Promise<{ readonly status: string; readonly outputs: ReadonlyMap<string, string> }> {
  const described = await awsJson(dependencies, [
    'cloudformation', 'describe-stacks', '--region', environment.region, '--stack-name', environment.stackName,
  ])
  const stack = arrayField(described, 'Stacks')[0]
  const outputs = new Map<string, string>()
  for (const output of arrayField(stack, 'Outputs')) {
    const key = stringField(output, 'OutputKey')
    const value = stringField(output, 'OutputValue')
    if (key !== undefined && value !== undefined) outputs.set(key, value)
  }
  return { status: stringField(stack, 'StackStatus') ?? 'unknown', outputs }
}

/**
 * Tells a single result from a list of results.
 *
 * @param value - One result or a list.
 * @returns Whether the value is one result.
 */
function isSingleResult(value: SmokeCheckResult | readonly SmokeCheckResult[]): value is SmokeCheckResult {
  return 'name' in value
}

/**
 * Runs one AWS-backed check, turning a CLI failure into a failed result.
 *
 * @param name - Check name used when the CLI fails.
 * @param run - Check body.
 * @returns The check results.
 */
async function guarded(
  name: string,
  run: () => Promise<SmokeCheckResult | readonly SmokeCheckResult[]>,
): Promise<readonly SmokeCheckResult[]> {
  try {
    const result = await run()
    return isSingleResult(result) ? [result] : result
  } catch (error) {
    return [{ name, status: 'fail', detail: describeError(error) }]
  }
}

/**
 * Runs the HTTP checks against the Web URL.
 *
 * @param request - Parsed request.
 * @param webUrl - Canonical Web URL.
 * @param dependencies - Side effects.
 * @returns The results and the commit `/api/health` reported.
 */
async function runHttpChecks(
  request: SmokeRequest,
  webUrl: string,
  dependencies: SmokeDependencies,
): Promise<{ readonly results: readonly SmokeCheckResult[]; readonly commit: string | undefined }> {
  const [root, spa, unknownApi, health, ready, maintenance] = await Promise.all([
    dependencies.get(joinUrl(webUrl, '/')),
    dependencies.get(joinUrl(webUrl, '/login')),
    dependencies.get(joinUrl(webUrl, '/api/post-deploy-smoke-not-found')),
    dependencies.get(joinUrl(webUrl, '/api/health')),
    dependencies.get(joinUrl(webUrl, '/api/ready')),
    dependencies.get(joinUrl(webUrl, '/api/maintenance')),
  ])
  const healthCheck = checkHealth('api-health', health, request.expectCommit)
  return {
    results: [
      ...checkWebRoot(root),
      checkSpaRoute(spa),
      healthCheck.result,
      ...checkApiNotRewritten(unknownApi),
      checkRuntimeMode(request.runtime, ready, maintenance),
    ],
    commit: healthCheck.commit,
  }
}

/**
 * Compares the owner's `teams/projects` response through every route.
 *
 * @param webUrl - Canonical Web URL.
 * @param apiGatewayUrl - HTTP API URL, when known.
 * @param accessToken - Fresh owner access token.
 * @param dependencies - Side effects.
 * @returns The check result.
 */
async function runAuthenticatedCheck(
  webUrl: string,
  apiGatewayUrl: string | undefined,
  accessToken: string,
  dependencies: SmokeDependencies,
): Promise<SmokeCheckResult> {
  const headers = { Authorization: `Bearer ${accessToken}` }
  const targets: (readonly [string, string])[] = [['CloudFront /api/teams/projects', joinUrl(webUrl, '/api/teams/projects')]]
  if (apiGatewayUrl !== undefined) {
    targets.push(['HTTP API /teams/projects', joinUrl(apiGatewayUrl, '/teams/projects')])
    targets.push(['HTTP API /api/teams/projects', joinUrl(apiGatewayUrl, '/api/teams/projects')])
  }
  const responses = await Promise.all(targets.map(async ([label, url]): Promise<readonly [string, SmokeHttpResponse | undefined]> =>
    [label, await dependencies.get(url, headers)]))
  return checkAuthenticatedPaths(responses)
}

/**
 * Reads one SSM string parameter.
 *
 * @param dependencies - Side effects.
 * @param region - AWS region.
 * @param name - Parameter name.
 * @returns The value.
 */
async function readParameter(dependencies: SmokeDependencies, region: string, name: string): Promise<string> {
  const output = await awsJson(dependencies, ['ssm', 'get-parameter', '--region', region, '--name', name])
  const parameter = isRecord(output) ? output.Parameter : undefined
  const value = stringField(parameter, 'Value')
  if (value === undefined) throw new SmokeError(`SSM ${name} has no value.`)
  return value
}

/**
 * Runs the AWS-backed checks.
 *
 * @param request - Parsed request.
 * @param environment - Region and stack name.
 * @param outputs - Stack outputs.
 * @param apiCommit - Commit that `/api/health` reported.
 * @param dependencies - Side effects.
 * @returns The check results.
 */
async function runAwsChecks(
  request: SmokeRequest,
  environment: SmokeEnvironment,
  outputs: ReadonlyMap<string, string>,
  apiCommit: string | undefined,
  dependencies: SmokeDependencies,
): Promise<readonly SmokeCheckResult[]> {
  const region = environment.region
  const output = (key: string): string => {
    const value = outputs.get(key)
    if (!value) throw new SmokeError(`Stack has no ${key} output.`)
    return value
  }
  const checks: Promise<readonly SmokeCheckResult[]>[] = []

  checks.push(guarded('api-gateway-health', async () => {
    const response = await dependencies.get(joinUrl(output('ApiGatewayUrl'), '/api/health'))
    return checkHealth('api-gateway-health', response, request.expectCommit ?? apiCommit).result
  }))

  checks.push(guarded('web-bucket-private', async () => {
    const response = await dependencies.get(`https://${output('WebBucketName')}.s3.${region}.amazonaws.com/index.html`)
    return response !== undefined && response.status === 403
      ? { name: 'web-bucket-private', status: 'pass', detail: 'The Web bucket refuses direct reads (403).' }
      : { name: 'web-bucket-private', status: 'fail', detail: `A direct bucket read returned ${response?.status ?? 'no response'}, not 403.` }
  }))

  checks.push(guarded('web-release', async () => {
    const commit = request.expectCommit ?? apiCommit
    if (commit === undefined) return { name: 'web-release', status: 'skip', detail: 'No commit to look for.' }
    await dependencies.aws([
      's3api', 'head-object', '--region', region, '--bucket', output('WebBucketName'),
      '--key', `releases/${commit}/index.html`, '--output', 'json',
    ])
    return { name: 'web-release', status: 'pass', detail: `Web release ${commit.slice(0, 12)} is kept for rollback.` }
  }))

  checks.push(guarded('appconfig-deployment', async () => checkAppConfigDeployment(await awsJson(dependencies, [
    'appconfig', 'list-deployments', '--region', region,
    '--application-id', output('RuntimeControlApplicationId'),
    '--environment-id', output('RuntimeControlEnvironmentId'),
  ]))))

  checks.push(guarded('cognito-mfa', async () => {
    const userPoolId = output('UserPoolId')
    const mfa = await awsJson(dependencies, ['cognito-idp', 'get-user-pool-mfa-config', '--region', region, '--user-pool-id', userPoolId])
    let email = request.ownerEmail
    if (email === undefined) {
      try {
        email = await readParameter(dependencies, region, OWNER_EMAIL_PARAMETER)
      } catch {
        email = undefined
      }
    }
    const owner = email === undefined
      ? undefined
      : await awsJson(dependencies, ['cognito-idp', 'admin-get-user', '--region', region, '--user-pool-id', userPoolId, '--username', email])
    return checkCognitoMfa(mfa, owner)
  }))

  checks.push(guarded('cognito-email', async () => {
    const userPool = await awsJson(dependencies, ['cognito-idp', 'describe-user-pool', '--region', region, '--user-pool-id', output('UserPoolId')])
    const pool = isRecord(userPool) ? userPool.UserPool : undefined
    const configuration = isRecord(pool) ? pool.EmailConfiguration : undefined
    if (stringField(configuration, 'EmailSendingAccount') !== 'DEVELOPER') return checkCognitoEmail(userPool, undefined, undefined)
    const account = await awsJson(dependencies, ['sesv2', 'get-account', '--region', region])
    const sourceArn = stringField(configuration, 'SourceArn') ?? ''
    const identityName = sourceArn.split(':identity/')[1]
    const identity = identityName === undefined
      ? undefined
      : await awsJson(dependencies, ['sesv2', 'get-email-identity', '--region', region, '--email-identity', identityName])
    return checkCognitoEmail(userPool, account, identity)
  }))

  checks.push(guarded('holiday-sync', async () => {
    const item = await awsJson(dependencies, [
      'dynamodb', 'get-item', '--region', region, '--table-name', output('TenantAdministrationTableName'),
      '--key', HOLIDAY_RECORD_KEY, '--projection-expression', 'fetchedMonth, fetchedAt',
    ])
    const configuration = await awsJson(dependencies, [
      'lambda', 'get-function-configuration', '--region', region, '--function-name', output('ScheduledJobsFunctionName'),
    ])
    const logging = isRecord(configuration) ? configuration.LoggingConfig : undefined
    const logGroup = stringField(logging, 'LogGroup') ?? `/aws/lambda/${output('ScheduledJobsFunctionName')}`
    const events = await awsJson(dependencies, [
      'logs', 'filter-log-events', '--region', region, '--log-group-name', logGroup,
      '--start-time', String(dependencies.now().getTime() - 24 * 60 * 60_000),
      // Lambda's text log format prefixes the JSON line, so match its terms instead of JSON fields.
      '--filter-pattern', '"Scheduled job failed" "japanese-public-holiday-sync"',
    ])
    return checkHolidaySync(item, arrayField(events, 'events').length, dependencies.now())
  }))

  checks.push(guarded('dead-letter-queues', async () => {
    // Not every DLQ has a stack output (for example the audit export DLQ), so list the stack's queues.
    const queues = selectDeadLetterQueues(await awsJson(dependencies, [
      'cloudformation', 'list-stack-resources', '--region', region, '--stack-name', environment.stackName,
    ]))
    const depths = await Promise.all(queues.map(async ([key, url]): Promise<readonly [string, number | undefined]> => {
      try {
        const attributes = await awsJson(dependencies, [
          'sqs', 'get-queue-attributes', '--region', region, '--queue-url', url,
          '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
        ])
        const values = isRecord(attributes) ? attributes.Attributes : undefined
        const visible = Number(stringField(values, 'ApproximateNumberOfMessages'))
        const inFlight = Number(stringField(values, 'ApproximateNumberOfMessagesNotVisible') ?? '0')
        return [key, Number.isFinite(visible) && Number.isFinite(inFlight) ? visible + inFlight : undefined]
      } catch {
        return [key, undefined]
      }
    }))
    return checkDeadLetterQueues(depths)
  }))

  checks.push(guarded('alarms', async () => checkAlarms(await awsJson(dependencies, [
    'cloudwatch', 'describe-alarms', '--region', region, '--state-value', 'ALARM',
    '--alarm-name-prefix', `${environment.stackName}-`,
  ]))))

  checks.push(guarded('alarm-subscriptions', async () => {
    const identity = await awsJson(dependencies, ['sts', 'get-caller-identity'])
    const account = stringField(identity, 'Account')
    if (account === undefined) throw new SmokeError('sts get-caller-identity returned no Account.')
    const topics = await Promise.all(ALARM_TOPIC_PARAMETERS.map(async (parameter): Promise<readonly [string, unknown]> => {
      const topic = await readParameter(dependencies, region, parameter)
      const subscriptions = await awsJson(dependencies, [
        'sns', 'list-subscriptions-by-topic', '--region', region, '--topic-arn', `arn:aws:sns:${region}:${account}:${topic}`,
      ])
      return [topic, subscriptions]
    }))
    return checkAlarmSubscriptions(topics)
  }))

  return (await Promise.all(checks)).flat()
}

/**
 * Runs every check and returns the results in a stable order.
 *
 * @param request - Parsed request.
 * @param environment - Settings read from the environment.
 * @param dependencies - Side effects.
 * @returns The check results.
 * @throws SmokeError when neither the stack nor `MUKUROJI_WEB_URL` gives a Web URL.
 */
export async function runPostDeploySmoke(
  request: SmokeRequest,
  environment: SmokeEnvironment,
  dependencies: SmokeDependencies,
): Promise<readonly SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = []
  let outputs: ReadonlyMap<string, string> = new Map()
  let webUrl = environment.webUrl
  if (!request.skipAws) {
    if (!environment.region) throw new SmokeError('AWS_REGION is required unless --skip-aws is given.')
    const stack = await readStack(dependencies, environment)
    outputs = stack.outputs
    results.push(STACK_COMPLETE_STATES.has(stack.status)
      ? { name: 'stack', status: 'pass', detail: `${environment.stackName} is ${stack.status}.` }
      : { name: 'stack', status: 'fail', detail: `${environment.stackName} is ${stack.status}.` })
    webUrl = outputs.get('WebUrl') ?? webUrl
  }
  if (!webUrl) throw new SmokeError('No WebUrl: deploy the stack, or set MUKUROJI_WEB_URL with --skip-aws.')
  const http = await runHttpChecks(request, webUrl, dependencies)
  results.push(...http.results)
  if (environment.accessToken) {
    results.push(await runAuthenticatedCheck(webUrl, outputs.get('ApiGatewayUrl'), environment.accessToken, dependencies))
  } else {
    results.push({ name: 'authenticated-api', status: 'skip', detail: 'Set MUKUROJI_SMOKE_ACCESS_TOKEN to a fresh owner access token.' })
  }
  if (!request.skipAws) results.push(...await runAwsChecks(request, environment, outputs, http.commit, dependencies))
  return results
}

/**
 * Formats results as aligned lines.
 *
 * @param results - Check results.
 * @returns The printable report.
 */
export function formatSmokeReport(results: readonly SmokeCheckResult[]): string {
  const width = Math.max(...results.map((result) => result.name.length))
  const lines = results.map((result) => `${result.status.toUpperCase().padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}`)
  const count = (status: SmokeCheckStatus): number => results.filter((result) => result.status === status).length
  lines.push('', `${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail, ${count('skip')} skip`)
  return lines.join('\n')
}

/**
 * Runs one `aws` CLI command and returns its standard output.
 *
 * @param args - Arguments after `aws`.
 * @returns Standard output.
 * @throws SmokeError with the CLI's error output when the command fails.
 */
async function runAws(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['aws', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new SmokeError(`aws ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`)
  return stdout
}

/**
 * Sends a GET request without following redirects or caching.
 *
 * @param url - URL to request.
 * @param headers - Extra request headers.
 * @returns The response, or `undefined` when the request failed.
 */
async function requestUrl(url: string, headers: Readonly<Record<string, string>> = {}): Promise<SmokeHttpResponse | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual', headers, signal: AbortSignal.timeout(10_000) })
    const responseHeaders = new Map<string, string>()
    response.headers.forEach((value, key) => {
      responseHeaders.set(key.toLowerCase(), value)
    })
    return { status: response.status, headers: responseHeaders, body: await response.text() }
  } catch {
    return undefined
  }
}

/**
 * Entry point for `bun run deploy:smoke`.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  try {
    const request = parseSmokeArguments(process.argv.slice(2))
    const results = await runPostDeploySmoke(request, {
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '',
      stackName: process.env.MUKUROJI_STACK_NAME ?? 'Mukuroji',
      webUrl: process.env.MUKUROJI_WEB_URL,
      accessToken: process.env.MUKUROJI_SMOKE_ACCESS_TOKEN,
    }, { aws: runAws, get: requestUrl, now: () => new Date() })
    console.log(formatSmokeReport(results))
    return results.some((result) => result.status === 'fail') ? 1 : 0
  } catch (error) {
    if (error instanceof SmokeError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

if (import.meta.main) process.exit(await main())
