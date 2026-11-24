import { describe, expect, test } from 'bun:test'
import type { ChannelDestinationRecord, ChannelDestinationTarget } from '../domain/channel-destination'
import { NotificationError } from '../domain/notification-error'
import {
  deleteChannelDestination,
  readChannelDestinationSaveBody,
  readExpectedRevision,
  readPersonalSlackWebhookUrl,
  saveChannelDestination,
  testNotificationDestination,
  toPublicChannelDestination,
} from './notification-destinations'
import type { ChannelDestinationStore, SaveChannelDestinationInput } from './ports/channel-posts'

const url = 'https://hooks.slack.com/services/TTEST/BTEST/TESTTOKEN'
const target: ChannelDestinationTarget = { scope: 'project', teamId: 'core', projectId: 'alpha' }
const now = new Date('2026-11-24T00:00:00.000Z')

/**
 * Builds an in-memory settings store.
 * @param initial - Saved settings, if any.
 * @returns The store and the operations it saw.
 */
function memoryStore(initial?: ChannelDestinationRecord) {
  let record = initial
  const calls: string[] = []
  const store: ChannelDestinationStore = {
    async get() { return record },
    async save(input: SaveChannelDestinationInput) {
      calls.push('save')
      record = {
        target: input.target, provider: 'slack', ...(input.label ? { label: input.label } : {}), locale: input.locale,
        revision: input.expectedRevision + 1, updatedAt: input.now.toISOString(), updatedBy: input.updatedBy,
      }
      return record
    },
    async delete() { calls.push('delete'); record = undefined },
  }
  return { store, calls }
}

/**
 * Builds an in-memory webhook store.
 * @returns The store and the secrets it holds.
 */
function memorySecrets() {
  const values = new Map<string, string>()
  const calls: string[] = []
  return {
    values,
    calls,
    secrets: {
      async put(secretId: string, value: string) { calls.push('put'); values.set(secretId, value) },
      async read(secretId: string) { return values.get(secretId) },
      async exists(secretId: string) { return values.has(secretId) },
      async delete(secretId: string) { calls.push('delete'); values.delete(secretId) },
    },
  }
}

describe('destination request validation', () => {
  test('accepts official Slack webhooks and refuses anything else without echoing it', () => {
    expect(readPersonalSlackWebhookUrl({ webhookUrl: ` ${url} ` })).toBe(url)
    for (const webhookUrl of [url.replace('https:', 'http:'), url.replace('hooks.slack.com', 'hooks.slack.com.evil.test'), `${url}?x=1`, 42, undefined]) {
      try {
        readPersonalSlackWebhookUrl({ webhookUrl })
        throw new Error('Must refuse')
      } catch (error) {
        expect(error).toBeInstanceOf(NotificationError)
        expect(String(error)).not.toContain('TESTTOKEN')
      }
    }
  })

  test('reads the channel save body and its revision', () => {
    expect(readChannelDestinationSaveBody({ webhookUrl: url, label: ' #alpha\n', locale: 'en', expectedRevision: 0 }))
      .toEqual({ webhookUrl: url, label: '#alpha', locale: 'en', expectedRevision: 0 })
    expect(readChannelDestinationSaveBody({ label: '', locale: 'ja', expectedRevision: 2 }))
      .toEqual({ locale: 'ja', expectedRevision: 2 })
    expect(() => readChannelDestinationSaveBody({ locale: 'fr', expectedRevision: 0 })).toThrow(NotificationError)
    expect(() => readChannelDestinationSaveBody({ locale: 'ja', expectedRevision: -1 })).toThrow(NotificationError)
    expect(() => readChannelDestinationSaveBody({ locale: 'ja', label: 'x'.repeat(81), expectedRevision: 0 })).toThrow(NotificationError)
    expect(readExpectedRevision('3')).toBe(3)
    expect(() => readExpectedRevision('0')).toThrow(NotificationError)
    expect(() => readExpectedRevision(undefined)).toThrow(NotificationError)
  })
})

