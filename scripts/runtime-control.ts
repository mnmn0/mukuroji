/**
 * Enables or stops application processing by deploying a new runtime-control document to AWS AppConfig.
 *
 * Usage:
 *   AWS_REGION=ap-northeast-1 bun run runtime-control:enable
 *   AWS_REGION=ap-northeast-1 bun run runtime-control:disable
 *   AWS_REGION=ap-northeast-1 bun run runtime-control:disable --all-at-once
 *   AWS_REGION=ap-northeast-1 bun run runtime-control:read-only
 *
 * The script reads the AppConfig identifiers and the Web URL from the stack outputs, creates a hosted
 * configuration version with the next revision, starts the deployment, waits until AppConfig reports
 * it complete, and then checks that `/api/ready` and `/api/maintenance` match the new mode. It calls the `aws` CLI, so the
 * caller's normal AWS credentials and `AWS_ENDPOINT_URL` (for an emulator) apply.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runtime-control mode that the hosted configuration schema accepts. */
export type RuntimeControlMode = 'enabled' | 'disabled' | 'read-only'

/**
 * Parsed command-line request.
 */
export interface RuntimeControlRequest {
  /** Mode to deploy. */
  readonly mode: RuntimeControlMode
  /** Whether to use `AppConfig.AllAtOnce` instead of the stack's canary strategy. */
  readonly allAtOnce: boolean
}

/**
 * Stack outputs and resources that the operation needs.
 */
export interface RuntimeControlTarget {
  /** AppConfig application identifier. */
  readonly applicationId: string
  /** AppConfig environment identifier. */
  readonly environmentId: string
  /** Hosted configuration profile identifier. */
  readonly configurationProfileId: string
  /** Canary deployment strategy identifier owned by the stack. */
  readonly canaryDeploymentStrategyId: string
  /** Canonical Web URL; `/api/ready` is reached through it. */
  readonly webUrl: string
}

/**
 * Side effects used by {@link runRuntimeControl}, replaceable in tests.
 */
export interface RuntimeControlDependencies {
  /**
   * Runs one `aws` CLI command.
   *
   * @param args - Arguments after `aws`.
   * @returns The command's standard output.
   */
  readonly aws: (args: readonly string[]) => Promise<string>
  /**
   * Requests a URL and returns the HTTP status.
   *
   * @param url - URL to request.
   * @returns The status code, or `undefined` when the request failed.
   */
  readonly httpStatus: (url: string) => Promise<number | undefined>
  /**
   * Reads the `state` that `GET /api/maintenance` reports.
   *
   * @param url - Maintenance status URL.
   * @returns The reported state, or `undefined` when the request or its body failed.
   */
  readonly maintenanceState: (url: string) => Promise<string | undefined>
  /**
   * Reads a file that an `aws` command wrote.
   *
   * @param path - File path.
   * @returns The file content.
   */
  readonly readText: (path: string) => Promise<string>
  /**
   * Writes a file that an `aws` command reads.
   *
   * @param path - File path.
   * @param content - File content.
   */
  readonly writeText: (path: string, content: string) => Promise<void>
  /** Directory for the temporary document files. */
  readonly workDirectory: string
  /**
   * Waits before the next poll.
   *
   * @param milliseconds - Time to wait.
   */
  readonly sleep: (milliseconds: number) => Promise<void>
  /**
   * Returns the current time.
   *
   * @returns The current time.
   */
  readonly now: () => Date
  /**
   * Prints one progress line.
   *
   * @param line - Text to print.
   */
  readonly log: (line: string) => void
}

/**
 * Timing used while waiting; shortened in tests.
 */
export interface RuntimeControlTiming {
  /** Interval between deployment state polls. */
  readonly deploymentPollMilliseconds: number
  /** Longest wait for the deployment to finish. */
  readonly deploymentTimeoutMilliseconds: number
  /** Interval between `/api/ready` checks. */
  readonly readyPollMilliseconds: number
  /** Longest wait for `/api/ready` to match the new mode. */
  readonly readyTimeoutMilliseconds: number
}

