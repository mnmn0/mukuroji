/**
 * Deploys the Mukuroji stack and Web app from the GitHub Actions `production` Environment.
 *
 * Usage (inside the deploy workflow, after `aws-actions/configure-aws-credentials`):
 *   AWS_REGION=ap-northeast-1 bun run deploy:github deploy
 *   AWS_REGION=ap-northeast-1 bun run deploy:github runtime-control-enable
 *   AWS_REGION=ap-northeast-1 bun run deploy:github runtime-control-disable
 *   AWS_REGION=ap-northeast-1 bun run deploy:github runtime-control-disable-all-at-once
 *   AWS_REGION=ap-northeast-1 WEB_RELEASE_COMMIT=<sha> bun run deploy:github web-rollback
 *
 * `deploy` reads the non-secret stack parameters from SSM Parameter Store under
 * `/mukuroji/deploy/config/` (written once by `cdk/deploy-access/github-deploy-access.template.json`),
 * and the secret ones from SecureString parameters under `/mukuroji/deploy/secrets/`. Before the
 * stack exists it generates any missing secret and stores it without overwriting; once the stack
 * exists a missing secret stops the deploy, because a new value would change audit IDs and token
 * hashes. It then runs `cdk deploy`, publishes the Web app with `scripts/deploy-web.sh`, and checks
 * that `/api/health` reports the deployed commit. The workflow only calls this script, so later
 * changes to the deploy steps go through a normal pull request.
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Operation that the workflow's `operation` input selects. */
export type GitHubDeployOperation =
  | 'deploy'
  | 'runtime-control-enable'
  | 'runtime-control-disable'
  | 'runtime-control-disable-all-at-once'
  | 'web-rollback'

const OPERATIONS: readonly GitHubDeployOperation[] = [
  'deploy',
  'runtime-control-enable',
  'runtime-control-disable',
  'runtime-control-disable-all-at-once',
  'web-rollback',
]

/** SSM path that holds the non-secret deploy configuration. */
export const DEPLOY_CONFIG_PATH = '/mukuroji/deploy/config'
/** SSM path that holds the SecureString deploy secrets. */
export const DEPLOY_SECRETS_PATH = '/mukuroji/deploy/secrets'

/**
 * Result of one external command.
 */
export interface CommandResult {
  /** Process exit code. */
  readonly exitCode: number
  /** Captured standard output; empty when the output was streamed. */
  readonly stdout: string
  /** Captured standard error; empty when the output was streamed. */
  readonly stderr: string
}

/**
 * Options for one external command.
 */
export interface CommandOptions {
  /** Working directory relative to the repository root. */
  readonly cwd?: string
  /** Whether to stream output to the job log instead of capturing it. */
  readonly stream?: boolean
}

/**
 * Side effects used by {@link runGitHubDeploy}, replaceable in tests.
 */
export interface GitHubDeployDependencies {
  /**
   * Runs one external command without a shell.
   *
   * @param command - Program and arguments.
   * @param options - Working directory and output handling.
   * @returns Exit code and captured output.
   */
  readonly run: (command: readonly string[], options?: CommandOptions) => Promise<CommandResult>
  /**
   * Creates a new random secret.
   *
   * @returns 64 lowercase hex characters (32 random bytes).
   */
  readonly generateSecret: () => string
  /**
   * Hides a value in the rest of the job log.
   *
   * @param value - Value to hide.
   */
  readonly mask: (value: string) => void
  /**
   * Requests a URL and returns its JSON body.
   *
   * @param url - URL to request.
   * @returns The parsed body, or `undefined` when the request failed or the status was not 200.
   */
  readonly fetchJson: (url: string) => Promise<unknown>
  /**
   * Reads a file that a command wrote.
   *
   * @param path - File path.
   * @returns The file content.
   */
  readonly readText: (path: string) => Promise<string>
  /** Directory for the CDK outputs file. */
  readonly workDirectory: string
  /**
   * Waits before the next health check.
   *
   * @param milliseconds - Time to wait.
   */
  readonly sleep: (milliseconds: number) => Promise<void>
  /**
   * Prints one progress line.
   *
   * @param line - Text to print.
   */
  readonly log: (line: string) => void
  /**
   * Adds Markdown to the job summary.
   *
   * @param markdown - Text to append.
   */
  readonly summary: (markdown: string) => Promise<void>
}

