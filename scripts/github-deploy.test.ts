import { describe, expect, test } from 'bun:test'
import {
  buildRuntimeConfigurationRevision,
  buildStackParameters,
  DEPLOY_SECRETS_PATH,
  ensureDeploySecrets,
  GitHubDeployError,
  parseGitHubDeployOperation,
  readDeployConfiguration,
  runGitHubDeploy,
  type CommandOptions,
  type CommandResult,
  type GitHubDeployContext,
  type GitHubDeployDependencies,
} from './github-deploy'

const commitSha = '0123456789abcdef0123456789abcdef01234567'

const context: GitHubDeployContext = {
  region: 'ap-northeast-1',
  stackName: 'Mukuroji',
  commitSha,
  runId: '12345678901',
  runAttempt: '2',
  webReleaseCommit: '',
}

const config = [
  { Name: '/mukuroji/deploy/config/initial-owner-email', Value: 'owner@example.com' },
  { Name: '/mukuroji/deploy/config/workspace-directory-id', Value: 'workspace#production' },
  { Name: '/mukuroji/deploy/config/alarm-primary-topic-name', Value: 'mukuroji-alarms-primary' },
  { Name: '/mukuroji/deploy/config/alarm-secondary-topic-name', Value: 'mukuroji-alarms-secondary' },
]

/**
 * Options for the fake account used by {@link fakeDependencies}.
 */
interface FakeOptions {
  /** Whether the stack exists before the deploy. */
  readonly stackExists?: boolean
  /** Secrets already stored, by SSM name. */
  readonly storedSecrets?: ReadonlyMap<string, string>
  /** Config parameters in SSM. */
  readonly config?: readonly { Name: string; Value: string }[]
  /** `applicationCommitSha` values returned by successive health checks. */
  readonly healthCommits?: readonly (string | undefined)[]
  /** Exit code of `cdk deploy`. */
  readonly cdkExitCode?: number
  /** Commit at the tip of main on origin. */
  readonly mainSha?: string
}

/**
 * Fake side effects with what they recorded.
 */
interface Fake {
  /** Dependencies to pass to the script. */
  readonly dependencies: GitHubDeployDependencies
  /** Every command, with its options. */
  readonly calls: { command: readonly string[]; options?: CommandOptions }[]
  /** Values passed to `mask`. */
  readonly masked: string[]
  /** Secrets in the fake SSM store, by name. */
  readonly secrets: Map<string, string>
  /** Text added to the job summary. */
  readonly summaries: string[]
}

/**
 * Builds side effects that answer like an AWS account with the deploy access stack.
 *
 * @param options - Responses to vary per test.
 * @returns The dependencies and what they recorded.
 */
function fakeDependencies(options: FakeOptions = {}): Fake {
  const calls: Fake['calls'] = []
  const masked: string[] = []
  const summaries: string[] = []
  const secrets = new Map(options.storedSecrets ?? [])
  let stackExists = options.stackExists ?? false
  let generated = 0
  const healthCommits = [...(options.healthCommits ?? [commitSha])]
  /**
   * Builds a successful command result.
   *
   * @param stdout - Standard output to return.
   * @returns A result with exit code 0.
   */
  const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' })

  /**
   * Records a command and answers it like the fake account; `put-parameter` stores a new secret
   * and `cdk deploy` makes the stack exist.
   *
   * @param command - Program and arguments.
   * @param commandOptions - Working directory and output handling.
   * @returns The fake result.
   */
  const run = async (command: readonly string[], commandOptions?: CommandOptions): Promise<CommandResult> => {
    calls.push({ command, ...(commandOptions === undefined ? {} : { options: commandOptions }) })
    const joined = command.join(' ')
    if (joined === 'git rev-parse HEAD') return ok(`${commitSha}\n`)
    if (joined.startsWith('git ls-remote')) return ok(`${options.mainSha ?? commitSha}\trefs/heads/main\n`)
    if (joined.startsWith('aws ssm get-parameters-by-path')) {
      return ok(JSON.stringify({ Parameters: options.config ?? config }))
    }
    if (joined.startsWith('aws ssm get-parameters ')) {
      const names = command.slice(command.indexOf('--names') + 1)
      return ok(JSON.stringify({
        Parameters: names.filter((name) => secrets.has(name)).map((name) => ({ Name: name, Value: secrets.get(name) })),
        InvalidParameters: names.filter((name) => !secrets.has(name)),
      }))
    }
    if (joined.startsWith('aws ssm put-parameter')) {
      const name = command[command.indexOf('--name') + 1] ?? ''
      if (secrets.has(name)) return { exitCode: 254, stdout: '', stderr: 'An error occurred (ParameterAlreadyExists)' }
      secrets.set(name, command[command.indexOf('--value') + 1] ?? '')
      return ok('{}')
    }
    if (joined.startsWith('aws cloudformation describe-stacks')) {
      if (!stackExists) {
        return { exitCode: 254, stdout: '', stderr: 'An error occurred (ValidationError): Stack with id Mukuroji does not exist' }
      }
      return ok(JSON.stringify({
        Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [{ OutputKey: 'WebUrl', OutputValue: 'https://d111.cloudfront.net/' }] }],
      }))
    }
    if (command[0] === 'bun' && command.includes('deploy')) {
      stackExists = true
      return { exitCode: options.cdkExitCode ?? 0, stdout: '', stderr: '' }
    }
    return ok('')
  }

  return {
    calls,
    masked,
    secrets,
    summaries,
    dependencies: {
      run,
      generateSecret: () => {
        generated += 1
        return generated.toString(16).padStart(64, 'a')
      },
      mask: (value) => masked.push(value),
      fetchJson: async () => ({ ok: true, applicationCommitSha: healthCommits.shift() }),
      readText: async () => '{"Mukuroji":{}}',
      workDirectory: '/tmp/work',
      sleep: async () => {},
      log: () => {},
      summary: async (markdown) => {
        summaries.push(markdown)
      },
    },
  }
}