/**
 * Outcome of a completed operation.
 */
export interface RuntimeControlResult {
  /** Revision written into the new document. */
  readonly revision: number
  /** Hosted configuration version number that AppConfig assigned. */
  readonly versionNumber: number
  /** Deployment number that AppConfig assigned. */
  readonly deploymentNumber: number
  /** Last `/api/ready` status observed. */
  readonly readyStatus: number | undefined
}

/** Error for a request the script refuses, printed without a stack trace. */
export class RuntimeControlError extends Error {}

/** Predefined AppConfig strategy that deploys to every target at once (it still bakes for 10 minutes). */
const allAtOnceStrategyId = 'AppConfig.AllAtOnce'

/** AppConfig limits hosted version and deployment descriptions to 1,024 characters. */
const maximumDescriptionLength = 1024

/** Default waits: the canary strategy rolls out for 20 minutes and bakes for 10. */
const defaultTiming: RuntimeControlTiming = {
  deploymentPollMilliseconds: 15_000,
  deploymentTimeoutMilliseconds: 45 * 60_000,
  readyPollMilliseconds: 10_000,
  // Runtimes poll at least every 15 seconds and may keep an enabled snapshot for 60 seconds.
  readyTimeoutMilliseconds: 3 * 60_000,
}

const usage = [
  'Usage: bun scripts/runtime-control.ts <enable|disable|read-only> [--all-at-once]',
  '  enable          Deploy mode "enabled" with the stack canary strategy (about 30 minutes).',
  '  disable         Deploy mode "disabled" with the stack canary strategy.',
  '  read-only       Deploy mode "read-only": reads keep working and changes are rejected.',
  '  --all-at-once   Use AppConfig.AllAtOnce, for an emergency stop decided by the incident commander.',
].join('\n')

/** Mode deployed by each command-line command. */
const commandModes: Readonly<Record<string, RuntimeControlMode>> = Object.freeze({
  enable: 'enabled',
  disable: 'disabled',
  'read-only': 'read-only',
})

/**
 * Parses the command-line arguments.
 *
 * @param argv - Arguments after the script path.
 * @returns The requested operation.
 * @throws RuntimeControlError when the arguments are not understood.
 */
export function parseRuntimeControlArguments(argv: readonly string[]): RuntimeControlRequest {
  let mode: RuntimeControlMode | undefined
  let allAtOnce = false
  for (const argument of argv) {
    const commandMode = Object.hasOwn(commandModes, argument) ? commandModes[argument] : undefined
    if (commandMode !== undefined) {
      if (mode !== undefined) throw new RuntimeControlError(`Pass one of enable, disable, or read-only once.\n${usage}`)
      mode = commandMode
    } else if (argument === '--all-at-once') {
      allAtOnce = true
    } else {
      throw new RuntimeControlError(`Unknown argument: ${argument}\n${usage}`)
    }
  }
  if (mode === undefined) throw new RuntimeControlError(usage)
  return { mode, allAtOnce }
}

/**
 * Reads the revision from a stored runtime-control document.
 *
 * @param content - JSON text of a hosted configuration version.
 * @returns The document's revision.
 * @throws RuntimeControlError when the document is not a valid runtime-control document.
 */
export function readDocumentRevision(content: string): number {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    throw new RuntimeControlError('The latest hosted configuration version is not JSON.')
  }
  if (typeof document !== 'object' || document === null || !('revision' in document)) {
    throw new RuntimeControlError('The latest hosted configuration version has no revision.')
  }
  const revision = document.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new RuntimeControlError('The latest hosted configuration version has an invalid revision.')
  }
  return revision
}

/**
 * Builds the document that the hosted configuration profile's JSON Schema accepts.
 *
 * @param mode - Mode to deploy.
 * @param revision - Audit sequence, one higher than the latest stored version.
 * @returns The JSON text to store.
 */
export function buildRuntimeControlDocument(mode: RuntimeControlMode, revision: number): string {
  return JSON.stringify({ schemaVersion: 1, mode, revision })
}

