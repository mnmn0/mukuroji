import { afterEach, describe, expect, test } from 'bun:test'
import { agentSettingsFixture } from '../src/features/agent-settings/fixtures'
import {
  getTeamAgentSettings,
  readAgentSettings,
  updateTeamAgentSettings,
} from '../src/features/agent-settings/api/agentSettings'
import { AgentSettingsApiError } from '../src/features/agent-settings/api/errors'
import {
  readAgentSettingsSaveFailure,
  shouldRetainAgentSettingsSaveContext,
} from '../src/features/agent-settings/mutations/useSaveTeamAgentSettings'

const originalFetch = globalThis.fetch
const mutationContext = { correlationId: 'correlation-1', idempotencyKey: 'idempotency-1' }

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** One request captured by the fake fetch. */
type RecordedRequest = {
  /** Request URL. */
  url: string
  /** Request options. */
  init: RequestInit
}

/**
 * Replaces fetch with a fake that answers every request with one response.
 *
 * @param body - JSON response body.
 * @param status - HTTP status.
 * @returns Requests the fake received.
 */
function installFetch(body: unknown, status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  const fakeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Response.json(body, { status })
  }
  globalThis.fetch = fakeFetch
  return requests
}

describe('Agent settings response validation', () => {
  test('accepts saved and default settings', () => {
    expect(readAgentSettings(agentSettingsFixture)).toEqual(agentSettingsFixture)
    const defaults = {
      schemaVersion: 1,
      teamId: 'team-growth',
      revision: 0,
      leaseMinutes: 30,
      allowTakeoverAfterLeaseExpiry: false,
      readyStatusIds: [],
      requireAcceptanceCriteria: false,
      projectBriefs: {},
    }
    expect(readAgentSettings(defaults)).toEqual(defaults)
  })

  test('rejects responses with an unsupported shape', () => {
    const invalid = [
      undefined,
      [],
      { ...agentSettingsFixture, schemaVersion: 2 },
      { ...agentSettingsFixture, teamId: '' },
      { ...agentSettingsFixture, revision: -1 },
      { ...agentSettingsFixture, leaseMinutes: 0 },
      { ...agentSettingsFixture, leaseMinutes: 1.5 },
      { ...agentSettingsFixture, allowTakeoverAfterLeaseExpiry: 'true' },
      { ...agentSettingsFixture, readyStatusIds: ['ready', ''] },
      { ...agentSettingsFixture, readyStatusIds: 'ready' },
      { ...agentSettingsFixture, requireAcceptanceCriteria: undefined },
      { ...agentSettingsFixture, acceptanceCriteriaFieldId: '' },
      { ...agentSettingsFixture, brief: 42 },
      { ...agentSettingsFixture, projectBriefs: { 'project-api': 7 } },
      { ...agentSettingsFixture, projectBriefs: ['brief'] },
      { ...agentSettingsFixture, updatedAt: 'yesterday' },
    ]
    for (const value of invalid) expect(readAgentSettings(value)).toBeUndefined()
  })

  test('keeps a Project ID named __proto__ as an ordinary brief', () => {
    const settings = readAgentSettings({ ...agentSettingsFixture, projectBriefs: JSON.parse('{"__proto__":"brief"}') })
    expect(settings && Object.hasOwn(settings.projectBriefs, '__proto__')).toBeTrue()
  })
})

describe('Agent settings API', () => {
  test('reads a Team and rejects a response for another Team', async () => {
    const requests = installFetch(agentSettingsFixture)
    expect(await getTeamAgentSettings('token', 'team-platform')).toEqual(agentSettingsFixture)
    expect(requests[0]?.url).toEndWith('/teams/team-platform/agent-settings')
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe('Bearer token')

    installFetch({ ...agentSettingsFixture, teamId: 'team-other' })
    const error = await getTeamAgentSettings('token', 'team-platform').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentSettingsApiError)
    expect(error).toMatchObject({ status: 502 })
  })

  test('sends the full replacement with idempotency headers', async () => {
    const requests = installFetch(agentSettingsFixture)
    const body = {
      expectedRevision: 3,
      leaseMinutes: 45,
      allowTakeoverAfterLeaseExpiry: true,
      readyStatusIds: ['ready'],
      requireAcceptanceCriteria: true,
      projectBriefs: {},
    }
    await updateTeamAgentSettings('token', 'team-platform', body, mutationContext)
    const headers = new Headers(requests[0]?.init.headers)
    expect(requests[0]?.init.method).toBe('PUT')
    expect(headers.get('Idempotency-Key')).toBe('idempotency-1')
    expect(headers.get('X-Correlation-Id')).toBe('correlation-1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(body)
  })

  test('keeps the server code and message of a failure', async () => {
    installFetch({ code: 'conflict', message: 'Agent settings changed. Reload them before saving.' }, 409)
    const error = await updateTeamAgentSettings('token', 'team-platform', {
      expectedRevision: 1,
      leaseMinutes: 30,
      allowTakeoverAfterLeaseExpiry: false,
    }, mutationContext).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentSettingsApiError)
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'Agent settings changed. Reload them before saving.' })
  })
})

describe('Agent settings save failures', () => {
  test('maps failures to feedback', () => {
    expect(readAgentSettingsSaveFailure(new AgentSettingsApiError(409, 'changed', 'conflict'))).toEqual({ kind: 'conflict' })
    expect(readAgentSettingsSaveFailure(new AgentSettingsApiError(403, 'denied'))).toEqual({ kind: 'forbidden' })
    expect(readAgentSettingsSaveFailure(new AgentSettingsApiError(400, 'leaseMinutes must be an integer.')))
      .toEqual({ kind: 'invalid', message: 'leaseMinutes must be an integer.' })
    expect(readAgentSettingsSaveFailure(new AgentSettingsApiError(503, 'unavailable'))).toEqual({ kind: 'error' })
    expect(readAgentSettingsSaveFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'error' })
  })

  test('reuses the Idempotency-Key only when the save may have reached the server', () => {
    expect(shouldRetainAgentSettingsSaveContext(new TypeError('Failed to fetch'))).toBeTrue()
    expect(shouldRetainAgentSettingsSaveContext(new AgentSettingsApiError(502, 'bad gateway'))).toBeTrue()
    expect(shouldRetainAgentSettingsSaveContext(new AgentSettingsApiError(409, 'changed'))).toBeFalse()
    expect(shouldRetainAgentSettingsSaveContext(new AgentSettingsApiError(400, 'invalid'))).toBeFalse()
  })
})
