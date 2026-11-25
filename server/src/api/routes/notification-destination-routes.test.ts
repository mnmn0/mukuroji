import { afterEach, expect, test } from 'bun:test'
import type {
  ChannelDestinationRecord,
  ChannelDestinationStore,
  DeleteChannelDestinationInput,
  SaveChannelDestinationInput,
} from '../../modules/notifications'
import { createApiTestHarness } from '../test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp, setTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Webhook typed by the manager in these tests. */
const webhookUrl = 'https://hooks.slack.com/services/TTEST/BTEST/ROUTESECRET'

/**
 * Installs in-memory destination settings and webhook stores.
 * @returns The stores' recorded state.
 */
function installStores() {
  const records = new Map<string, ChannelDestinationRecord>()
  const secrets = new Map<string, string>()
  const channelDestinations: ChannelDestinationStore = {
    async get(_workspaceId, target) { return records.get(JSON.stringify(target)) },
    async getRevision(_workspaceId, target) { return records.get(JSON.stringify(target))?.revision ?? 0 },
    async save(input: SaveChannelDestinationInput) {
      const record: ChannelDestinationRecord = {
        target: input.target, provider: 'slack', ...(input.label ? { label: input.label } : {}), locale: input.locale,
        revision: input.expectedRevision + 1, updatedAt: input.now.toISOString(), updatedBy: input.updatedBy,
        secretVersion: input.secretVersion,
      }
      records.set(JSON.stringify(input.target), record)
      return record
    },
    async delete(input: DeleteChannelDestinationInput) { records.delete(JSON.stringify(input.target)) },
    async getState(_workspaceId, target) {
      const record = records.get(JSON.stringify(target))
      return record ? { record, revision: record.revision } : { revision: 0 }
    },
    async recordAudit() {},
    personalAuditEntityId() { return 'workspace/wsp_test/member/mbr_test/slack-destination' },
  }
  setTestAppDependencies({
    channelDestinations,
    notificationDestinationSecrets: {
      async put(secretId, value) { secrets.set(secretId, value) },
      async read(secretId) { return secrets.get(secretId) },
      async exists(secretId) { return secrets.has(secretId) },
      async delete(secretId) { secrets.delete(secretId) },
    },
  })
  return { records, secrets }
}

/**
 * Sends an authenticated request.
 * @param path - Request path.
 * @param init - Method and body.
 * @returns The response.
 */
async function request(path: string, init: { method?: string, body?: unknown } = {}) {
  return await app.request(path, {
    method: init.method ?? 'GET',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

test('a Team viewer reads the Team channel but cannot change or test it', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const state = installStores()

  const read = await request('/api/teams/core-team/notification-channel')
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ scope: 'team', teamId: 'core-team', configured: false, canManage: false })

  const save = await request('/api/teams/core-team/notification-channel', {
    method: 'PUT', body: { webhookUrl, locale: 'ja', expectedRevision: 0 },
  })
  expect(save.status).toBe(403)
  expect((await request('/api/teams/core-team/notification-channel/test', { method: 'POST', body: {} })).status).toBe(403)
  expect((await request('/api/teams/core-team/notification-channel?expectedRevision=1', { method: 'DELETE' })).status).toBe(403)
  expect(state.secrets.size).toBe(0)
  expect(state.records.size).toBe(0)
})

test('a manager saves a Team channel without the webhook coming back, and a stale revision conflicts', async () => {
  configureFakeProjectClients(true, { role: 'manager' })
  const state = installStores()

  const save = await request('/api/teams/core-team/notification-channel', {
    method: 'PUT', body: { webhookUrl, label: '#core', locale: 'en', expectedRevision: 0 },
  })
  expect(save.status).toBe(200)
  const body = await save.text()
  expect(body).not.toContain('ROUTESECRET')
  expect(JSON.parse(body)).toMatchObject({ configured: true, label: '#core', locale: 'en', revision: 1, canManage: true })
  expect([...state.secrets.values()]).toEqual([webhookUrl])

  const stale = await request('/api/teams/core-team/notification-channel', {
    method: 'PUT', body: { locale: 'ja', expectedRevision: 0 },
  })
  expect(stale.status).toBe(409)

  const read = await request('/api/teams/core-team/notification-channel')
  expect(await read.text()).not.toContain('ROUTESECRET')
})

test('refuses a webhook that is not an official Slack URL without echoing it', async () => {
  configureFakeProjectClients(true, { role: 'manager' })
  const state = installStores()

  const response = await request('/api/teams/core-team/notification-channel', {
    method: 'PUT', body: { webhookUrl: 'https://hooks.slack.com.evil.test/services/T/B/ROUTESECRET', locale: 'ja', expectedRevision: 0 },
  })
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain('ROUTESECRET')
  expect(state.secrets.size).toBe(0)
})

test('a Project outside the Team answers 404', async () => {
  configureFakeProjectClients(true, { role: 'manager' })
  installStores()

  const response = await request('/api/teams/core-team/projects/not-in-core/notification-channel')
  expect(response.status).toBe(404)
})

test('requires a bearer token', async () => {
  installStores()
  const response = await app.request('/api/notification-preferences/slack-destination')
  expect(response.status).toBe(401)
})

test('a member registers, reads, and removes their own Slack destination', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const state = installStores()

  const save = await request('/api/notification-preferences/slack-destination', { method: 'PUT', body: { webhookUrl } })
  expect(save.status).toBe(200)
  expect(await save.json()).toEqual({ configured: true })
  expect(state.secrets.size).toBe(1)
  expect(await (await request('/api/notification-preferences/slack-destination')).json()).toEqual({ configured: true })

  const removed = await request('/api/notification-preferences/slack-destination', { method: 'DELETE' })
  expect(await removed.json()).toEqual({ configured: false })
  expect(state.secrets.size).toBe(0)
})