/**
 * Classifies an AppConfig deployment state.
 *
 * @param state - `State` from `get-deployment`.
 * @returns `complete` when finished, `failed` when rolled back, otherwise `pending`.
 */
export function classifyDeploymentState(state: string): 'complete' | 'failed' | 'pending' {
  if (state === 'COMPLETE') return 'complete'
  if (state === 'ROLLED_BACK' || state === 'REVERTED' || state === 'ROLLING_BACK') return 'failed'
  return 'pending'
}

/**
 * Tells whether `/api/ready` reflects the deployed mode.
 *
 * @param mode - Deployed mode.
 * @param status - HTTP status from `/api/ready`, or `undefined` when unreachable.
 * @returns True for 200 after enabling, and 503 after disabling or switching to read-only, which
 * does not admit new traffic as fully ready.
 */
export function readyMatchesMode(mode: RuntimeControlMode, status: number | undefined): boolean {
  return mode === 'enabled' ? status === 200 : status === 503
}

/**
 * Tells whether `GET /api/maintenance` reflects the deployed mode.
 *
 * @param mode - Deployed mode.
 * @param state - Reported maintenance state, or `undefined` when unreadable.
 * @returns True when the API reports the state that the mode produces.
 */
export function maintenanceMatchesMode(mode: RuntimeControlMode, state: string | undefined): boolean {
  const expected = mode === 'enabled' ? 'none' : mode === 'read-only' ? 'read-only' : 'stopped'
  return state === expected
}

/**
 * Builds the description stored on the hosted version and the deployment, so AppConfig keeps who changed what.
 *
 * @param mode - Deployed mode.
 * @param revision - Deployed revision.
 * @param caller - Caller identity ARN.
 * @param at - Time of the change.
 * @returns A description within AppConfig's length limit.
 */
export function buildChangeDescription(mode: RuntimeControlMode, revision: number, caller: string, at: Date): string {
  const description = `mode=${mode} revision=${revision} by ${caller} at ${at.toISOString()} via bun run runtime-control`
  return description.slice(0, maximumDescriptionLength)
}

/**
 * Parses JSON printed by the `aws` CLI.
 *
 * @param output - Standard output of an `aws` command run with `--output json`.
 * @param command - Command name for the error message.
 * @returns The parsed value.
 * @throws RuntimeControlError when the output is not JSON.
 */
function parseJson(output: string, command: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new RuntimeControlError(`aws ${command} did not print JSON.`)
  }
}

/**
 * Parses JSON printed by the `aws` CLI into an object.
 *
 * @param output - Standard output of an `aws` command run with `--output json`.
 * @param command - Command name for the error message.
 * @returns The parsed object.
 */
function parseObject(output: string, command: string): Record<string, unknown> {
  const value = parseJson(output, command)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeControlError(`aws ${command} did not return an object.`)
  }
  return Object.fromEntries(Object.entries(value))
}

/**
 * Reads a required numeric field from parsed CLI output.
 *
 * @param object - Parsed CLI output.
 * @param key - Field name.
 * @param command - Command name for the error message.
 * @returns The number.
 */
function requireNumber(object: Record<string, unknown>, key: string, command: string): number {
  const value = object[key]
  if (typeof value !== 'number') throw new RuntimeControlError(`aws ${command} returned no ${key}.`)
  return value
}

/**
 * Reads a stack's outputs into the identifiers the operation needs.
 *
 * @param aws - CLI runner.
 * @param region - AWS region.
 * @param stackName - CloudFormation stack name.
 * @returns The target identifiers.
 */
