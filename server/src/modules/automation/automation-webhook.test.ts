import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
} from '@mukuroji/contracts'
import {
  validateCreateAutomationRuleInput,
} from './domain/rule-validation'
import type { AutomationActionExecutionContext } from './application/ports'
import {
  AUTOMATION_WEBHOOK_SECRET_PREFIX,
  createAutomationWebhookSecretId,
  createAutomationWebhookSignature,
  deliverAutomationWebhook,
  resolveAutomationWebhookAddress,
  sendAutomationWebhookRequest,
  type AutomationWebhookRequest,
} from './automation-webhook'
import {
  isAutomationWebhookSecretAlias,
  isPublicAutomationWebhookAddress,
  readAutomationWebhookEndpoint,
} from './automation-webhook-policy'

const execution: AutomationExecution = {
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  id: 'execution-1',
  workspaceId: 'workspace-1',
  ruleId: 'rule-1',
  ruleVersion: 1,
  triggerEventId: 'event-1',
  status: 'running',
  attempts: 1,
  actions: [{
    actionIndex: 0,
    actionId: 'execution-1:action:0000',
    status: 'running',
    attempts: 1,
  }],
  startedAt: '2026-07-16T00:00:00.000Z',
  retryable: false,
}

const context: AutomationActionExecutionContext = {
  execution,
  event: {
    eventId: 'event-1',
    eventType: 'work-item.updated',
    workspaceId: 'workspace-1',
    occurredAt: '2026-07-16T00:00:00.000Z',
    changes: [],
  },
  actionIndex: 0,
  idempotencyKey: 'execution-1:action:0000',
}

