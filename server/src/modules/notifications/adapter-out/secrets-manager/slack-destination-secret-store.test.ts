import { expect, test } from 'bun:test'
import { CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { SecretsManagerSlackDestinationSecretStore } from './slack-destination-secret-store'

/**
 * Builds an error shaped like an AWS SDK service exception.
 * @param name - Exception name.
 * @returns The error.
 */
function awsError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

test('waits for a just-deleted secret name to be released, then stores the webhook', async () => {
  const sent: string[] = []
  const waits: number[] = []
  let createAttempts = 0
  const store = new SecretsManagerSlackDestinationSecretStore({
    async send(command: unknown) {
      if (command instanceof PutSecretValueCommand) {
        sent.push('put')
        throw awsError('ResourceNotFoundException')
      }
      if (command instanceof CreateSecretCommand) {
        sent.push('create')
        createAttempts += 1
        if (createAttempts < 3) throw awsError('InvalidRequestException')
        return {}
      }
      if (command instanceof DescribeSecretCommand) {
        sent.push('describe')
        return { DeletedDate: new Date() }
      }
      throw new Error('Unexpected command')
    },
  }, async (milliseconds) => { waits.push(milliseconds) })

  await store.put('member-secret', 'https://hooks.slack.com/services/T/B/X')
  expect(sent).toEqual(['put', 'create', 'describe', 'put', 'create', 'describe', 'put', 'create'])
  expect(waits).toEqual([500, 1_000])
})

test('does not retry a refusal that is not a pending name, and gives up after the last wait', async () => {
  let sends = 0
  const denied = new SecretsManagerSlackDestinationSecretStore({
    async send() {
      sends += 1
      throw awsError('AccessDeniedException')
    },
  }, async () => { throw new Error('Must not wait') })
  await expect(denied.put('member-secret', 'https://hooks.slack.com/services/T/B/X')).rejects.toThrow()
  expect(sends).toBe(1)

  const waits: number[] = []
  const pending = new SecretsManagerSlackDestinationSecretStore({
    async send(command: unknown) {
      if (command instanceof DescribeSecretCommand) return { DeletedDate: new Date() }
      throw awsError('InvalidRequestException')
    },
  }, async (milliseconds) => { waits.push(milliseconds) })
  await expect(pending.put('member-secret', 'https://hooks.slack.com/services/T/B/X')).rejects.toThrow()
  expect(waits).toEqual([500, 1_000, 2_000])
})

test('fails at once when the refusal is not a pending deletion', async () => {
  const sent: string[] = []
  const store = new SecretsManagerSlackDestinationSecretStore({
    async send(command: unknown) {
      if (command instanceof DescribeSecretCommand) {
        sent.push('describe')
        return {}
      }
      sent.push('put')
      throw awsError('InvalidRequestException')
    },
  }, async () => { throw new Error('Must not wait') })
  await expect(store.put('member-secret', 'https://hooks.slack.com/services/T/B/X')).rejects.toThrow()
  expect(sent).toEqual(['put', 'describe'])
})
