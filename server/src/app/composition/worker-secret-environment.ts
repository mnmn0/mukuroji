import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'

/** Suffix of the environment variable that carries one secret's ARN. */
const WORKER_SECRET_ARN_SUFFIX = '_SECRET_ARN'

const FULL_SECRETS_MANAGER_ARN_PATTERN =
  /^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,519}$/
const WORKER_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

/**
 * Reads the current secret string of one complete secret ARN.
 *
 * @param secretArn - Complete Secrets Manager secret ARN.
 * @returns The secret string.
 */
export type WorkerSecretLoader = (secretArn: string) => Promise<string>

/**
 * Restores worker secrets from Secrets Manager into the process environment.
 *
 * The stack gives a worker `<NAME>_SECRET_ARN` instead of the plain `<NAME>`
 * value, so the secret never appears in the Lambda configuration. The worker
 * reads it once at cold start and writes it to `<NAME>`, where the existing
 * synchronous readers find it.
 *
 * Local runtimes without an ARN keep the plain value. A deployed Lambda that
 * still receives a plain value fails closed, so a regression in the stack
 * cannot silently move a secret back into the function configuration.
 *
 * @param names - Environment names this worker needs.
 * @param environment - Mutable environment receiving the secret values.
 * @param loadSecret - Secret reader overridden by isolated unit tests.
 * @returns A promise resolved after every configured secret is applied.
 */
export async function hydrateWorkerSecretEnvironment(
  names: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  loadSecret: WorkerSecretLoader = loadWorkerSecret,
): Promise<void> {
  const pending: Array<Promise<readonly [string, string]>> = []
  for (const name of names) {
    if (!WORKER_SECRET_NAME_PATTERN.test(name)) {
      throw createInvalidWorkerSecretEnvironmentError(name)
    }
    const secretArn = environment[`${name}${WORKER_SECRET_ARN_SUFFIX}`]
    const plainValue = environment[name]
    if (secretArn === undefined) {
      if (plainValue !== undefined && isDeployedLambda(environment)) {
        throw createInvalidWorkerSecretEnvironmentError(name)
      }
      continue
    }
    if (plainValue !== undefined || !FULL_SECRETS_MANAGER_ARN_PATTERN.test(secretArn)) {
      throw createInvalidWorkerSecretEnvironmentError(name)
    }
    pending.push(loadSecret(secretArn).then((value) => [name, value] as const))
  }
  const loaded = await Promise.all(pending)
  for (const [name, value] of loaded) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw createInvalidWorkerSecretEnvironmentError(name)
    }
  }
  for (const [name, value] of loaded) {
    environment[name] = value
  }
}

/**
 * Creates a single-flight cold-start hydrator for one worker.
 *
 * A failed load is not cached, so the next invocation retries it.
 *
 * @param names - Environment names this worker needs.
 * @param hydrate - Hydration implementation overridden by isolated unit tests.
 * @returns A function that resolves once the secrets are in the environment.
 */
export function createWorkerSecretEnvironmentHydrator(
  names: readonly string[],
  hydrate: (names: readonly string[]) => Promise<void> = hydrateWorkerSecretEnvironment,
): () => Promise<void> {
  let hydrated = false
  let pending: Promise<void> | undefined
  return async () => {
    if (hydrated) return
    const current = pending ??= hydrate(names)
    try {
      await current
      hydrated = true
    } catch (error) {
      if (pending === current) pending = undefined
      throw error
    }
  }
}

/** Returns whether the environment belongs to a deployed AWS Lambda, not the Floci emulator. */
function isDeployedLambda(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(environment.AWS_LAMBDA_FUNCTION_NAME?.trim()) &&
    environment.MUKUROJI_LOCAL_AWS_RUNTIME !== 'floci'
}

/** Reads one secret string with the configured Secrets Manager client. */
async function loadWorkerSecret(secretArn: string): Promise<string> {
  const response = await createSecretsManagerClient().send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  )
  if (typeof response.SecretString !== 'string') {
    throw new Error('Worker secret is not a string secret.')
  }
  return response.SecretString
}

/** Creates an error that names the variable but never its value. */
function createInvalidWorkerSecretEnvironmentError(name: string): Error {
  return new Error(`Worker secret environment ${name} is invalid.`)
}
