import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TenantAdministrationSnapshot } from '@mukuroji/contracts'
import { getWorkspaceCalendarSettings } from '../src/workspace/api/tenantAdministration'
import { TenantAdministrationPanel } from '../src/workspace/ui/TenantAdministrationPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one fixed JSON response and records the requested URLs.
 *
 * @param body - JSON body to return.
 * @param status - HTTP status to return.
 * @returns The URLs requested through the mock.
 */
function mockFetch(body: unknown, status = 200): string[] {
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return Response.json(body, { status })
    },
    { preconnect: originalFetch.preconnect },
  )
  return urls
}

const snapshot = {
  schemaVersion: 3,
  profile: {
    workspaceId: 'workspace-1',
    ownerMemberKey: 'owner@example.com',
    region: 'ap-northeast-1',
    locale: 'ja',
    defaultPolicy: { defaultMemberRole: 'member' },
    calendar: { fiscalYearStartMonth: 4, weekStartDay: 0 },
    status: 'active',
    revision: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  recentOperations: [],
  governance: {
    workspaceId: 'workspace-1',
    auditRetentionDays: 365,
    legalHold: false,
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedBy: 'owner@example.com',
  },
  governanceEnforcement: {
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
  },
} satisfies TenantAdministrationSnapshot

describe('Workspace calendar settings', () => {
  test('reads the settings every member uses and rejects a malformed response', async () => {
    const urls = mockFetch({ fiscalYearStartMonth: 4, weekStartDay: 1 })
    expect(await getWorkspaceCalendarSettings('token-1')).toEqual({ fiscalYearStartMonth: 4, weekStartDay: 1 })
    expect(urls[0]?.endsWith('/workspace/calendar-settings')).toBe(true)

    mockFetch({ fiscalYearStartMonth: 13, weekStartDay: 1 })
    await expect(getWorkspaceCalendarSettings('token-1')).rejects.toThrow()
  })

  test('shows the stored fiscal year start month and week start day to administrators', () => {
    const noop = () => undefined
    const html = renderToStaticMarkup(
      <TenantAdministrationPanel
        actionError={undefined}
        activeOperation={undefined}
        closureConfirmation=""
        data={snapshot}
        exportFormat="jsonl"
        governance={snapshot.governance}
        isSaving={false}
        locale="ja"
        onChangeClosureConfirmation={noop}
        onChangeExportFormat={noop}
        onChangeGovernance={noop}
        onChangeProfile={noop}
        onPauseOperation={noop}
        onRequestClosure={noop}
        onRequestExport={noop}
        onResumeOperation={noop}
        onSaveGovernance={noop}
        onSaveProfile={noop}
        onVerifyClosure={noop}
        profile={snapshot.profile}
        t={createTranslator('ja')}
      />,
    )
    expect(html).toContain('会計年度の開始月')
    expect(html).toContain('<option value="4" selected="">4月</option>')
    expect(html).toContain('<option value="0" selected="">日曜日</option>')
  })
})