/**
 * Builds a stored secret set with valid values.
 *
 * @returns Secrets by SSM name.
 */
function storedSecrets(): Map<string, string> {
  return new Map([
    [`${DEPLOY_SECRETS_PATH}/workspace-audit-pseudonym-key`, 'b'.repeat(64)],
    [`${DEPLOY_SECRETS_PATH}/enterprise-identity-token-hash-secret`, 'c'.repeat(64)],
    [`${DEPLOY_SECRETS_PATH}/request-token-hash-secret`, 'd'.repeat(64)],
    [`${DEPLOY_SECRETS_PATH}/edge-origin-secret`, 'e'.repeat(64)],
  ])
}

const fastTiming = { healthPollMilliseconds: 1, healthAttempts: 3 }

describe('parseGitHubDeployOperation', () => {
  test('defaults to deploy and accepts each operation', () => {
    expect(parseGitHubDeployOperation([])).toBe('deploy')
    expect(parseGitHubDeployOperation(['web-rollback'])).toBe('web-rollback')
    expect(parseGitHubDeployOperation(['runtime-control-enable'])).toBe('runtime-control-enable')
  })

  test('rejects unknown and extra arguments', () => {
    expect(() => parseGitHubDeployOperation(['destroy'])).toThrow(GitHubDeployError)
    expect(() => parseGitHubDeployOperation(['deploy', 'extra'])).toThrow(GitHubDeployError)
  })
})

describe('buildRuntimeConfigurationRevision', () => {
  test('is unique per run attempt and fits the stack pattern', () => {
    const revision = buildRuntimeConfigurationRevision('12345678901', '2')
    expect(revision).toBe('gh-12345678901-2')
    expect(revision).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)
    expect(buildRuntimeConfigurationRevision('99999999999999999999', '999999').length).toBeLessThanOrEqual(32)
  })

  test('rejects values that are not run numbers', () => {
    expect(() => buildRuntimeConfigurationRevision('', '1')).toThrow(GitHubDeployError)
    expect(() => buildRuntimeConfigurationRevision('1', '0')).toThrow(GitHubDeployError)
    expect(() => buildRuntimeConfigurationRevision('1;rm', '1')).toThrow(GitHubDeployError)
  })
})

describe('readDeployConfiguration', () => {
  test('reads required and optional values', async () => {
    const fake = fakeDependencies({
      config: [...config, { Name: '/mukuroji/deploy/config/api-allowed-origins', Value: 'https://wbs.example.com' }],
    })
    expect(await readDeployConfiguration(fake.dependencies, 'ap-northeast-1')).toEqual({
      initialOwnerEmail: 'owner@example.com',
      workspaceDirectoryId: 'workspace#production',
      alarmPrimaryTopicName: 'mukuroji-alarms-primary',
      alarmSecondaryTopicName: 'mukuroji-alarms-secondary',
      apiAllowedOrigins: 'https://wbs.example.com',
    })
  })

  test('fails when the deploy access stack has not written a required value', async () => {
    const fake = fakeDependencies({ config: config.slice(1) })
    await expect(readDeployConfiguration(fake.dependencies, 'ap-northeast-1')).rejects.toThrow(
      '/mukuroji/deploy/config/initial-owner-email is missing',
    )
  })
})

