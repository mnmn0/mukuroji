import { AGENT_SETTINGS_BRIEF_MAX_BYTES, AGENT_SETTINGS_SCHEMA_VERSION, type WorkspaceAgentDefaults } from '@mukuroji/contracts'
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  getWorkspaceAgentDefaults,
  readAgentSettings,
  readWorkspaceAgentDefaults,
  updateWorkspaceAgentDefaults,
} from '../src/features/agent-settings/api/agentSettings'
import { agentSettingsFixture } from '../src/features/agent-settings/fixtures'
import {
  createAgentSettingsDraft,
  createUpdateAgentSettingsRequest,
  createUpdateWorkspaceAgentDefaultsRequest,
  createWorkspaceAgentDefaultsDraft,
  isWorkspaceAgentDefaultsDraftChanged,
  validateWorkspaceAgentDefaultsDraft,
} from '../src/features/agent-settings/model/agentSettingsForm'
import { WorkspaceAgentDefaultsSection } from '../src/features/agent-settings/ui/WorkspaceAgentDefaultsSection'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch
const t = createTranslator('en')

/** Saved Workspace agent defaults used by the tests. */
const defaults: WorkspaceAgentDefaults = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  revision: 2,
  leaseMinutes: 60,
  allowTakeoverAfterLeaseExpiry: true,
  requireAcceptanceCriteria: false,
  brief: 'Run the tests before pushing.',
  updatedAt: '2026-11-25T00:00:00.000Z',
  updatedBy: 'admin-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Workspace agent defaults API', () => {
  test('reads and saves the defaults with idempotency headers', async () => {
    const requests: { url: string, init: RequestInit }[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return Response.json({ ...defaults, unexpected: true })
    }

    expect(await getWorkspaceAgentDefaults('token')).toEqual(defaults)
    expect(requests[0]?.url).toEndWith('/workspace/agent-defaults')

    const body = { expectedRevision: 2, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: false }
    await updateWorkspaceAgentDefaults('token', body, { correlationId: 'c-1', idempotencyKey: 'k-1' })
    expect(requests[1]?.init.method).toBe('PUT')
    expect(new Headers(requests[1]?.init.headers).get('Idempotency-Key')).toBe('k-1')
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(body)
  })

  test('rejects an unsupported shape', async () => {
    expect(readWorkspaceAgentDefaults({ ...defaults, leaseMinutes: 0 })).toBeUndefined()
    expect(readWorkspaceAgentDefaults({ ...defaults, brief: 3 })).toBeUndefined()
    expect(readWorkspaceAgentDefaults({ ...defaults, schemaVersion: 99 })).toBeUndefined()
    globalThis.fetch = async () => Response.json({ ...defaults, requireAcceptanceCriteria: 'yes' })
    await expect(getWorkspaceAgentDefaults('token')).rejects.toMatchObject({ status: 502 })
  })

  test('reads the inherited brief of Team settings and never sends it back', () => {
    const settings = readAgentSettings({ ...agentSettingsFixture, workspaceBrief: 'Workspace brief' })
    expect(settings?.workspaceBrief).toBe('Workspace brief')
    expect(readAgentSettings({ ...agentSettingsFixture, workspaceBrief: 1 })).toBeUndefined()
    if (!settings) throw new Error('settings should parse')
    const request = createUpdateAgentSettingsRequest(createAgentSettingsDraft(settings), settings.revision)
    expect(request).not.toHaveProperty('workspaceBrief')
  })
})

describe('Workspace agent defaults draft', () => {
  test('round-trips the defaults and omits a blank brief', () => {
    const draft = createWorkspaceAgentDefaultsDraft(defaults)
    expect(isWorkspaceAgentDefaultsDraftChanged(defaults, draft)).toBeFalse()
    expect(createUpdateWorkspaceAgentDefaultsRequest(draft, 2)).toEqual({
      expectedRevision: 2,
      leaseMinutes: 60,
      allowTakeoverAfterLeaseExpiry: true,
      requireAcceptanceCriteria: false,
      brief: 'Run the tests before pushing.',
    })
    const cleared = { ...draft, brief: '  ' }
    expect(isWorkspaceAgentDefaultsDraftChanged(defaults, cleared)).toBeTrue()
    expect(createUpdateWorkspaceAgentDefaultsRequest(cleared, 2)).not.toHaveProperty('brief')
  })

  test('blocks an invalid lease and an oversized brief', () => {
    const draft = createWorkspaceAgentDefaultsDraft(defaults)
    expect(validateWorkspaceAgentDefaultsDraft({ ...draft, leaseMinutes: '0' }).valid).toBeFalse()
    expect(createUpdateWorkspaceAgentDefaultsRequest({ ...draft, leaseMinutes: 'x' }, 2)).toBeUndefined()
    const large = validateWorkspaceAgentDefaultsDraft({ ...draft, brief: 'x'.repeat(AGENT_SETTINGS_BRIEF_MAX_BYTES + 1) })
    expect(large.briefOverLimit).toBeTrue()
    expect(large.valid).toBeFalse()
  })
})

describe('WorkspaceAgentDefaultsSection', () => {
  /**
   * Renders the section with the loaded defaults.
   *
   * @param overrides - Props that differ from the loaded, unchanged state.
   * @returns Rendered HTML.
   */
  const render = (overrides: Partial<Parameters<typeof WorkspaceAgentDefaultsSection>[0]> = {}) => renderToStaticMarkup(
    <WorkspaceAgentDefaultsSection
      defaults={defaults}
      draft={createWorkspaceAgentDefaultsDraft(defaults)}
      hasLoadError={false}
      hasRevisionConflict={false}
      isDirty={false}
      isLoading={false}
      isSaving={false}
      locale="en"
      t={t}
      onDraftChange={() => undefined}
      onReload={() => undefined}
      onRetry={() => undefined}
      onSave={() => undefined}
      {...overrides}
    />,
  )

  test('shows the defaults and the brief', () => {
    const html = render()
    expect(html).toContain('Workspace defaults')
    expect(html).toContain('Run the tests before pushing.')
    expect(html).toContain('Revision 2')
  })

  test('offers a reload on a conflict and a retry on a load failure', () => {
    expect(render({ hasRevisionConflict: true, isDirty: true })).toContain('Reload latest settings')
    const failed = render({ defaults: undefined, draft: undefined, hasLoadError: true })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Workspace defaults could not be loaded.')
  })
})
