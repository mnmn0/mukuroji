import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { readMemberDisplayName } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  getMemberProfile,
  isMemberProfile,
  updateMemberProfile,
} from '../src/workspace/api/memberProfile'
import { updateWorkspaceMemberName } from '../src/workspace/api/members'
import { WorkspaceAccessApiError } from '../src/workspace/api/errors'
import { MemberProfileSection } from '../src/workspace/ui/MemberProfileSection'
import { SettingsSectionNav } from '../src/workspace/ui/SettingsSectionNav'

const originalFetch = globalThis.fetch
const mutationContext = { idempotencyKey: 'key-1', correlationId: 'key-1' }

/** One request captured by the fetch stub. */
type CapturedRequest = { url: string; init?: RequestInit }

/**
 * Replaces `fetch` with a stub that answers every request with one JSON response.
 *
 * @param status - HTTP status to answer with.
 * @param body - JSON body to answer with.
 * @returns The requests the stub received.
 */
function stubFetch(status: number, body: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
        status,
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

const profile = {
  memberKey: 'sato@example.com',
  email: 'sato@example.com',
  name: '佐藤',
  nameEditable: true,
  version: 3,
}

describe('member display name rules', () => {
  test('trims names, removes blank ones, and rejects long or multi-line ones', () => {
    expect(readMemberDisplayName('  佐藤 ')).toEqual({ ok: true, name: '佐藤' })
    expect(readMemberDisplayName(' ')).toEqual({ ok: true, name: undefined })
    expect(readMemberDisplayName(null)).toEqual({ ok: true, name: undefined })
    expect(readMemberDisplayName('a'.repeat(129))).toEqual({ ok: false })
    expect(readMemberDisplayName('a\nb')).toEqual({ ok: false })
    expect(readMemberDisplayName(1)).toEqual({ ok: false })
  })
})

describe('member profile API', () => {
  test('validates the profile shape', () => {
    expect(isMemberProfile(profile)).toBe(true)
    expect(isMemberProfile({ ...profile, nameEditable: 'yes' })).toBe(false)
    expect(isMemberProfile({ ...profile, version: -1 })).toBe(false)
  })

  test('reads and saves the own profile with the bearer token and idempotency key', async () => {
    const requests = stubFetch(200, { profile })
    expect(await getMemberProfile('token-1')).toEqual(profile)
    expect(await updateMemberProfile('token-1', { name: '佐藤', expectedVersion: 3 }, mutationContext))
      .toEqual(profile)
    expect(requests[0]?.url).toEndWith('/me/profile')
    expect(requests[1]?.init?.method).toBe('PUT')
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ name: '佐藤', expectedVersion: 3 }))
    expect(new Headers(requests[1]?.init?.headers).get('Authorization')).toBe('Bearer token-1')
  })

  test('raises the API error code of a refused change', async () => {
    stubFetch(409, { code: 'WorkspaceVersionConflict' })
    const failure = await updateMemberProfile('token-1', { name: 'x', expectedVersion: 1 }, mutationContext)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkspaceAccessApiError)
    expect(failure).toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
  })

  test('sends an administrator name correction to the member name endpoint', async () => {
    const requests = stubFetch(200, { member: { memberKey: 'sato@example.com' } })
    await updateWorkspaceMemberName('token-1', 'sato@example.com', { name: null, expectedVersion: 2 }, mutationContext)
    expect(requests[0]?.url).toEndWith('/workspace/members/sato%40example.com/name')
    expect(requests[0]?.init?.method).toBe('PUT')
  })
})

describe('profile section', () => {
  const t = createTranslator('ja')

  test('shows the editable name and email', () => {
    const html = renderToStaticMarkup(
      <MemberProfileSection profile={profile} t={t} userLabel="fallback" onSave={async () => {}} />,
    )
    expect(html).toContain('value="佐藤"')
    expect(html).toContain('sato@example.com')
    expect(html).toContain('data-testid="settings-profile-save"')
  })

  test('locks a directory-managed name', () => {
    const html = renderToStaticMarkup(
      <MemberProfileSection
        profile={{ ...profile, nameEditable: false }}
        t={t}
        userLabel="fallback"
        onSave={async () => {}}
      />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain(t('workspace.settings.profile.directoryManaged'))
    expect(html).not.toContain('data-testid="settings-profile-save"')
  })
})

describe('settings panel links', () => {
  test('links each panel on the page by its fragment', () => {
    const t = createTranslator('en')
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SettingsSectionNav
          current="workspace"
          panels={[
            { panel: 'members', section: 'workspace' },
            { panel: 'audit-log', section: 'workspace' },
          ]}
          t={t}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/settings/workspace#settings-members"')
    expect(html).toContain('href="/settings/workspace#settings-audit-log"')
  })
})

describe('quiet hours time zone', () => {
  test('uses the member time zone only before notification settings are saved', async () => {
    const { resolveQuietHoursTimeZone } = await import('../src/notifications/model/quietHoursTimeZone')
    expect(resolveQuietHoursTimeZone('UTC', true, 'Asia/Tokyo', true)).toBe('Asia/Tokyo')
    expect(resolveQuietHoursTimeZone('Europe/Paris', true, 'Asia/Tokyo', true)).toBe('Europe/Paris')
    expect(resolveQuietHoursTimeZone('UTC', false, 'Asia/Tokyo', true)).toBe('UTC')
    expect(resolveQuietHoursTimeZone('UTC', true, undefined, true)).toBe('UTC')
    // A saved UTC may be the member's choice, so it stays.
    expect(resolveQuietHoursTimeZone('UTC', true, 'Asia/Tokyo', false)).toBe('UTC')
  })
})