/**
 * Values from the workflow run that the operation needs.
 */
export interface GitHubDeployContext {
  /** AWS Region of the stack. */
  readonly region: string
  /** Application stack name. */
  readonly stackName: string
  /** Full commit SHA that the workflow checked out (`GITHUB_SHA`). */
  readonly commitSha: string
  /** `GITHUB_RUN_ID`. */
  readonly runId: string
  /** `GITHUB_RUN_ATTEMPT`. */
  readonly runAttempt: string
  /** Release commit for `web-rollback`; empty for other operations. */
  readonly webReleaseCommit: string
}

/**
 * Timing used while waiting for `/api/health`; shortened in tests.
 */
export interface GitHubDeployTiming {
  /** Interval between health checks. */
  readonly healthPollMilliseconds: number
  /** Number of health checks before giving up. */
  readonly healthAttempts: number
}

/**
 * Non-secret deploy configuration stored under {@link DEPLOY_CONFIG_PATH}.
 */
export interface DeployConfiguration {
  /** Lowercase email of the first Workspace owner. */
  readonly initialOwnerEmail: string
  /** Canonical Workspace ID. */
  readonly workspaceDirectoryId: string
  /** Primary alarm SNS topic name. */
  readonly alarmPrimaryTopicName: string
  /** Secondary alarm SNS topic name. */
  readonly alarmSecondaryTopicName: string
  /** Comma-separated CORS origins, or empty to use the stack's `WebUrl`. */
  readonly apiAllowedOrigins: string
}

/**
 * One secret stack parameter and its SecureString parameter.
 */
interface SecretSpec {
  /** CloudFormation parameter name of the Mukuroji stack. */
  readonly stackParameter: string
  /** Name under {@link DEPLOY_SECRETS_PATH}. */
  readonly ssmName: string
  /** Format that the stack parameter accepts. */
  readonly pattern: RegExp
}

/** Secrets that the default stack (no SSO, no optional modules) requires. */
const SECRET_SPECS: readonly SecretSpec[] = [
  { stackParameter: 'WorkspaceAuditPseudonymKey', ssmName: 'workspace-audit-pseudonym-key', pattern: /^[0-9a-f]{64}$/ },
  { stackParameter: 'EnterpriseIdentityTokenHashSecret', ssmName: 'enterprise-identity-token-hash-secret', pattern: /^\S{32,256}$/ },
  { stackParameter: 'RequestTokenHashSecret', ssmName: 'request-token-hash-secret', pattern: /^\S{32,256}$/ },
  { stackParameter: 'EdgeOriginSecret', ssmName: 'edge-origin-secret', pattern: /^[A-Za-z0-9_-]{32,128}$/ },
]

/**
 * Application stack as `describe-stacks` reports it.
 */
export interface StackState {
  /** `StackStatus`. */
  readonly status: string
  /** Outputs by key. */
  readonly outputs: ReadonlyMap<string, string>
}

/**
 * Error that stops the operation with a message for the job log.
 */
export class GitHubDeployError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Message printed to the job log.
   */
  constructor(message: string) {
    super(message)
    this.name = 'GitHubDeployError'
  }
}

/**
 * Parses the operation argument.
 *
 * @param args - Command-line arguments after the script path.
 * @returns The operation; `deploy` when no argument is given.
 * @throws GitHubDeployError for an unknown or extra argument.
 */
export function parseGitHubDeployOperation(args: readonly string[]): GitHubDeployOperation {
  if (args.length > 1) throw new GitHubDeployError('Pass one operation.')
  const value = args[0] ?? 'deploy'
  const operation = OPERATIONS.find((candidate) => candidate === value)
  if (operation === undefined) {
    throw new GitHubDeployError(`Unknown operation "${value}". Use one of: ${OPERATIONS.join(', ')}.`)
  }
  return operation
}

