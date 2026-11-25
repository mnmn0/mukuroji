import { describe, expect, test } from 'bun:test'
import type { ChannelDestinationRecord, ChannelDestinationTarget } from '../domain/channel-destination'
import { NotificationError } from '../domain/notification-error'
import {
  deleteChannelDestination,
  deletePersonalSlackDestination,
  readChannelDestinationSaveBody,
  readExpectedRevision,
  readPersonalSlackWebhookUrl,
  saveChannelDestination,
  savePersonalSlackDestination,
  testNotificationDestination,
  toPublicChannelDestination,
} from './notification-destinations'
import type { ChannelDestinationStore, SaveChannelDestinationInput } from './ports/channel-posts'

const url = 'https://hooks.slack.com/services/TTEST/BTEST/TESTTOKEN'
const target: ChannelDestinationTarget = { scope: 'project', teamId: 'core', projectId: 'alpha' }
const now = new Date('2026-11-24T00:00:00.000Z')

/** Version of the webhook saved first. */
const v1 = '00000000-0000-4000-8000-000000000001'
/** Version of a replacement webhook. */
const v2 = '00000000-0000-4000-8000-000000000002'

/**
 * Builds saved settings.
 * @param revision - Saved revision.
 * @param secretVersion - Webhook version the settings point at.
 * @returns Saved settings.
 */
function saved(revision: number, secretVersion = v1): ChannelDestinationRecord {
  return { target, provider: 'slack', locale: 'ja', revision, updatedAt: now.toISOString(), updatedBy: 'm@example.test', secretVersion }
}

/**
 * Builds an in-memory settings store.
 * @param initial - Saved settings, if any.
 * @param rejectSave - Error a save throws, as a lost fence would.
 * @returns The store and the operations it saw.
 */
function memoryStore(initial?: ChannelDestinationRecord, rejectSave?: Error, calls: string[] = []) {
  let record = initial
  let removedRevision = 0
  const store: ChannelDestinationStore = {
    async get() { return record },
    async getRevision() { return record?.revision ?? removedRevision },
    async save(input: SaveChannelDestinationInput) {
      calls.push('save')
      if (rejectSave) throw rejectSave
      const next: ChannelDestinationRecord = {
        target: input.target, provider: 'slack', ...(input.label ? { label: input.label } : {}), locale: input.locale,
        revision: input.expectedRevision + 1, updatedAt: input.now.toISOString(), updatedBy: input.updatedBy,
        secretVersion: input.secretVersion,
      }
      record = next
      return next
    },
    async delete(input) { calls.push('delete'); record = undefined; removedRevision = input.expectedRevision + 1 },
    async getState() { return record ? { record, revision: record.revision } : { revision: removedRevision } },
    async recordAudit() { calls.push('audit') },
    personalAuditEntityId() { return 'member-pseudonym/slack-destination' },
  }
  return { store, calls, current: () => record }
}

/**
 * Builds an in-memory webhook store.
 * @returns The store and the secrets it holds.
 */
function memorySecrets(calls: string[] = []) {
  const values = new Map<string, string>()
  return {
    values,
    calls,
    secrets: {
      async put(secretId: string, value: string) { calls.push(`put ${secretId}`); values.set(secretId, value) },
      async read(secretId: string) { return values.get(secretId) },
      async exists(secretId: string) { return values.has(secretId) },
      async delete(secretId: string) { calls.push(`delete ${secretId}`); values.delete(secretId) },
    },
  }
}

/**
 * Names a webhook version in these tests.
 * @param version - Webhook version.
 * @returns Secret name.
 */