async function readTarget(
  aws: RuntimeControlDependencies['aws'],
  region: string,
  stackName: string,
): Promise<RuntimeControlTarget> {
  const output = await aws([
    'cloudformation', 'describe-stacks', '--region', region, '--stack-name', stackName,
    '--query', 'Stacks[0].Outputs', '--output', 'json',
  ])
  const parsed = parseJson(output, 'cloudformation describe-stacks')
  const outputs = new Map<string, string>()
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const key: unknown = 'OutputKey' in entry ? entry.OutputKey : undefined
      const value: unknown = 'OutputValue' in entry ? entry.OutputValue : undefined
      if (typeof key === 'string' && typeof value === 'string') outputs.set(key, value)
    }
  }
  const required = (key: string): string => {
    const value = outputs.get(key)
    if (!value) throw new RuntimeControlError(`Stack ${stackName} has no ${key} output. Deploy the stack first.`)
    return value
  }
  return {
    applicationId: required('RuntimeControlApplicationId'),
    environmentId: required('RuntimeControlEnvironmentId'),
    configurationProfileId: required('RuntimeControlConfigurationProfileId'),
    canaryDeploymentStrategyId: required('RuntimeControlCanaryDeploymentStrategyId'),
    webUrl: required('WebUrl').replace(/\/+$/, ''),
  }
}

/**
 * Checks the stack's configuration failure alarm before re-enabling, as the operations guide requires.
 *
 * @param aws - CLI runner.
 * @param region - AWS region.
 * @param stackName - CloudFormation stack name.
 * @throws RuntimeControlError unless exactly one alarm is `OK` with actions enabled.
 */
async function assertAlarmReady(
  aws: RuntimeControlDependencies['aws'],
  region: string,
  stackName: string,
): Promise<void> {
  const alarmNames = parseJson(await aws([
    // describe-stack-resources returns only the first 100 resources; the CLI pages list-stack-resources
    // and applies a JSON --query to the merged result.
    'cloudformation', 'list-stack-resources', '--region', region, '--stack-name', stackName,
    '--query',
    "StackResourceSummaries[?ResourceType=='AWS::CloudWatch::Alarm' && starts_with(LogicalResourceId, 'RuntimeControlConfigurationFailureAlarm')].PhysicalResourceId",
    '--output', 'json',
  ]), 'cloudformation list-stack-resources')
  if (!Array.isArray(alarmNames) || alarmNames.length !== 1 || typeof alarmNames[0] !== 'string') {
    throw new RuntimeControlError('Could not find exactly one RuntimeControlConfigurationFailureAlarm in the stack.')
  }
  const alarmName = alarmNames[0]
  const alarms = parseJson(await aws([
    'cloudwatch', 'describe-alarms', '--region', region, '--alarm-names', alarmName,
    '--query', 'MetricAlarms[].[StateValue, ActionsEnabled]', '--output', 'json',
  ]), 'cloudwatch describe-alarms')
  const alarm: unknown = Array.isArray(alarms) && alarms.length === 1 ? alarms[0] : undefined
  if (!Array.isArray(alarm) || alarm[0] !== 'OK' || alarm[1] !== true) {
    throw new RuntimeControlError(
      `Alarm ${alarmName} must be OK with actions enabled before enabling (got ${JSON.stringify(alarms)}).`,
    )
  }
}

/**
 * Creates and deploys a runtime-control document, waits for AppConfig, and checks `/api/ready`.
 *
 * @param request - Mode and strategy to use.
 * @param region - AWS region.
 * @param stackName - CloudFormation stack name.
 * @param dependencies - Side effects.
 * @param timing - Poll intervals and limits.
 * @returns The stored revision, version, deployment, and last readiness status.
 * @throws RuntimeControlError when a precondition fails, the deployment rolls back, or a wait times out.
 */