/**
 * Builds the API runtime configuration revision for one workflow run.
 *
 * Every run attempt gets a new value, so a deploy never reuses a revision for different content.
 *
 * @param runId - `GITHUB_RUN_ID`.
 * @param runAttempt - `GITHUB_RUN_ATTEMPT`.
 * @returns A revision that the stack's `ApiRuntimeConfigurationRevision` pattern accepts.
 * @throws GitHubDeployError when either value is not a positive integer.
 */
export function buildRuntimeConfigurationRevision(runId: string, runAttempt: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,5}$/.test(runAttempt)) {
    throw new GitHubDeployError('GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be positive integers.')
  }
  return `gh-${runId}-${runAttempt}`
}

/**
 * Reads an object property as a string.
 *
 * @param value - Object to read.
 * @param key - Property name.
 * @returns The string, or `undefined` when the property is missing or not a string.
 */
function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const property: unknown = Reflect.get(value, key)
  return typeof property === 'string' ? property : undefined
}

/**
 * Reads an object property as an array.
 *
 * @param value - Object to read.
 * @param key - Property name.
 * @returns The array, or an empty array when the property is missing or not an array.
 */
function arrayProperty(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return []
  const property: unknown = Reflect.get(value, key)
  return Array.isArray(property) ? property : []
}

/**
 * Parses JSON printed by the `aws` CLI.
 *
 * @param output - Standard output of an `aws` command run with `--output json`.
 * @param command - Command name for the error message.
 * @returns The parsed value.
 * @throws GitHubDeployError when the output is not JSON.
 */
function parseJson(output: string, command: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new GitHubDeployError(`aws ${command} did not print JSON.`)
  }
}

/**
 * Runs an `aws` command and fails on a non-zero exit code.
 *
 * @param dependencies - Command runner.
 * @param args - Arguments after `aws`.
 * @returns Standard output.
 * @throws GitHubDeployError with the CLI's error output when the command fails.
 */