describe('channel destination save and delete', () => {
  test('writes the webhook before the settings and never returns it', async () => {
    const { store, calls } = memoryStore()
    const secrets = memorySecrets()
    const record = await saveChannelDestination(store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretId: 'secret-1', memberKey: 'manager@example.test', now,
      body: { webhookUrl: url, label: '#alpha', locale: 'ja', expectedRevision: 0 }, authorizationConditionChecks: [],
    })
    expect(secrets.calls).toEqual(['put'])
    expect(calls).toEqual(['save'])
    expect(secrets.values.get('secret-1')).toBe(url)
    const view = toPublicChannelDestination(target, record, true)
    expect(view).toEqual({
      scope: 'project', teamId: 'core', projectId: 'alpha', configured: true, provider: 'slack', label: '#alpha',
      locale: 'ja', updatedAt: now.toISOString(), revision: 1, canManage: true,
    })
    expect(JSON.stringify(view)).not.toContain('TESTTOKEN')
  })

  test('needs a webhook on the first save and keeps the stored one on a later save', async () => {
    const empty = memoryStore()
    const secrets = memorySecrets()
    await expect(saveChannelDestination(empty.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretId: 'secret-1', memberKey: 'm@example.test', now,
      body: { locale: 'ja', expectedRevision: 0 }, authorizationConditionChecks: [],
    })).rejects.toThrow('required')
    const saved = memoryStore({ target, provider: 'slack', locale: 'ja', revision: 1, updatedAt: now.toISOString(), updatedBy: 'm@example.test' })
    const record = await saveChannelDestination(saved.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretId: 'secret-1', memberKey: 'm@example.test', now,
      body: { locale: 'en', expectedRevision: 1 }, authorizationConditionChecks: [],
    })
    expect(record.locale).toBe('en')
    expect(secrets.calls).toEqual([])
  })

  test('refuses a save based on a stale revision', async () => {
    const saved = memoryStore({ target, provider: 'slack', locale: 'ja', revision: 2, updatedAt: now.toISOString(), updatedBy: 'm@example.test' })
    const secrets = memorySecrets()
    await expect(saveChannelDestination(saved.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretId: 'secret-1', memberKey: 'm@example.test', now,
      body: { webhookUrl: url, locale: 'ja', expectedRevision: 1 }, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
    expect(secrets.calls).toEqual([])
  })

  test('deletes the settings before the webhook', async () => {
    const order: string[] = []
    const saved = memoryStore({ target, provider: 'slack', locale: 'ja', revision: 1, updatedAt: now.toISOString(), updatedBy: 'm@example.test' })
    const store: ChannelDestinationStore = { ...saved.store, async delete(input) { order.push('settings'); await saved.store.delete(input) } }
    await deleteChannelDestination(store, { async delete() { order.push('secret') } }, {
      workspaceId: 'workspace-1', target, secretId: 'secret-1', expectedRevision: 1, authorizationConditionChecks: [],
    })
    expect(order).toEqual(['settings', 'secret'])
  })
})

describe('destination test message', () => {
  test('reports a missing webhook, an accepted message, and a rejection', async () => {
    const secrets = memorySecrets()
    expect(await testNotificationDestination(secrets.secrets, 'secret-1', 'ja', async () => ({ succeeded: true, retryable: false })))
      .toEqual({ delivered: false, code: 'DestinationNotConfigured' })
    secrets.values.set('secret-1', url)
    expect(await testNotificationDestination(secrets.secrets, 'secret-1', 'ja', async (webhookUrl, locale) => {
      expect(webhookUrl).toBe(url)
      expect(locale).toBe('ja')
      return { succeeded: true, retryable: false }
    })).toEqual({ delivered: true })
    expect(await testNotificationDestination(secrets.secrets, 'secret-1', 'en', async () => ({ succeeded: false, retryable: false, code: 'SlackDeliveryRejected' })))
      .toEqual({ delivered: false, code: 'SlackDeliveryRejected' })
    expect(await testNotificationDestination(secrets.secrets, 'secret-1', 'en', async () => ({ succeeded: false, retryable: true, code: 'Other' })))
      .toEqual({ delivered: false, code: 'SlackDeliveryUnavailable' })
  })
})