export async function runRuntimeControl(
  request: RuntimeControlRequest,
  region: string,
  stackName: string,
  dependencies: RuntimeControlDependencies,
  timing: RuntimeControlTiming = defaultTiming,
): Promise<RuntimeControlResult> {
  const { aws, log } = dependencies
  const target = await readTarget(aws, region, stackName)
  const appconfig = (command: string, ...args: string[]): Promise<string> =>
    aws(['appconfig', command, '--region', region, '--application-id', target.applicationId, ...args])

  const environment = parseObject(
    await appconfig('get-environment', '--environment-id', target.environmentId, '--output', 'json'),
    'appconfig get-environment',
  )
  if (environment.State === 'DEPLOYING' || environment.State === 'ROLLING_BACK') {
    throw new RuntimeControlError(`AppConfig environment is ${environment.State}. Wait for that deployment to finish.`)
  }

  if (request.mode === 'enabled') await assertAlarmReady(aws, region, stackName)

  const versionNumbers = parseJson(await appconfig(
    'list-hosted-configuration-versions', '--configuration-profile-id', target.configurationProfileId,
    '--query', 'Items[].VersionNumber', '--output', 'json',
  ), 'appconfig list-hosted-configuration-versions')
  const latestVersion = Array.isArray(versionNumbers)
    ? Math.max(0, ...versionNumbers.filter((value): value is number => typeof value === 'number'))
    : 0
  if (latestVersion === 0) throw new RuntimeControlError('The configuration profile has no hosted version. Deploy the stack first.')

  const latestPath = join(dependencies.workDirectory, 'latest.json')
  await appconfig(
    'get-hosted-configuration-version', '--configuration-profile-id', target.configurationProfileId,
    '--version-number', String(latestVersion), '--output', 'json', latestPath,
  )
  const revision = readDocumentRevision(await dependencies.readText(latestPath)) + 1

  const caller = (await aws(['sts', 'get-caller-identity', '--region', region, '--query', 'Arn', '--output', 'text'])).trim()
  const description = buildChangeDescription(request.mode, revision, caller, dependencies.now())
  const documentPath = join(dependencies.workDirectory, 'runtime-control.json')
  await dependencies.writeText(documentPath, buildRuntimeControlDocument(request.mode, revision))
  const created = parseObject(await appconfig(
    'create-hosted-configuration-version', '--configuration-profile-id', target.configurationProfileId,
    '--content-type', 'application/json', '--content', `fileb://${documentPath}`,
    '--description', description, '--output', 'json', join(dependencies.workDirectory, 'created.json'),
  ), 'appconfig create-hosted-configuration-version')
  const versionNumber = requireNumber(created, 'VersionNumber', 'appconfig create-hosted-configuration-version')
  log(`Created hosted version ${versionNumber} (mode=${request.mode}, revision=${revision}).`)

  const strategyId = request.allAtOnce ? allAtOnceStrategyId : target.canaryDeploymentStrategyId
  if (request.allAtOnce) log('Using AppConfig.AllAtOnce. Record why the staged rollout was skipped in the change record.')
  const started = parseObject(await appconfig(
    'start-deployment', '--environment-id', target.environmentId,
    '--configuration-profile-id', target.configurationProfileId,
    '--configuration-version', String(versionNumber), '--deployment-strategy-id', strategyId,
    '--description', description, '--output', 'json',
  ), 'appconfig start-deployment')
  const deploymentNumber = requireNumber(started, 'DeploymentNumber', 'appconfig start-deployment')
  const expectedWait = request.allAtOnce ? 'about 10 minutes of bake' : 'about 30 minutes for the canary and bake'
  log(`Started deployment ${deploymentNumber}. Waiting for AppConfig to finish (${expectedWait}).`)

  const deploymentDeadline = dependencies.now().getTime() + timing.deploymentTimeoutMilliseconds
  let state = typeof started.State === 'string' ? started.State : 'DEPLOYING'
  let lastReported = ''
  while (classifyDeploymentState(state) === 'pending') {
    if (dependencies.now().getTime() > deploymentDeadline) {
      throw new RuntimeControlError(`Deployment ${deploymentNumber} is still ${state}. Check it with aws appconfig get-deployment.`)
    }
    await dependencies.sleep(timing.deploymentPollMilliseconds)
    const deployment = parseObject(await appconfig(
      'get-deployment', '--environment-id', target.environmentId,
      '--deployment-number', String(deploymentNumber), '--output', 'json',
    ), 'appconfig get-deployment')
    state = typeof deployment.State === 'string' ? deployment.State : 'UNKNOWN'
    const percentage = typeof deployment.PercentageComplete === 'number' ? ` ${deployment.PercentageComplete}%` : ''
    const report = `${state}${percentage}`
    if (report !== lastReported) log(`Deployment ${deploymentNumber}: ${report}`)
    lastReported = report
  }
  if (classifyDeploymentState(state) === 'failed') {
    throw new RuntimeControlError(`Deployment ${deploymentNumber} is ${state}. AppConfig keeps or returns to the previous configuration.`)
  }

  const readyUrl = `${target.webUrl}/api/ready`
  const maintenanceUrl = `${target.webUrl}/api/maintenance`
  const expected = request.mode === 'enabled' ? '200' : '503'
  const readyDeadline = dependencies.now().getTime() + timing.readyTimeoutMilliseconds
  let readyStatus = await dependencies.httpStatus(readyUrl)
  let maintenance = await dependencies.maintenanceState(maintenanceUrl)
  while (!readyMatchesMode(request.mode, readyStatus) || !maintenanceMatchesMode(request.mode, maintenance)) {
    if (dependencies.now().getTime() > readyDeadline) {
      throw new RuntimeControlError(
        `Deployment ${deploymentNumber} is COMPLETE, but ${readyUrl} returned ${readyStatus ?? 'no response'} ` +
          `(expected ${expected}) and ${maintenanceUrl} reported ${maintenance ?? 'no state'}.`,
      )
    }
    await dependencies.sleep(timing.readyPollMilliseconds)
    readyStatus = await dependencies.httpStatus(readyUrl)
    maintenance = await dependencies.maintenanceState(maintenanceUrl)
  }
  log(`${readyUrl} returned ${readyStatus} and the maintenance state is ${maintenance}. Runtime control is ${request.mode} at revision ${revision}.`)
  return { revision, versionNumber, deploymentNumber, readyStatus }
}

