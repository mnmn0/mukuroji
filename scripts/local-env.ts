import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Secrets that local development needs in the root `.env`, each a 64-character lowercase hex value.
 */
export const requiredLocalSecretNames: readonly string[] = [
  'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY',
  'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET',
]

const localSecretPattern = /^[0-9a-f]{64}$/

/**
 * Result of planning the root `.env` for local development.
 */
export interface LocalEnvironmentPlan {
  /** Full `.env` content to write, or `undefined` when the existing file already has every secret. */
  readonly content: string | undefined
  /** Names of the secrets that were generated in this plan. */
  readonly generated: readonly string[]
}

/**
 * Error raised when an existing `.env` holds a secret that the local runtime would reject.
 */
export class InvalidLocalEnvironmentError extends Error {
  /** Names of the secrets whose existing values are not 64-character lowercase hex. */
  readonly invalidNames: readonly string[]

  /**
   * Creates the error for the given invalid secret names.
   *
   * @param invalidNames - Names of the secrets with invalid values.
   */
  constructor(invalidNames: readonly string[]) {
    super(
      `.env has invalid values for ${invalidNames.join(', ')}. ` +
        'Each must be a 64-character lowercase hex value; fix or remove the line and run again.',
    )
    this.name = 'InvalidLocalEnvironmentError'
    this.invalidNames = invalidNames
  }
}

/**
 * Generates one local secret as 32 random bytes in lowercase hex, the same shape as `openssl rand -hex 32`.
 *
 * @returns A 64-character lowercase hex string.
 */
export function generateLocalSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Finds the line that assigns a variable in dotenv text.
 *
 * @param lines - The dotenv text split into lines.
 * @param name - The variable name to look for.
 * @returns The index of the last assigning line and its unquoted value, or `undefined` when absent.
 */
function findAssignment(lines: readonly string[], name: string): { index: number; value: string } | undefined {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`)
  let found: { index: number; value: string } | undefined
  lines.forEach((line, index) => {
    const match = pattern.exec(line)
    if (match) found = { index, value: unquote(match[1] ?? '') }
  })
  return found
}

/**
 * Reads a dotenv value: removes surrounding whitespace, an inline `#` comment, and one pair of matching quotes.
 *
 * @param raw - The text after `=`.
 * @returns The bare value.
 */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(trimmed)
  if (quoted) return quoted[2] ?? ''
  return trimmed.replace(/(?:^|\s+)#.*$/, '')
}

/**
 * Plans the root `.env` so that every required secret is present, without changing values that already exist.
 *
 * A missing `.env` starts from the `.env.example` template. Empty or missing secrets are generated;
 * an existing value that is not 64-character lowercase hex is reported instead of being replaced,
 * because the local Workspace audit data depends on keeping the same key.
 *
 * @param existing - Current `.env` content, or `undefined` when the file does not exist.
 * @param template - The `.env.example` content.
 * @param generate - Produces a new secret value.
 * @returns The content to write and the generated secret names.
 * @throws InvalidLocalEnvironmentError When an existing secret value is malformed.
 */
export function planLocalEnvironment(
  existing: string | undefined,
  template: string,
  generate: () => string = generateLocalSecret,
): LocalEnvironmentPlan {
  const lines = (existing ?? template).split('\n')
  const invalid = requiredLocalSecretNames.filter((name) => {
    const value = findAssignment(lines, name)?.value
    return value !== undefined && value !== '' && !localSecretPattern.test(value)
  })
  if (existing !== undefined && invalid.length > 0) throw new InvalidLocalEnvironmentError(invalid)

  const generated: string[] = []
  for (const name of requiredLocalSecretNames) {
    const assignment = findAssignment(lines, name)
    if (assignment && localSecretPattern.test(assignment.value)) continue
    const line = `${name}=${generate()}`
    if (assignment) {
      lines[assignment.index] = line
    } else {
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      lines.push(line, '')
    }
    generated.push(name)
  }

  if (existing !== undefined && generated.length === 0) return { content: undefined, generated }
  return { content: lines.join('\n'), generated }
}

/**
 * Outcome of preparing the local environment.
 */
export interface LocalEnvironmentSetup {
  /** Names of the secrets that were generated. */
  readonly generated: readonly string[]
  /** The value of each required secret as written in `.env`. */
  readonly secrets: Readonly<Record<string, string>>
}

/**
 * Reads the required secrets from dotenv text.
 *
 * @param content - The `.env` content.
 * @returns Each required secret that has a value, keyed by name.
 */
export function readLocalSecrets(content: string): Record<string, string> {
  const lines = content.split('\n')
  const secrets: Record<string, string> = {}
  for (const name of requiredLocalSecretNames) {
    const value = findAssignment(lines, name)?.value
    if (value) secrets[name] = value
  }
  return secrets
}

/**
 * Creates or completes the root `.env` and the `.floci/generated` directory for local development.
 *
 * The `.env` file is written owner-only (0600). A missing generated directory is created writable for the
 * Floci container user with the sticky bit set; it holds no secrets. An existing directory is left as is.
 *
 * @param repositoryRoot - The repository root directory.
 * @returns The generated secret names and the secret values now in `.env`.
 */
export function setupLocalEnvironment(repositoryRoot: string): LocalEnvironmentSetup {
  const envPath = join(repositoryRoot, '.env')
  const template = readFileSync(join(repositoryRoot, '.env.example'), 'utf8')
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : undefined
  const plan = planLocalEnvironment(existing, template)
  // Restrict an existing file before writing so generated secrets are never readable by others.
  if (existing !== undefined) chmodSync(envPath, 0o600)
  if (plan.content !== undefined) writeFileSync(envPath, plan.content, { mode: 0o600 })
  chmodSync(envPath, 0o600)

  const generatedDirectory = join(repositoryRoot, '.floci', 'generated')
  if (!existsSync(generatedDirectory)) {
    mkdirSync(generatedDirectory, { recursive: true })
    // The Floci container runs as uid 1001, so on native Linux the bind mount must be writable by others.
    // The sticky bit stops other host users from replacing files that Floci wrote.
    chmodSync(generatedDirectory, 0o1777)
  }
  return { generated: plan.generated, secrets: readLocalSecrets(plan.content ?? existing ?? '') }
}

if (import.meta.main) {
  try {
    const { generated } = setupLocalEnvironment(resolve(import.meta.dir, '..'))
    console.log(
      generated.length > 0
        ? `.env: generated ${generated.join(', ')}.`
        : '.env: all required secrets are already set.',
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