describe('ensureDeploySecrets', () => {
  test('creates missing secrets before the stack exists, without overwriting, and masks them', async () => {
    const fake = fakeDependencies()
    const secrets = await ensureDeploySecrets(fake.dependencies, 'ap-northeast-1', false)
    expect([...secrets.keys()]).toEqual([
      'WorkspaceAuditPseudonymKey',
      'EnterpriseIdentityTokenHashSecret',
      'RequestTokenHashSecret',
      'EdgeOriginSecret',
    ])
    const puts = fake.calls.filter((call) => call.command.join(' ').startsWith('aws ssm put-parameter'))
    expect(puts).toHaveLength(4)
    for (const put of puts) {
      expect(put.command).toContain('--no-overwrite')
      expect(put.command).not.toContain('--overwrite')
      expect(put.command).toContain('SecureString')
    }
    for (const value of secrets.values()) expect(fake.masked).toContain(value)
  })

  test('keeps a secret that another run stored first', async () => {
    const stored = storedSecrets()
    stored.delete(`${DEPLOY_SECRETS_PATH}/edge-origin-secret`)
    const fake = fakeDependencies({ storedSecrets: stored })
    const realRun = fake.dependencies.run
    const racing: GitHubDeployDependencies = {
      ...fake.dependencies,
      run: async (command, options) => {
        if (command.join(' ').startsWith('aws ssm put-parameter')) {
          fake.secrets.set(`${DEPLOY_SECRETS_PATH}/edge-origin-secret`, 'f'.repeat(64))
        }
        return realRun(command, options)
      },
    }
    const secrets = await ensureDeploySecrets(racing, 'ap-northeast-1', false)
    expect(secrets.get('EdgeOriginSecret')).toBe('f'.repeat(64))
  })

  test('refuses to generate a secret once the stack exists', async () => {
    const stored = storedSecrets()
    stored.delete(`${DEPLOY_SECRETS_PATH}/workspace-audit-pseudonym-key`)
    const fake = fakeDependencies({ storedSecrets: stored })
    await expect(ensureDeploySecrets(fake.dependencies, 'ap-northeast-1', true)).rejects.toThrow(
      'workspace-audit-pseudonym-key missing while the stack exists',
    )
    expect(fake.calls.some((call) => call.command.includes('put-parameter'))).toBe(false)
  })

  test('rejects a stored value the stack would refuse', async () => {
    const stored = storedSecrets()
    stored.set(`${DEPLOY_SECRETS_PATH}/workspace-audit-pseudonym-key`, 'NOT-HEX')
    const fake = fakeDependencies({ storedSecrets: stored })
    await expect(ensureDeploySecrets(fake.dependencies, 'ap-northeast-1', true)).rejects.toThrow('does not match')
  })
})

describe('buildStackParameters', () => {
  test('uses the owner email as username and leaves origins out when empty', () => {
    const parameters = buildStackParameters(
      {
        initialOwnerEmail: 'owner@example.com',
        workspaceDirectoryId: 'workspace#production',
        alarmPrimaryTopicName: 'p',
        alarmSecondaryTopicName: 's',
        apiAllowedOrigins: '',
      },
      new Map([['EdgeOriginSecret', 'x'.repeat(64)]]),
      commitSha,
      'gh-1-1',
      '',
    )
    expect(parameters).toContain('InitialOwnerUsername=owner@example.com')
    expect(parameters).toContain(`ApplicationCommitSha=${commitSha}`)
    expect(parameters).toContain('ApiRuntimeConfigurationRevision=gh-1-1')
    expect(parameters).toContain(`EdgeOriginSecret=${'x'.repeat(64)}`)
    expect(parameters.some((parameter) => parameter.startsWith('ApiAllowedOrigins='))).toBe(false)
  })
})