/**
 * Runs one `aws` CLI command and returns its standard output.
 *
 * @param args - Arguments after `aws`.
 * @returns Standard output.
 * @throws RuntimeControlError with the CLI's error output when the command fails.
 */
async function runAws(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['aws', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new RuntimeControlError(`aws ${args.slice(0, 2).join(' ')} failed: ${stderr.trim()}`)
  return stdout
}

/**
 * Requests a URL without following redirects or caching.
 *
 * @param url - URL to request.
 * @returns The status code, or `undefined` when the request failed.
 */
async function requestStatus(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    return response.status
  } catch {
    return undefined
  }
}

/**
 * Reads the maintenance state from `GET /api/maintenance`.
 *
 * @param url - Maintenance status URL.
 * @returns The reported state, or `undefined` on any failure.
 */
async function requestMaintenanceState(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('state' in body)) return undefined
    return typeof body.state === 'string' ? body.state : undefined
  } catch {
    return undefined
  }
}

/**
 * Entry point for `bun run runtime-control:enable`, `runtime-control:disable`, and
 * `runtime-control:read-only`.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? ''
  const stackName = process.env.MUKUROJI_STACK_NAME ?? 'Mukuroji'
  const workDirectory = await mkdtemp(join(tmpdir(), 'mukuroji-runtime-control-'))
  try {
    const request = parseRuntimeControlArguments(process.argv.slice(2))
    if (!region) throw new RuntimeControlError('AWS_REGION is required.')
    await runRuntimeControl(request, region, stackName, {
      aws: runAws,
      httpStatus: requestStatus,
      maintenanceState: requestMaintenanceState,
      readText: (path) => readFile(path, 'utf8'),
      writeText: (path, content) => writeFile(path, content, { mode: 0o600 }),
      workDirectory,
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      now: () => new Date(),
      log: (line) => console.log(line),
    })
    return 0
  } catch (error) {
    if (error instanceof RuntimeControlError) {
      console.error(error.message)
      return 1
    }
    throw error
  } finally {
    await rm(workDirectory, { force: true, recursive: true })
  }
}

if (import.meta.main) process.exit(await main())
