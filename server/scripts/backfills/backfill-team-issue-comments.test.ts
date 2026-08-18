import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { afterEach, expect, test } from 'bun:test'
import { resolveAccountId } from './backfill-team-issue-comments'

const originalStsSend = Reflect.get(STSClient.prototype, 'send')
const originalAccountId = Bun.env.AWS_ACCOUNT_ID

afterEach(() => {
  Reflect.set(STSClient.prototype, 'send', originalStsSend)
  if (originalAccountId === undefined) {
    delete Bun.env.AWS_ACCOUNT_ID
  } else {
    Bun.env.AWS_ACCOUNT_ID = originalAccountId
  }
})

test('uses the local account sentinel for a Floci endpoint', async () => {
  delete Bun.env.AWS_ACCOUNT_ID

  await expect(resolveAccountId('http://localhost:4566', 'us-east-1')).resolves.toBe('local-account')
})

test('binds an AWS account to the authenticated STS identity', async () => {
  Bun.env.AWS_ACCOUNT_ID = '123456789012'
  let observedCommand: unknown
  if (!Reflect.set(
    STSClient.prototype,
    'send',
    async (command: unknown) => {
      observedCommand = command
      return { Account: '123456789012' }
    },
  )) {
    throw new Error('STS send method could not be isolated.')
  }

  await expect(resolveAccountId(undefined, 'us-east-1')).resolves.toBe('123456789012')
  expect(observedCommand).toBeInstanceOf(GetCallerIdentityCommand)
})

test('rejects an AWS account expectation that differs from STS', async () => {
  Bun.env.AWS_ACCOUNT_ID = '123456789012'
  if (!Reflect.set(
    STSClient.prototype,
    'send',
    async () => ({ Account: '210987654321' }),
  )) {
    throw new Error('STS send method could not be isolated.')
  }

  await expect(resolveAccountId(undefined, 'us-east-1')).rejects.toThrow(
    'AWS_ACCOUNT_ID does not match the authenticated AWS account.',
  )
})
