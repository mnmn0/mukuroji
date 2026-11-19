import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import {
  getMemberPreferences,
  isMemberPreferences,
  replaceMemberPreferences,
} from '../src/workspace/api/memberPreferences'
import { WorkspaceAccessApiError } from '../src/workspace/api/errors'
import { createTranslator } from '../src/shared/i18n/i18n'
import { WorkspaceSettingsView } from '../src/workspace/ui/WorkspaceSettingsView'

const originalFetch = globalThis.fetch

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

describe('member preference API', () => {
  test('accepts saved values and rejects unsupported ones', () => {
    expect(isMemberPreferences({ revision: 0 })).toBe(true)
    expect(isMemberPreferences({
      fontSize: 'compact',
      locale: 'en',
      revision: 2,
      theme: 'system',
      timeZone: 'Asia/Tokyo',
    })).toBe(true)
    expect(isMemberPreferences({ locale: 'fr', revision: 1 })).toBe(false)
    expect(isMemberPreferences({ revision: -1 })).toBe(false)
    expect(isMemberPreferences(null)).toBe(false)
  })

  test('reads the signed-in member\'s preferences with the bearer token', async () => {
    const requests = stubFetch(200, { locale: 'en', revision: 3 })

    await expect(getMemberPreferences('token-1')).resolves.toEqual({ locale: 'en', revision: 3 })
    expect(requests[0]?.url).toBe('/api/me/preferences')
    expect(requests[0]?.init?.headers).toEqual({ Authorization: 'Bearer token-1' })
  })

  test('replaces the preferences with a PUT carrying the read revision', async () => {
    const requests = stubFetch(200, { revision: 4, theme: 'dark' })

    await expect(replaceMemberPreferences('token-1', { revision: 3, theme: 'dark' }))
      .resolves.toEqual({ revision: 4, theme: 'dark' })
    expect(requests[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ revision: 3, theme: 'dark' })
  })

  test('reports a conflict with its status and code', async () => {
    stubFetch(409, { code: 'MemberPreferencesConflict', message: 'changed' })

    const error = await replaceMemberPreferences('token-1', { revision: 1 }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(WorkspaceAccessApiError)
    expect(error).toMatchObject({ code: 'MemberPreferencesConflict', status: 409 })
  })
})

describe('time zone setting', () => {
  test('shows the saved time zone and a browser-default option', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WorkspaceSettingsView
          fontSizePreference="standard"
          locale="en"
          onFontSizePreferenceChange={() => undefined}
          onThemePreferenceChange={() => undefined}
          onTimeZoneChange={() => undefined}
          t={createTranslator('en')}
          themePreference="light"
          timeZone="Asia/Tokyo"
          userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('data-testid="time-zone-preference-control"')
    expect(html).toContain('Browser setting')
    expect(html).toMatch(/<option value="Asia\/Tokyo" selected="">Asia\/Tokyo<\/option>/)
  })
})