const secretIdOf = (version: string) => `secret/${version}`

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
  test('writes the webhook under a new version before the settings and never returns it', async () => {
    const history: string[] = []
    const { store } = memoryStore(undefined, undefined, history)
    const secrets = memorySecrets(history)
    const record = await saveChannelDestination(store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v1, memberKey: 'manager@example.test', now,
      body: { webhookUrl: url, label: '#alpha', locale: 'ja', expectedRevision: 0 }, authorizationConditionChecks: [],
    })
    expect(history).toEqual([`put secret/${v1}`, 'save'])
    expect(record.secretVersion).toBe(v1)
    expect(secrets.values.get(`secret/${v1}`)).toBe(url)
    const view = toPublicChannelDestination(target, record, true)
    expect(view).toEqual({
      scope: 'project', teamId: 'core', projectId: 'alpha', configured: true, provider: 'slack', label: '#alpha',
      locale: 'ja', updatedAt: now.toISOString(), revision: 1, canManage: true,
    })
    expect(JSON.stringify(view)).not.toContain('TESTTOKEN')
  })

  test('needs a webhook on the first save and keeps the stored version on a later save', async () => {
    const empty = memoryStore()
    const secrets = memorySecrets()
    await expect(saveChannelDestination(empty.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v1, memberKey: 'm@example.test', now,
      body: { locale: 'ja', expectedRevision: 0 }, authorizationConditionChecks: [],
    })).rejects.toThrow('required')
    const existing = memoryStore(saved(1))
    const record = await saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { locale: 'en', expectedRevision: 1 }, authorizationConditionChecks: [],
    })
    expect(record.locale).toBe('en')
    expect(record.secretVersion).toBe(v1)
    expect(secrets.calls).toEqual([])
  })

  test('switches to a replacement webhook only after the save commits, then removes the old one', async () => {
    const history: string[] = []
    const existing = memoryStore(saved(1), undefined, history)
    const secrets = memorySecrets(history)
    secrets.values.set(`secret/${v1}`, url)
    const replacement = url.replace('TESTTOKEN', 'NEWTOKEN')
    const record = await saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: replacement, locale: 'ja', expectedRevision: 1 }, authorizationConditionChecks: [],
    })
    expect(record.secretVersion).toBe(v2)
    expect(history).toEqual([`put secret/${v2}`, 'save', `delete secret/${v1}`])
    expect([...secrets.values.entries()]).toEqual([[`secret/${v2}`, replacement]])
  })

  test('a save rejected by its fences leaves the effective webhook unchanged', async () => {
    const fenceLost = new NotificationError(409, 'NotificationDestinationAuthorizationChanged', 'Permissions changed.')
    const existing = memoryStore(saved(1), fenceLost)
    const secrets = memorySecrets()
    secrets.values.set(`secret/${v1}`, url)
    await expect(saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: url.replace('TESTTOKEN', 'REVOKED'), locale: 'ja', expectedRevision: 1 }, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
    expect(existing.current()?.secretVersion).toBe(v1)
    expect([...secrets.values.entries()]).toEqual([[`secret/${v1}`, url]])
  })

  test('keeps the candidate webhook when the save outcome is unknown', async () => {
    const existing = memoryStore(saved(1), new Error('socket hang up'))
    const secrets = memorySecrets()
    await expect(saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: url, locale: 'ja', expectedRevision: 1 }, authorizationConditionChecks: [],
    })).rejects.toThrow('socket hang up')
    // The save may have committed and pointed at the candidate, so it is not deleted.
    expect(secrets.values.has(`secret/${v2}`)).toBe(true)
  })

  test('continues the revision after a removal, so a request from before cannot touch the new one', async () => {
    const existing = memoryStore(saved(1))
    const secrets = memorySecrets()
    await deleteChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, expectedRevision: 1, authorizationConditionChecks: [],
    })
    await expect(saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: url, locale: 'ja', expectedRevision: 0 }, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
    const again = await saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: url, locale: 'ja', expectedRevision: 2 }, authorizationConditionChecks: [],
    })
    expect(again.revision).toBe(3)
    await expect(deleteChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, expectedRevision: 1, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
    expect(existing.current()?.revision).toBe(3)
  })

  test('refuses a save based on a stale revision', async () => {
    const existing = memoryStore(saved(2))
    const secrets = memorySecrets()
    await expect(saveChannelDestination(existing.store, secrets.secrets, {
      workspaceId: 'workspace-1', target, secretIdOf, newSecretVersion: v2, memberKey: 'm@example.test', now,
      body: { webhookUrl: url, locale: 'ja', expectedRevision: 1 }, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
    expect(secrets.calls).toEqual([])
  })

  test('deletes the settings before the webhook version they point at', async () => {
    const order: string[] = []
    const existing = memoryStore(saved(1))
    const store: ChannelDestinationStore = { ...existing.store, async delete(input) { order.push('settings'); await existing.store.delete(input) } }
    await deleteChannelDestination(store, { async delete(secretId) { order.push(secretId) } }, {
      workspaceId: 'workspace-1', target, secretIdOf, expectedRevision: 1, authorizationConditionChecks: [],
    })
    expect(order).toEqual(['settings', `secret/${v1}`])
    await expect(deleteChannelDestination(store, { async delete() { throw new Error('Must not delete') } }, {
      workspaceId: 'workspace-1', target, secretIdOf, expectedRevision: 1, authorizationConditionChecks: [],
    })).rejects.toMatchObject({ status: 409 })
  })
})

describe('personal destination', () => {
  test('stores and removes the webhook before recording the audit event without the URL', async () => {
    const webhooks = memorySecrets()
    const audits: unknown[] = []
    const audit = { async recordAudit(put: unknown) { webhooks.calls.push('audit'); audits.push(put) } }
    const auditPut = { Put: { TableName: 'audit', Item: { eventType: 'notification-slack-destination.saved' } } }
    await savePersonalSlackDestination(webhooks.secrets, audit, { secretId: 'member-secret', webhookUrl: url, auditPut })
    expect(webhooks.values.get('member-secret')).toBe(url)
    await deletePersonalSlackDestination(webhooks.secrets, audit, { secretId: 'member-secret' })
    expect(webhooks.values.size).toBe(0)
    expect(webhooks.calls).toEqual(['put member-secret', 'audit', 'delete member-secret'])
    expect(JSON.stringify(audits)).not.toContain('hooks.slack.com')
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