describe('runGitHubDeploy', () => {
  test('first deploy creates secrets, deploys, publishes the Web app, and checks the commit', async () => {
    const fake = fakeDependencies({ healthCommits: [undefined, commitSha] })
    const webUrl = await runGitHubDeploy('deploy', context, fake.dependencies, fastTiming)
    expect(webUrl).toBe('https://d111.cloudfront.net/')

    const cdk = fake.calls.find((call) => call.command[0] === 'bun' && call.command.includes('deploy'))
    expect(cdk?.options).toEqual({ stream: true, cwd: 'cdk' })
    expect(cdk?.command.slice(0, 5)).toEqual(['bun', 'run', 'cdk', 'deploy', 'Mukuroji'])
    expect(cdk?.command).toContain('--require-approval')
    expect(cdk?.command).toContain('ApiRuntimeConfigurationRevision=gh-12345678901-2')
    expect(cdk?.command.some((value) => value.startsWith('ApiAllowedOrigins='))).toBe(false)

    const order = fake.calls.map((call) => call.command.slice(0, 3).join(' '))
    expect(order.indexOf('bash scripts/deploy-web.sh')).toBeGreaterThan(order.indexOf('bun run cdk'))
    expect(fake.summaries.join('')).toContain('runtime-control-enable')
  })

  test('later deploys pass the WebUrl origin and never create secrets', async () => {
    const fake = fakeDependencies({ stackExists: true, storedSecrets: storedSecrets() })
    await runGitHubDeploy('deploy', context, fake.dependencies, fastTiming)
    const cdk = fake.calls.find((call) => call.command[0] === 'bun' && call.command.includes('deploy'))
    expect(cdk?.command).toContain('ApiAllowedOrigins=https://d111.cloudfront.net')
    expect(fake.calls.some((call) => call.command.includes('put-parameter'))).toBe(false)
  })

  test('stops before the Web upload when cdk deploy fails', async () => {
    const fake = fakeDependencies({ stackExists: true, storedSecrets: storedSecrets(), cdkExitCode: 1 })
    await expect(runGitHubDeploy('deploy', context, fake.dependencies, fastTiming)).rejects.toThrow('cdk deploy failed')
    expect(fake.calls.some((call) => call.command.includes('scripts/deploy-web.sh'))).toBe(false)
  })

  test('fails when /api/health keeps reporting another commit', async () => {
    const fake = fakeDependencies({
      stackExists: true,
      storedSecrets: storedSecrets(),
      healthCommits: ['f'.repeat(40), 'f'.repeat(40), 'f'.repeat(40)],
    })
    await expect(runGitHubDeploy('deploy', context, fake.dependencies, fastTiming)).rejects.toThrow(
      `expected ${commitSha}`,
    )
  })

  test('refuses to deploy a commit that is no longer the tip of main, such as a re-run of an old run', async () => {
    const fake = fakeDependencies({ stackExists: true, storedSecrets: storedSecrets(), mainSha: 'b'.repeat(40) })
    await expect(runGitHubDeploy('deploy', context, fake.dependencies, fastTiming)).rejects.toThrow(
      'is no longer the tip of main',
    )
    expect(fake.calls.some((call) => call.command[0] === 'bun' || call.command[0] === 'aws')).toBe(false)
  })

  test('refuses a checkout that is not GITHUB_SHA', async () => {
    const fake = fakeDependencies()
    await expect(
      runGitHubDeploy('deploy', { ...context, commitSha: 'a'.repeat(40) }, fake.dependencies, fastTiming),
    ).rejects.toThrow('The checkout is not')
  })

  test('runs runtime control and Web rollback through the existing scripts', async () => {
    const fake = fakeDependencies()
    await runGitHubDeploy('runtime-control-enable', context, fake.dependencies, fastTiming)
    await runGitHubDeploy('runtime-control-disable', context, fake.dependencies, fastTiming)
    await runGitHubDeploy('runtime-control-disable-all-at-once', context, fake.dependencies, fastTiming)
    await runGitHubDeploy('web-rollback', { ...context, webReleaseCommit: 'a'.repeat(40) }, fake.dependencies, fastTiming)
    expect(fake.calls.map((call) => call.command.join(' '))).toEqual([
      'bun scripts/runtime-control.ts enable',
      'bun scripts/runtime-control.ts disable',
      'bun scripts/runtime-control.ts disable --all-at-once',
      `bash scripts/rollback-web.sh ${'a'.repeat(40)}`,
    ])
  })

  test('web rollback needs a full commit SHA', async () => {
    const fake = fakeDependencies()
    await expect(
      runGitHubDeploy('web-rollback', { ...context, webReleaseCommit: 'main' }, fake.dependencies, fastTiming),
    ).rejects.toThrow('full 40-character commit SHA')
    expect(fake.calls).toHaveLength(0)
  })
})
