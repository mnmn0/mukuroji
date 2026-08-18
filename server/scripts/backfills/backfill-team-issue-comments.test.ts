import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { afterEach, expect, test } from 'bun:test'
import {
  resolveAccountId,
  resolveBackfillIdentity,
} from './backfill-team-issue-comments'

const originalStsSend = Reflect.get(STSClient.prototype, 'send')
const originalAccountId = Bun.env.AWS_ACCOUNT_ID
const originalOperatorId = Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID

afterEach(() => {
  Reflect.set(STSClient.prototype, 'send', originalStsSend)
  if (originalAccountId === undefined) {
    delete Bun.env.AWS_ACCOUNT_ID
  } else {
    Bun.env.AWS_ACCOUNT_ID = originalAccountId
  }
  if (originalOperatorId === undefined) {
    delete Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID
  } else {
    Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID = originalOperatorId
  }
})

test('uses the local account sentinel for a Floci endpoint', async () => {
  delete Bun.env.AWS_ACCOUNT_ID

  await expect(resolveAccountId('http://localhost:4566', 'us-east-1')).resolves.toBe('local-account')
})

test('keeps the local audit sentinel separate from the optional operator label', async () => {
  Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID = 'local-operator'

  await expect(resolveBackfillIdentity('http://localhost:4566', 'us-east-1')).resolves.toEqual({
    accountId: 'local-account',
    operatorId: 'local:backfill',
    operatorLabel: 'local-operator',
  })
})

test('binds an AWS account to the authenticated STS identity', async () => {
  Bun.env.AWS_ACCOUNT_ID = '123456789012'
  Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID = 'release-operator'
  let observedCommand: unknown
  if (!Reflect.set(
    STSClient.prototype,
    'send',
    async (command: unknown) => {
      observedCommand = command
      return {
        Account: '123456789012',
        Arn: 'arn:aws:sts::123456789012:assumed-role/release/backfill',
      }
    },
  )) {
    throw new Error('STS send method could not be isolated.')
  }

  await expect(resolveAccountId(undefined, 'us-east-1')).resolves.toBe('123456789012')
  expect(observedCommand).toBeInstanceOf(GetCallerIdentityCommand)
})

test('records the authenticated STS caller separately from the optional operator label', async () => {
  Bun.env.MUKUROJI_BACKFILL_OPERATOR_ID = 'release-operator'
  if (!Reflect.set(
    STSClient.prototype,
    'send',
    async () => ({
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:role/backfill-role',
    }),
  )) {
    throw new Error('STS send method could not be isolated.')
  }

  await expect(resolveBackfillIdentity(undefined, 'us-east-1')).resolves.toEqual({
    accountId: '123456789012',
    operatorId: 'arn:aws:iam::123456789012:role/backfill-role',
    operatorLabel: 'release-operator',
  })
})

test('rejects an AWS account expectation that differs from STS', async () => {
  Bun.env.AWS_ACCOUNT_ID = '123456789012'
  if (!Reflect.set(
    STSClient.prototype,
    'send',
    async () => ({
      Account: '210987654321',
      Arn: 'arn:aws:iam::210987654321:role/backfill-role',
    }),
  )) {
    throw new Error('STS send method could not be isolated.')
  }

  await expect(resolveAccountId(undefined, 'us-east-1')).rejects.toThrow(
    'AWS_ACCOUNT_ID does not match the authenticated AWS account.',
  )
})