async function aws(dependencies: GitHubDeployDependencies, args: readonly string[]): Promise<string> {
  const result = await dependencies.run(['aws', ...args])
  if (result.exitCode !== 0) {
    throw new GitHubDeployError(`aws ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/**
 * Reads the non-secret deploy configuration.
 *
 * @param dependencies - Command runner.
 * @param region - AWS Region.
 * @returns The configuration.
 * @throws GitHubDeployError when a required value is missing.
 */
export async function readDeployConfiguration(
  dependencies: GitHubDeployDependencies,
  region: string,
): Promise<DeployConfiguration> {
  const output = await aws(dependencies, [
    'ssm', 'get-parameters-by-path', '--region', region, '--path', DEPLOY_CONFIG_PATH, '--output', 'json',
  ])
  const values = new Map<string, string>()
  for (const parameter of arrayProperty(parseJson(output, 'ssm get-parameters-by-path'), 'Parameters')) {
    const name = stringProperty(parameter, 'Name')
    const value = stringProperty(parameter, 'Value')
    if (name !== undefined && value !== undefined) values.set(name.slice(DEPLOY_CONFIG_PATH.length + 1), value)
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim() ?? ''
    if (!value) {
      throw new GitHubDeployError(
        `${DEPLOY_CONFIG_PATH}/${name} is missing. Create the deploy access stack from cdk/deploy-access first.`,
      )
    }
    return value
  }
  return {
    initialOwnerEmail: required('initial-owner-email'),
    workspaceDirectoryId: required('workspace-directory-id'),
    alarmPrimaryTopicName: required('alarm-primary-topic-name'),
    alarmSecondaryTopicName: required('alarm-secondary-topic-name'),
    apiAllowedOrigins: values.get('api-allowed-origins')?.trim() ?? '',
  }
}

/**
 * Reads the application stack.
 *
 * @param dependencies - Command runner.
 * @param region - AWS Region.
 * @param stackName - Application stack name.
 * @returns The stack, or `undefined` when it does not exist yet.
 * @throws GitHubDeployError when the call fails for another reason.
 */
export async function readStack(
  dependencies: GitHubDeployDependencies,
  region: string,
  stackName: string,
): Promise<StackState | undefined> {
  const result = await dependencies.run([
    'aws', 'cloudformation', 'describe-stacks', '--region', region, '--stack-name', stackName, '--output', 'json',
  ])
  if (result.exitCode !== 0) {
    if (result.stderr.includes('does not exist')) return undefined
    throw new GitHubDeployError(`aws cloudformation describe-stacks failed: ${result.stderr.trim()}`)
  }
  const stack = arrayProperty(parseJson(result.stdout, 'cloudformation describe-stacks'), 'Stacks')[0]
  const status = stringProperty(stack, 'StackStatus')
  if (status === undefined) throw new GitHubDeployError('aws cloudformation describe-stacks returned no StackStatus.')
  const outputs = new Map<string, string>()
  for (const output of arrayProperty(stack, 'Outputs')) {
    const key = stringProperty(output, 'OutputKey')
    const value = stringProperty(output, 'OutputValue')
    if (key !== undefined && value !== undefined) outputs.set(key, value)
  }
  return { status, outputs }
}

/**
 * Reads the deploy secrets, creating missing ones only before the stack exists.
 *
 * @param dependencies - Command runner, secret generator, and log masking.
 * @param region - AWS Region.
 * @param stackExists - Whether the application stack exists (in any status).
 * @returns Secret values by stack parameter name.
 * @throws GitHubDeployError when a secret is missing after the stack exists, or has the wrong format.
 */
export async function ensureDeploySecrets(
  dependencies: GitHubDeployDependencies,
  region: string,
  stackExists: boolean,
): Promise<ReadonlyMap<string, string>> {
  const read = async (): Promise<Map<string, string>> => {
    const output = await aws(dependencies, [
      'ssm', 'get-parameters', '--region', region, '--with-decryption', '--output', 'json',
      '--names', ...SECRET_SPECS.map((spec) => `${DEPLOY_SECRETS_PATH}/${spec.ssmName}`),
    ])
    const values = new Map<string, string>()
    for (const parameter of arrayProperty(parseJson(output, 'ssm get-parameters'), 'Parameters')) {
      const name = stringProperty(parameter, 'Name')
      const value = stringProperty(parameter, 'Value')
      if (name !== undefined && value !== undefined) values.set(name, value)
    }
    return values
  }

  let values = await read()
  const missing = SECRET_SPECS.filter((spec) => !values.has(`${DEPLOY_SECRETS_PATH}/${spec.ssmName}`))
  if (missing.length > 0) {
    const names = missing.map((spec) => `${DEPLOY_SECRETS_PATH}/${spec.ssmName}`).join(', ')
    if (stackExists) {
      throw new GitHubDeployError(
        `${names} missing while the stack exists. Restore the value the stack uses instead of generating a new one.`,
      )
    }
    for (const spec of missing) {
      const name = `${DEPLOY_SECRETS_PATH}/${spec.ssmName}`
      const value = dependencies.generateSecret()
      dependencies.mask(value)
      const result = await dependencies.run([
        'aws', 'ssm', 'put-parameter', '--region', region, '--name', name, '--type', 'SecureString',
        '--no-overwrite', '--value', value, '--description', `Mukuroji stack parameter ${spec.stackParameter}`,
      ])
      // Another run may have created it first; the value read back below wins.
      if (result.exitCode !== 0 && !result.stderr.includes('ParameterAlreadyExists')) {
        throw new GitHubDeployError(`aws ssm put-parameter failed for ${name}: ${result.stderr.trim()}`)
      }
      dependencies.log(`Created ${name}.`)
    }
    values = await read()
  }

  const secrets = new Map<string, string>()
  for (const spec of SECRET_SPECS) {
    const name = `${DEPLOY_SECRETS_PATH}/${spec.ssmName}`
    const value = values.get(name)
    if (value === undefined) throw new GitHubDeployError(`${name} could not be read.`)
    dependencies.mask(value)
    if (!spec.pattern.test(value)) {
      throw new GitHubDeployError(`${name} does not match the format ${spec.stackParameter} accepts.`)
    }
    secrets.set(spec.stackParameter, value)
  }
  return secrets
}

/**
 * Builds the `--parameters` values for `cdk deploy`.
 *
 * Parameters left out keep their previous value on a stack update (CDK's default), so optional
 * settings such as AI or SSO that an operator set before stay as they are.
 *
 * @param configuration - Non-secret configuration.
 * @param secrets - Secret values by stack parameter name.
 * @param commitSha - Deployed commit.
 * @param revision - API runtime configuration revision.
 * @param apiAllowedOrigins - CORS origins, or empty to leave the parameter out.
 * @returns `Name=value` pairs.
 */
export function buildStackParameters(
  configuration: DeployConfiguration,
  secrets: ReadonlyMap<string, string>,
  commitSha: string,
  revision: string,
  apiAllowedOrigins: string,
): string[] {
  const parameters: [string, string][] = [
    ['WorkspaceDirectoryId', configuration.workspaceDirectoryId],
    ['InitialOwnerEmail', configuration.initialOwnerEmail],
    ['InitialOwnerUsername', configuration.initialOwnerEmail],
    ['AlarmPrimaryTopicName', configuration.alarmPrimaryTopicName],
    ['AlarmSecondaryTopicName', configuration.alarmSecondaryTopicName],
    ['ApiRuntimeConfigurationRevision', revision],
    ['ApplicationCommitSha', commitSha],
    ...secrets.entries(),
  ]
  if (apiAllowedOrigins) parameters.push(['ApiAllowedOrigins', apiAllowedOrigins])
  return parameters.map(([name, value]) => `${name}=${value}`)
}

/**
 * Runs a command whose output goes to the job log and fails on a non-zero exit code.
 *
 * @param dependencies - Command runner.
 * @param command - Program and arguments.
 * @param description - What the command does, for the error message.
 * @param cwd - Working directory relative to the repository root.
 * @throws GitHubDeployError when the command fails.
 */
async function runStreaming(
  dependencies: GitHubDeployDependencies,
  command: readonly string[],
  description: string,
  cwd?: string,
): Promise<void> {
  const result = await dependencies.run(command, { stream: true, ...(cwd === undefined ? {} : { cwd }) })
  if (result.exitCode !== 0) throw new GitHubDeployError(`${description} failed with exit code ${result.exitCode}.`)
}

/**
 * Waits until `/api/health` reports the deployed commit.
 *
 * @param dependencies - HTTP client, sleep, and log.
 * @param webUrl - Canonical Web URL.
 * @param commitSha - Expected `applicationCommitSha`.
 * @param timing - Poll interval and attempts.
 * @throws GitHubDeployError when the commit does not match in time.
 */
async function waitForHealthyCommit(
  dependencies: GitHubDeployDependencies,
  webUrl: string,
  commitSha: string,
  timing: GitHubDeployTiming,
): Promise<void> {
  const healthUrl = new URL('/api/health', webUrl).toString()
  let reported: string | undefined
  for (let attempt = 1; attempt <= timing.healthAttempts; attempt += 1) {
    reported = stringProperty(await dependencies.fetchJson(healthUrl), 'applicationCommitSha')
    if (reported === commitSha) {
      dependencies.log(`${healthUrl} reports ${commitSha}.`)
      return
    }
    if (attempt < timing.healthAttempts) await dependencies.sleep(timing.healthPollMilliseconds)
  }
  throw new GitHubDeployError(`${healthUrl} reports ${reported ?? 'no applicationCommitSha'}, expected ${commitSha}.`)
}

/**
 * Deploys the stack and Web app, then checks the deployed commit.
 *
 * @param context - Workflow run values.
 * @param dependencies - Side effects.
 * @param timing - Health check timing.
 * @returns The canonical Web URL.
 * @throws GitHubDeployError when a step fails.
 */
async function deploy(
  context: GitHubDeployContext,
  dependencies: GitHubDeployDependencies,
  timing: GitHubDeployTiming,
): Promise<string> {
  const head = await dependencies.run(['git', 'rev-parse', 'HEAD'])
  if (head.exitCode !== 0 || head.stdout.trim() !== context.commitSha) {
    throw new GitHubDeployError(`The checkout is not ${context.commitSha}.`)
  }
  // A re-run of an old workflow run keeps its old GITHUB_SHA; never let it roll production back.
  const mainTip = await dependencies.run(['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'])
  const mainSha = mainTip.stdout.trim().split(/\s+/)[0] ?? ''
  if (mainTip.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new GitHubDeployError('Could not read the current main commit from origin.')
  }
  if (mainSha !== context.commitSha) {
    throw new GitHubDeployError(
      `${context.commitSha} is no longer the tip of main (${mainSha}). Deploy the latest run instead; ` +
        'to roll back, revert on main.',
    )
  }
  const revision = buildRuntimeConfigurationRevision(context.runId, context.runAttempt)
  const configuration = await readDeployConfiguration(dependencies, context.region)
  const before = await readStack(dependencies, context.region, context.stackName)
  if (before?.status === 'ROLLBACK_COMPLETE') {
    dependencies.log(
      `${context.stackName} is ROLLBACK_COMPLETE after a failed first create. cdk deploy deletes it and creates it again; ` +
        'the stored secrets are kept and reused.',
    )
  }
  const secrets = await ensureDeploySecrets(dependencies, context.region, before !== undefined)
  const apiAllowedOrigins = configuration.apiAllowedOrigins || (before?.outputs.get('WebUrl')?.replace(/\/+$/, '') ?? '')
  const parameters = buildStackParameters(configuration, secrets, context.commitSha, revision, apiAllowedOrigins)
  dependencies.log(
    `Deploying ${context.commitSha} to ${context.stackName} in ${context.region} ` +
      `(${before === undefined ? 'new stack' : before.status}, revision ${revision}).`,
  )

  const outputsFile = join(dependencies.workDirectory, 'cdk-outputs.json')
  await runStreaming(dependencies, [
    'bun', 'run', 'cdk', 'deploy', context.stackName,
    '--ci', '--require-approval', 'never', '--progress', 'events',
    '--outputs-file', outputsFile,
    ...parameters.flatMap((parameter) => ['--parameters', parameter]),
  ], 'cdk deploy', 'cdk')
  // Only the size and digest are logged: the outputs name resources but stay in the runner.
  const outputs = await dependencies.readText(outputsFile)
  const digest = new Bun.CryptoHasher('sha256').update(outputs).digest('hex')

  await runStreaming(dependencies, ['bash', 'scripts/deploy-web.sh'], 'scripts/deploy-web.sh')

  const after = await readStack(dependencies, context.region, context.stackName)
  const webUrl = after?.outputs.get('WebUrl')
  if (webUrl === undefined) throw new GitHubDeployError(`Stack ${context.stackName} has no WebUrl output.`)
  await waitForHealthyCommit(dependencies, webUrl, context.commitSha, timing)

  await dependencies.summary([
    '### Deployed',
    '',
    '| | |',
    '| --- | --- |',
    `| Commit | \`${context.commitSha}\` |`,
    `| Stack | \`${context.stackName}\` (${context.region}, ${after?.status ?? 'unknown'}) |`,
    `| ApiRuntimeConfigurationRevision | \`${revision}\` |`,
    `| CDK outputs SHA-256 | \`${digest}\` |`,
    `| WorkspaceDirectoryId | \`${configuration.workspaceDirectoryId}\` |`,
    `| InitialOwnerEmail | \`${configuration.initialOwnerEmail}\` |`,
    `| Alarm topics | \`${configuration.alarmPrimaryTopicName}\`, \`${configuration.alarmSecondaryTopicName}\` |`,
    `| ApiAllowedOrigins | ${apiAllowedOrigins ? `\`${apiAllowedOrigins}\`` : 'stack default'} |`,
    `| Web | ${webUrl} |`,
    '',
    before === undefined
      ? 'First deploy: runtime control is `disabled`, so sign-in also returns 503. Run the workflow with `runtime-control-enable` before the owner signs in.'
      : '',
    '',
  ].join('\n'))
  return webUrl
}

/**
 * Runs the selected operation.
 *
 * @param operation - Operation to run.
 * @param context - Workflow run values.
 * @param dependencies - Side effects.
 * @param timing - Health check timing.
 * @returns The canonical Web URL after `deploy`, otherwise `undefined`.
 * @throws GitHubDeployError when the operation fails.
 */
export async function runGitHubDeploy(
  operation: GitHubDeployOperation,
  context: GitHubDeployContext,
  dependencies: GitHubDeployDependencies,
  timing: GitHubDeployTiming = { healthPollMilliseconds: 10_000, healthAttempts: 30 },
): Promise<string | undefined> {
  if (!context.region) throw new GitHubDeployError('AWS_REGION is required.')
  if (!/^[0-9a-f]{40}$/.test(context.commitSha)) throw new GitHubDeployError('GITHUB_SHA must be a full commit SHA.')
  switch (operation) {
    case 'deploy':
      return deploy(context, dependencies, timing)
    case 'runtime-control-enable':
      await runStreaming(dependencies, ['bun', 'scripts/runtime-control.ts', 'enable'], 'scripts/runtime-control.ts')
      return undefined
    case 'runtime-control-disable':
      await runStreaming(dependencies, ['bun', 'scripts/runtime-control.ts', 'disable'], 'scripts/runtime-control.ts')
      return undefined
    case 'runtime-control-disable-all-at-once':
      // Emergency stop decided by the incident commander: AppConfig.AllAtOnce instead of the canary.
      await runStreaming(
        dependencies,
        ['bun', 'scripts/runtime-control.ts', 'disable', '--all-at-once'],
        'scripts/runtime-control.ts',
      )
      return undefined
    case 'web-rollback':
      if (!/^[0-9a-f]{40}$/.test(context.webReleaseCommit)) {
        throw new GitHubDeployError('web-rollback needs web_release_commit, a full 40-character commit SHA.')
      }
      await runStreaming(dependencies, ['bash', 'scripts/rollback-web.sh', context.webReleaseCommit], 'scripts/rollback-web.sh')
      return undefined
  }
}

/**
 * Runs a command from the repository root without a shell.
 *
 * @param command - Program and arguments.
 * @param options - Working directory and output handling.
 * @returns Exit code and captured output.
 */
async function runCommand(command: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const repositoryRoot = join(import.meta.dir, '..')
  const child = Bun.spawn([...command], {
    cwd: options.cwd === undefined ? repositoryRoot : join(repositoryRoot, options.cwd),
    stdout: options.stream ? 'inherit' : 'pipe',
    stderr: options.stream ? 'inherit' : 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    options.stream ? '' : new Response(child.stdout).text(),
    options.stream ? '' : new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

/**
 * Requests a URL without caching and parses a 200 JSON response.
 *
 * @param url - URL to request.
 * @returns The body, or `undefined` when the request failed.
 */
async function requestJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    if (response.status !== 200) {
      await response.body?.cancel()
      return undefined
    }
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Entry point for `bun run deploy:github`.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const workDirectory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'mukuroji-deploy-'))
  const inActions = process.env.GITHUB_ACTIONS === 'true'
  try {
    const operation = parseGitHubDeployOperation(process.argv.slice(2))
    const webUrl = await runGitHubDeploy(operation, {
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '',
      stackName: process.env.MUKUROJI_STACK_NAME ?? 'Mukuroji',
      commitSha: process.env.GITHUB_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
      webReleaseCommit: process.env.WEB_RELEASE_COMMIT?.trim() ?? '',
    }, {
      run: runCommand,
      generateSecret: () => randomBytes(32).toString('hex'),
      mask: (value) => {
        if (inActions) console.log(`::add-mask::${value}`)
      },
      fetchJson: requestJson,
      readText: (path) => readFile(path, 'utf8'),
      workDirectory,
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      log: (line) => console.log(line),
      summary: async (markdown) => {
        const path = process.env.GITHUB_STEP_SUMMARY
        if (path) await appendFile(path, markdown)
      },
    })
    const outputPath = process.env.GITHUB_OUTPUT
    if (webUrl !== undefined && outputPath) await appendFile(outputPath, `web_url=${webUrl}\n`)
    return 0
  } catch (error) {
    if (error instanceof GitHubDeployError) {
      console.error(error.message)
      return 1
    }
    throw error
  } finally {
    await rm(workDirectory, { force: true, recursive: true })
  }
}

if (import.meta.main) process.exit(await main())
