import { expect, test } from 'bun:test'
import {
  createWorkerSecretEnvironmentHydrator,
  hydrateWorkerSecretEnvironment,
} from './worker-secret-environment'

const secretArn = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:worker-key-AbCdEf'

test('restores a secret from its ARN into the plain environment name', async () => {
  const environment: Record<string, string | undefined> = {
    AWS_LAMBDA_FUNCTION_NAME: 'worker',
    TOKEN_HASH_SECRET_SECRET_ARN: secretArn,
  }
  const loaded: string[] = []
  await hydrateWorkerSecretEnvironment(['TOKEN_HASH_SECRET'], environment, async (arn) => {
    loaded.push(arn)
    return 'k'.repeat(32)
  })

  expect(loaded).toEqual([secretArn])
  expect(environment.TOKEN_HASH_SECRET).toBe('k'.repeat(32))
})

test('keeps a plain value outside Lambda and in the Floci emulator', async () => {
  const local: Record<string, string | undefined> = { TOKEN_HASH_SECRET: 'local' }
  const floci: Record<string, string | undefined> = {
    AWS_LAMBDA_FUNCTION_NAME: 'worker',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    TOKEN_HASH_SECRET: 'local',
  }
  const loader = async () => {
    throw new Error('must not load')
  }
  await hydrateWorkerSecretEnvironment(['TOKEN_HASH_SECRET'], local, loader)
  await hydrateWorkerSecretEnvironment(['TOKEN_HASH_SECRET'], floci, loader)

  expect(local.TOKEN_HASH_SECRET).toBe('local')
  expect(floci.TOKEN_HASH_SECRET).toBe('local')
})

test('rejects a plain secret value in a deployed Lambda', async () => {
  const environment: Record<string, string | undefined> = {
    AWS_LAMBDA_FUNCTION_NAME: 'worker',
    TOKEN_HASH_SECRET: 'leaked-into-configuration',
  }
  await expect(hydrateWorkerSecretEnvironment(
    ['TOKEN_HASH_SECRET'],
    environment,
    async () => 'unused',
  )).rejects.toThrow('Worker secret environment TOKEN_HASH_SECRET is invalid.')
})

test('rejects both a plain value and an ARN, a partial ARN, and an empty secret', async () => {
  const loader = async () => 'value'
  await expect(hydrateWorkerSecretEnvironment(['TOKEN_HASH_SECRET'], {
    TOKEN_HASH_SECRET: 'plain',
    TOKEN_HASH_SECRET_SECRET_ARN: secretArn,
  }, loader)).rejects.toThrow()
  await expect(hydrateWorkerSecretEnvironment(['TOKEN_HASH_SECRET'], {
    TOKEN_HASH_SECRET_SECRET_ARN: 'worker-key',
  }, loader)).rejects.toThrow()
  const environment: Record<string, string | undefined> = {
    TOKEN_HASH_SECRET_SECRET_ARN: secretArn,
  }
  await expect(hydrateWorkerSecretEnvironment(
    ['TOKEN_HASH_SECRET'],
    environment,
    async () => '',
  )).rejects.toThrow()
  expect(environment.TOKEN_HASH_SECRET).toBeUndefined()
})

test('validates every entry before starting any read', async () => {
  let reads = 0
  await expect(hydrateWorkerSecretEnvironment(['FIRST_SECRET', 'SECOND_SECRET'], {
    FIRST_SECRET_SECRET_ARN: secretArn,
    SECOND_SECRET_SECRET_ARN: 'not-an-arn',
  }, async () => {
    reads += 1
    return 'value'
  })).rejects.toThrow('Worker secret environment SECOND_SECRET is invalid.')
  expect(reads).toBe(0)
})

test('applies no value when any secret of the set fails to load', async () => {
  const environment: Record<string, string | undefined> = {
    FIRST_SECRET_SECRET_ARN: secretArn,
    SECOND_SECRET_SECRET_ARN: `${secretArn}2`,
  }
  await expect(hydrateWorkerSecretEnvironment(
    ['FIRST_SECRET', 'SECOND_SECRET'],
    environment,
    async (arn) => {
      if (arn.endsWith('2')) throw new Error('denied')
      return 'first'
    },
  )).rejects.toThrow('denied')
  expect(environment.FIRST_SECRET).toBeUndefined()
})

test('loads once after success and retries after a failure', async () => {
  let calls = 0
  const hydrate = createWorkerSecretEnvironmentHydrator(['TOKEN_HASH_SECRET'], async () => {
    calls += 1
    if (calls === 1) throw new Error('transient')
  })

  await expect(hydrate()).rejects.toThrow('transient')
  await hydrate()
  await hydrate()
  expect(calls).toBe(2)
})
