import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import {
  AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES,
  createAutomationInboundWebhookSecretId,
  createAutomationInboundWebhookSecretVersionId,
  isAutomationInboundWebhookJsonContentType,
  parseAutomationInboundWebhookJson,
  readAutomationInboundWebhookBody,
  readAutomationInboundWebhookTimestamp,
  SecretsManagerAutomationInboundWebhookSecretStore,
  verifyAutomationInboundWebhookSignature,
} from './automation-inbound-webhook'

function createSecretsManagerProbe() {
  const versions = new Map<string, string>()
  const commands: Array<{ input: Record<string, unknown>; name: string }> = []
  let loseNextWriteResponse = false
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      commands.push({ input: structuredClone(input), name })
      const secretId = String(input.SecretId ?? input.Name)
      const versionId = String(input.VersionId ?? input.ClientRequestToken)
      if (name === 'DescribeSecretCommand') {
        if ([...versions.keys()].some((key) => key.startsWith(`${secretId}\0`))) return {}
        throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
      }
      if (name === 'GetSecretValueCommand') {
        const secret = versions.get(`${secretId}\0${versionId}`)
        if (secret === undefined) {
          throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
        }
        return { SecretString: secret, VersionId: versionId }
      }
      if (name === 'CreateSecretCommand' || name === 'PutSecretValueCommand') {
        versions.set(`${secretId}\0${versionId}`, String(input.SecretString))
        if (loseNextWriteResponse) {
          loseNextWriteResponse = false
          throw new Error('write committed but response was lost')
        }
        return { VersionId: versionId }
      }
      if (name === 'DeleteSecretCommand') {
        for (const key of versions.keys()) {
          if (key.startsWith(`${secretId}\0`)) versions.delete(key)
        }
        return {}
      }
      throw new Error(`Unexpected command: ${name}`)
    },
  } as unknown as SecretsManagerClient
  return {
    client,
    commands,
    versions,
    loseNextWrite() {
      loseNextWriteResponse = true
    },
  }
}

describe('inbound webhook raw request verification', () => {
  test('binds the exact timestamp and raw UTF-8 bytes to a lowercase HMAC signature', () => {
    const secret = Buffer.from('server-issued-secret', 'utf8')
    const timestamp = '1784160000'
    const body = Buffer.from('{\n  "message": "こんにちは", "value": 1\n}\n', 'utf8')
    const signature = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.`, 'utf8')
      .update(body)
      .digest('hex')}`

    expect(verifyAutomationInboundWebhookSignature(secret, timestamp, body, signature))
      .toMatch(/^[a-f0-9]{64}$/)
    expect(() => verifyAutomationInboundWebhookSignature(
      secret,
      timestamp,
      Buffer.from('{"message":"こんにちは","value":1}', 'utf8'),
      signature,
    )).toThrow()
    expect(() => verifyAutomationInboundWebhookSignature(
      secret,
      timestamp,
      body,
      signature.toUpperCase(),
    )).toThrow()
    expect(parseAutomationInboundWebhookJson(body)).toEqual({ message: 'こんにちは', value: 1 })
  })

  test('enforces timestamp window, JSON media type, UTF-8, and raw size', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z')
    const nowSeconds = String(Math.floor(now.getTime() / 1_000))
    expect(readAutomationInboundWebhookTimestamp(nowSeconds, now)).toBe(nowSeconds)
    expect(() => readAutomationInboundWebhookTimestamp(
      String(Number(nowSeconds) - 301),
      now,
    )).toThrow()
    expect(() => readAutomationInboundWebhookTimestamp(
      String(Number(nowSeconds) + 301),
      now,
    )).toThrow()
    expect(() => readAutomationInboundWebhookTimestamp(`0${nowSeconds}`, now)).toThrow()

    expect(isAutomationInboundWebhookJsonContentType('application/json')).toBe(true)
    expect(isAutomationInboundWebhookJsonContentType('application/json; charset=UTF-8')).toBe(true)
    expect(isAutomationInboundWebhookJsonContentType('application/problem+json')).toBe(false)
    expect(isAutomationInboundWebhookJsonContentType('application/json; charset=shift_jis')).toBe(false)
    expect(() => parseAutomationInboundWebhookJson(Uint8Array.from([0xff]))).toThrow()

    const request = new Request('https://example.com', {
      method: 'POST',
      body: new Uint8Array(AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES + 1),
      headers: { 'Content-Type': 'application/json' },
    })
    await expect(readAutomationInboundWebhookBody(request)).rejects.toMatchObject({
      category: 'payload-too-large',
    })
  })
})

describe('inbound webhook secret provisioning', () => {
  test('keeps the legacy no-argument Secrets Manager store constructor available', () => {
    expect(new SecretsManagerAutomationInboundWebhookSecretStore())
      .toBeInstanceOf(SecretsManagerAutomationInboundWebhookSecretStore)
  })

  test('pins immutable versions and recovers create/rotate response loss without stages', async () => {
    const probe = createSecretsManagerProbe()
    const store = new SecretsManagerAutomationInboundWebhookSecretStore(probe.client)
    const secretId = createAutomationInboundWebhookSecretId('workspace-1', 'webhook-1')
    const firstReference = {
      workspaceId: 'workspace-1',
      endpointId: 'webhook-1',
      secretId,
      secretVersionId: createAutomationInboundWebhookSecretVersionId('operation-create', 1),
      secretGeneration: 1,
    }
    probe.loseNextWrite()
    const firstSecret = await store.provision(firstReference)
    expect(Buffer.from(await store.get(firstReference)).toString('utf8')).toBe(firstSecret)

    const rotatedReference = {
      ...firstReference,
      secretVersionId: createAutomationInboundWebhookSecretVersionId('operation-rotate', 2),
      secretGeneration: 2,
    }
    probe.loseNextWrite()
    const rotatedSecret = await store.provision(rotatedReference)
    expect(rotatedSecret).not.toBe(firstSecret)
    expect(Buffer.from(await store.get(firstReference)).toString('utf8')).toBe(firstSecret)
    expect(Buffer.from(await store.get(rotatedReference)).toString('utf8')).toBe(rotatedSecret)
    expect(probe.commands.find((command) => command.name === 'CreateSecretCommand')?.input)
      .not.toHaveProperty('Tags')
    expect(probe.commands.find((command) => command.name === 'PutSecretValueCommand')?.input)
      .not.toHaveProperty('VersionStages')

    await store.delete(rotatedReference)
    await expect(store.get(rotatedReference)).rejects.toMatchObject({ category: 'unavailable' })
  })

  test('derives deterministic inbound-only secret resource and version IDs', () => {
    expect(createAutomationInboundWebhookSecretId('workspace-1', 'webhook-1'))
      .toMatch(/^mukuroji\/automation-inbound-webhooks\/[a-f0-9]{64}\/webhook-1$/)
    expect(createAutomationInboundWebhookSecretId(
      'workspace-1',
      'webhook-1',
      '/legacy-prefix/',
    )).toMatch(/^\/legacy-prefix\/\/[a-f0-9]{64}\/webhook-1$/)
    expect(createAutomationInboundWebhookSecretVersionId('operation-1', 4))
      .toMatch(/^[a-f0-9]{64}$/)
    expect(createAutomationInboundWebhookSecretVersionId('operation-1', 4))
      .toBe(createAutomationInboundWebhookSecretVersionId('operation-1', 4))
  })
})