describe('automation webhook security', () => {
  test('normalizes safe stored actions and rejects unsafe URL or secret reference input', () => {
    const createInput = (url: string, secretReference?: string) => ({
      actions: [{
        type: 'webhook' as const,
        url,
        ...(secretReference === undefined ? {} : { secretReference }),
      }],
      enabled: false,
      name: 'Safe outbound webhook',
      trigger: { type: 'status' as const },
    })

    expect(validateCreateAutomationRuleInput(
      createInput('https://example.com/hooks/one', 'partner_primary'),
    ).actions[0]).toEqual({
      type: 'webhook',
      url: 'https://example.com/hooks/one',
      secretReference: 'partner_primary',
    })
    for (const url of [
      'http://example.com/hooks/one',
      'https://user:password@example.com/hooks/one',
      'https://example.com:8443/hooks/one',
      'https://127.0.0.1/hooks/one',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      expect(() => validateCreateAutomationRuleInput(createInput(url))).toThrow(
        'Automation webhook URL must use public HTTPS',
      )
    }
    for (const secretReference of ['folder/partner', 'arn:aws:secretsmanager:secret', 'x'.repeat(129)]) {
      expect(() => validateCreateAutomationRuleInput(
        createInput('https://example.com/hooks/one', secretReference),
      )).toThrow()
    }
  })

  test('accepts only HTTPS endpoints without credentials, custom ports, or reserved targets', () => {
    expect(readAutomationWebhookEndpoint('https://example.com/hooks/one')).toBeInstanceOf(URL)
    expect(readAutomationWebhookEndpoint('https://example.com:443/hooks/one')).toBeInstanceOf(URL)
    expect(readAutomationWebhookEndpoint('https://8.8.8.8/hooks/one')).toBeInstanceOf(URL)
    expect(readAutomationWebhookEndpoint('https://[2606:4700:4700::1111]/hooks/one')).toBeInstanceOf(URL)

    for (const endpoint of [
      'http://example.com/hooks/one',
      'https://user:password@example.com/hooks/one',
      'https://example.com:8443/hooks/one',
      'https://localhost/hooks/one',
      'https://metadata.internal/hooks/one',
      'https://127.0.0.1/hooks/one',
      'https://10.0.0.1/hooks/one',
      'https://169.254.169.254/latest/meta-data',
      'https://192.0.2.10/hooks/one',
      'https://[::1]/hooks/one',
      'https://[fc00::1]/hooks/one',
      'https://[2001:db8::1]/hooks/one',
    ]) {
      expect(readAutomationWebhookEndpoint(endpoint)).toBeUndefined()
    }
  })

  test('classifies public and reserved addresses before opening a socket', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicAutomationWebhookAddress(address)).toBe(true)
    }
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.31.0.1',
      '192.168.0.1',
      '198.51.100.10',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
    ]) {
      expect(isPublicAutomationWebhookAddress(address)).toBe(false)
    }
  })

  test('rejects a hostname if any DNS answer is private and pins a public answer', async () => {
    let lookupCalls = 0
    const publicAddress = await resolveAutomationWebhookAddress('example.com', async () => {
      lookupCalls += 1
      return [{ address: '93.184.216.34', family: 4 }]
    })

    expect(publicAddress).toEqual({ address: '93.184.216.34', family: 4 })
    expect(lookupCalls).toBe(1)
    await expect(resolveAutomationWebhookAddress('example.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])).rejects.toMatchObject({
      code: 'AutomationWebhookEndpointRejected',
      retryable: false,
    })
    await expect(resolveAutomationWebhookAddress('example.com', async () => {
      throw new Error('resolver failed')
    })).rejects.toMatchObject({
      code: 'AutomationWebhookDnsUnavailable',
      retryable: true,
    })
  })

  test('stops the production transport before request creation for private DNS', async () => {
    const request: AutomationWebhookRequest = {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 100,
    }
    await expect(sendAutomationWebhookRequest(
      new URL('https://example.com/hooks/one'),
      request,
      async () => [{ address: '169.254.169.254', family: 4 }],
    )).rejects.toMatchObject({ code: 'AutomationWebhookEndpointRejected' })
  })

  test('scopes secret aliases by workspace hash and signs timestamp.body', () => {
    expect(isAutomationWebhookSecretAlias('partner_primary.v2')).toBe(true)
    expect(isAutomationWebhookSecretAlias('folder/partner')).toBe(false)
    expect(isAutomationWebhookSecretAlias('arn:aws:secretsmanager:secret')).toBe(false)
    expect(isAutomationWebhookSecretAlias('x'.repeat(129))).toBe(false)
    expect(createAutomationWebhookSecretId('workspace-1', 'partner_primary.v2')).toBe(
      `${AUTOMATION_WEBHOOK_SECRET_PREFIX}/` +
      '484d4f88b59b95fc9409ad7018107c51e26f7cc196e3e48caa9f7ccbfb509fbf/' +
      'partner_primary.v2',
    )
    expect(createAutomationWebhookSignature(
      Buffer.from('top-secret'),
      '1721260800',
      '{"hello":"world"}',
    )).toBe('sha256=c70ae7b2165ecef6a013b9d9b66560dd687b7ca25301bbc34e6a3045f360983f')
  })

  test('sends only the HMAC signature and never exposes the secret alias or value', async () => {
    let capturedEndpoint: URL | undefined
    let capturedRequest: AutomationWebhookRequest | undefined
    const secretAlias = 'partner_primary'
    const secretValue = 'do-not-send-this-secret'

    await deliverAutomationWebhook({
      type: 'webhook',
      url: 'https://example.com/hooks/one',
      secretReference: secretAlias,
      body: { hello: 'world' },
    }, context, {
      now: () => new Date('2024-07-18T00:00:00.000Z'),
      resolveSecret: async (workspaceId, alias) => {
        expect(workspaceId).toBe('workspace-1')
        expect(alias).toBe(secretAlias)
        return Buffer.from(secretValue)
      },
      sendRequest: async (endpoint, request) => {
        capturedEndpoint = endpoint
        capturedRequest = request
        return 204
      },
    })

    expect(capturedEndpoint?.toString()).toBe('https://example.com/hooks/one')
    expect(capturedRequest).toMatchObject({
      body: '{"hello":"world"}',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'execution-1:action:0000',
        'X-Mukuroji-Event': 'work-item.updated',
        'X-Mukuroji-Timestamp': '1721260800',
      },
      timeoutMs: 10_000,
    })
    expect(capturedRequest?.headers['X-Mukuroji-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/)
    const serializedRequest = JSON.stringify(capturedRequest)
    expect(serializedRequest).not.toContain(secretAlias)
    expect(serializedRequest).not.toContain(secretValue)
    expect(serializedRequest).not.toContain('Secret-Reference')
  })

  test('rejects redirects and redacts secret resolver failures', async () => {
    await expect(deliverAutomationWebhook({
      type: 'webhook',
      url: 'https://example.com/hooks/one',
    }, context, {
      sendRequest: async () => 302,
    })).rejects.toMatchObject({
      code: 'AutomationWebhookRedirectRejected',
      retryable: false,
    })

    let sendCalls = 0
    const secretAlias = 'partner_primary'
    const secretValue = 'do-not-log-this-secret'
    const failure = await deliverAutomationWebhook({
      type: 'webhook',
      url: 'https://example.com/hooks/one',
      secretReference: secretAlias,
    }, context, {
      resolveSecret: async () => {
        throw new Error(`${secretAlias}:${secretValue}`)
      },
      sendRequest: async () => {
        sendCalls += 1
        return 204
      },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'AutomationWebhookSecretUnavailable',
      retryable: true,
    })
    expect(String(failure)).not.toContain(secretAlias)
    expect(String(failure)).not.toContain(secretValue)
    expect(sendCalls).toBe(0)
  })
})
