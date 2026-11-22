import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { readAuditEventPage } from '../src/features/audit-log/api/auditEvents'
import { getAuditExportDownload, readAuditExport } from '../src/features/audit-log/api/auditExports'
import { AuditLogApiError } from '../src/features/audit-log/api/auditLogRequest'
import { auditEventsFixture, auditExportsFixture } from '../src/features/audit-log/fixtures'
import { formatAuditEventType } from '../src/features/audit-log/model/auditEventTypes'
import {
  buildAuditLogFilters,
  changeAuditLogTargetType,
  emptyAuditLogFilterDraft,
  zonedDayBoundary,
} from '../src/features/audit-log/model/auditLogFilters'
import { AuditLogPanel, type AuditLogPanelProps } from '../src/features/audit-log/ui/AuditLogPanel'

const originalFetch = globalThis.fetch


afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Builds panel props with every callback stubbed.
 *
 * @param overrides - Props to replace.
 * @returns Complete panel props.
 */
function panelProps(overrides: Partial<AuditLogPanelProps> = {}): AuditLogPanelProps {
  /** Callback that ignores its call, for props a test does not exercise. */
  const noop = () => undefined
  return {
    locale: 'ja',
    timeZone: 'Asia/Tokyo',
    t: createTranslator('ja'),
    draft: emptyAuditLogFilterDraft,
    hasSearched: true,
    events: auditEventsFixture,
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    canSearch: true,
    canExport: true,
    exports: auditExportsFixture,
    exportsFailed: false,
    isRequestingExport: false,
    exportLinks: {},
    onChangeDraft: noop,
    onSearch: noop,
    onReset: noop,
    onLoadMore: noop,
    onRetry: noop,
    onFilterByActor: noop,
    onFilterByTarget: noop,
    onRequestExport: noop,
    onRetryExports: noop,
    onIssueExportLinks: noop,
    ...overrides,
  }
}

describe('audit log filters', () => {
  test('reads the period as whole days in the member time zone', () => {
    const result = buildAuditLogFilters({
      ...emptyAuditLogFilterDraft,
      actorId: ' sub-sato ',
      eventTypes: 'work-item.updated, member.role-changed, work-item.updated',
      fromDate: '2026-11-09',
      toDate: '2026-11-15',
    }, 'Asia/Tokyo')

    expect(result).toEqual({
      ok: true,
      filters: {
        actorId: 'sub-sato',
        eventTypes: ['work-item.updated', 'member.role-changed'],
        from: '2026-11-08T15:00:00.000Z',
        to: '2026-11-15T14:59:59.999Z',
      },
    })
  })

  test('keeps the day boundaries right across a daylight-saving change', () => {
    expect(zonedDayBoundary('2026-03-08', 'America/New_York', 'start')).toBe('2026-03-08T05:00:00.000Z')
    expect(zonedDayBoundary('2026-03-08', 'America/New_York', 'end')).toBe('2026-03-09T03:59:59.999Z')
    expect(zonedDayBoundary('2026-02-30', 'Asia/Tokyo', 'start')).toBeNull()
  })

  test('starts a day whose midnight is skipped at its first real instant', () => {
    expect(zonedDayBoundary('2026-09-06', 'America/Santiago', 'start')).toBe('2026-09-06T04:00:00.000Z')
    // Samoa skipped 2011-12-30 entirely, so neither boundary of that day exists.
    expect(zonedDayBoundary('2011-12-30', 'Pacific/Apia', 'start')).toBeNull()
    expect(zonedDayBoundary('2011-12-30', 'Pacific/Apia', 'end')).toBeNull()
    expect(zonedDayBoundary('2011-12-31', 'Pacific/Apia', 'start')).toBe('2011-12-30T10:00:00.000Z')
    expect(zonedDayBoundary('2026-09-05', 'America/Santiago', 'end')).toBe('2026-09-06T03:59:59.999Z')
  })

  test('rejects a target ID without its type, too many event types, and a reversed period', () => {
    expect(buildAuditLogFilters({ ...emptyAuditLogFilterDraft, targetId: 'x' })).toEqual({ ok: false, problem: 'targetIdWithoutType' })
    const eventTypes = Array.from({ length: 21 }, (_, index) => `type.${index}`).join(',')
    expect(buildAuditLogFilters({ ...emptyAuditLogFilterDraft, eventTypes })).toEqual({ ok: false, problem: 'tooManyEventTypes' })
    expect(buildAuditLogFilters({ ...emptyAuditLogFilterDraft, fromDate: '2026-11-16', toDate: '2026-11-10' }, 'UTC'))
      .toEqual({ ok: false, problem: 'invalidPeriod' })
  })

  test('clears the target ID when the target type changes', () => {
    const draft = { ...emptyAuditLogFilterDraft, targetType: 'member', targetId: 'm-1', actorId: 'sub-sato' }

    expect(changeAuditLogTargetType(draft, '')).toEqual({ ...emptyAuditLogFilterDraft, actorId: 'sub-sato' })
    expect(changeAuditLogTargetType(draft, 'member')).toBe(draft)
  })

  test('drops a target ID only when it is empty and searches everything without filters', () => {
    expect(buildAuditLogFilters({ ...emptyAuditLogFilterDraft, targetType: 'member' })).toEqual({
      ok: true,
      filters: { targetType: 'member' },
    })
    expect(buildAuditLogFilters(emptyAuditLogFilterDraft)).toEqual({ ok: true, filters: {} })
  })
})

describe('audit event type labels', () => {
  test('names known event types in Japanese and English and keeps unknown ones readable', () => {
    const ja = createTranslator('ja')
    const en = createTranslator('en')
    expect(formatAuditEventType('work-item.updated', ja)).toBe('Work Item の更新')
    expect(formatAuditEventType('member.role-changed', ja)).toBe('メンバーのロールの変更')
    expect(formatAuditEventType('member.role-changed', en)).toBe('Member role changed')
    expect(formatAuditEventType('tenant.profile.updated', en)).toBe('Workspace profile updated')
    expect(formatAuditEventType('comment.teleported', ja)).toBe('コメント: teleported')
    expect(formatAuditEventType('unknown.created', en)).toBe('unknown.created')
    expect(formatAuditEventType('created', en)).toBe('created')
  })
})

describe('audit API responses', () => {
  test('accepts the server view and rejects a malformed event', () => {
    const page = readAuditEventPage({ events: auditEventsFixture, nextCursor: 'next' })
    expect(page.events).toEqual(auditEventsFixture)
    expect(page.nextCursor).toBe('next')
    expect(() => readAuditEventPage({ events: [{ eventId: 'x' }] })).toThrow(AuditLogApiError)
  })

  test('reads the source as the kind string the server returns', () => {
    const serverEvent = {
      eventId: 'evt_1',
      eventType: 'work-item.updated',
      occurredAt: '2026-11-20T01:00:00.000Z',
      actor: { id: 'sub-1', kind: 'user', displayName: 'Aoi' },
      entity: { type: 'work-item', id: 'wi_1' },
      target: { type: 'work-item', id: 'wi_1' },
      changes: [{ field: 'title', before: 'Old', after: 'New' }],
      action: 'updated',
      correlationId: 'corr_1',
      source: 'api',
    }
    expect(readAuditEventPage({ events: [serverEvent] }).events[0]?.source).toBe('api')
    expect(() => readAuditEventPage({ events: [{ ...serverEvent, source: { kind: 'api' } }] })).toThrow(AuditLogApiError)
  })

  test('validates exports and refuses download links that are not web URLs', async () => {
    expect(readAuditExport(auditExportsFixture[2])).toEqual(auditExportsFixture[2]!)
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
      export: auditExportsFixture[0],
      parts: [{ index: 1, eventCount: 1, byteLength: 10, sha256: 'a', url: 'javascript:alert(1)' }],
    })), { preconnect: originalFetch.preconnect })

    await expect(getAuditExportDownload('token', 'exp_completed')).rejects.toBeInstanceOf(AuditLogApiError)
  })
})

describe('AuditLogPanel', () => {
  test('shows event labels, before and after values, and hides redacted values', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps()} />)

    expect(html).toContain('メンバーのロールの変更')
    expect(html).toContain('member.role-changed')
    expect(html).toContain('佐藤 花子')
    expect(html).toContain('admin')
    expect(html).toContain('（機密のため非表示）')
    expect(html).not.toContain('>old<')
    expect(html).toContain('2026-12-15')
    expect(html).toContain('顧客との調整で納期を延長')
    expect(html).toContain('2026/11/17 10:15:30')
  })

  test('reads nothing before the first search and explains why', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({ hasSearched: false, events: [] })} />)

    expect(html).toContain('条件を指定して「検索」を押すと')
    expect(html).not.toContain('data-testid="audit-event-row"')
  })

  test('shows a permission message instead of data when the server refuses', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({ events: [], loadFailure: 'forbidden', canExport: false })} />)

    expect(html).toContain('監査ログを見る権限がありません。')
    expect(html).not.toContain('再読み込み')
    expect(html).not.toContain('data-testid="audit-export-section"')
  })

  test('disables every export action while one of them is running', () => {
    const issuing = renderToStaticMarkup(<AuditLogPanel {...panelProps({ issuingExportId: 'exp_completed' })} />)
    expect(issuing).toMatch(/<button[^>]*disabled=""[^>]*>この条件で export を依頼<\/button>/u)

    const requesting = renderToStaticMarkup(<AuditLogPanel {...panelProps({ isRequestingExport: true })} />)
    expect(requesting).toMatch(/<button[^>]*disabled=""[^>]*>ダウンロードリンクを発行<\/button>/u)
  })

  test('offers download links only for completed exports and lists issued links', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({
      exportLinks: {
        exp_completed: {
          issuedAt: 0,
          download: {
            export: auditExportsFixture[0]!,
            parts: [{ index: 1, eventCount: 128, byteLength: 2048, sha256: 'a', url: 'https://example.com/part-1' }],
            nextPart: 100,
          },
        },
      },
    })} />)

    expect(html.match(/ダウンロードリンクを発行/g)).toHaveLength(1)
    expect(html).toContain('href="https://example.com/part-1"')
    expect(html).toContain('128 件・2.0 KB')
    expect(html).toContain('続きのファイルのリンクを発行')
    expect(html).toContain('The export could not be verified as complete.')
    expect(html).toContain('条件なし（すべての記録）')
  })

  test('keeps paging when a filtered page holds no match but older pages remain', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({ events: [], hasMore: true })} />)

    expect(html).toContain('読み込んだ範囲には条件に合う操作がありません')
    expect(html).toContain('さらに読み込む')
    expect(html).not.toContain('条件に合う操作はありません。')
  })

  test('offers only the export to a member who may export but not search', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({ canSearch: false, hasSearched: false, events: [] })} />)

    expect(html).not.toContain('>検索<')
    expect(html).toContain('検索する権限はありません')
    expect(html).toContain('data-testid="audit-export-section"')
  })

  test('describes every filter an export was requested with', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({
      exports: [{ ...auditExportsFixture[1]!, filters: { actorKind: 'service', entityType: 'work-item', entityId: 'team/core/issue/MUK-1' } }],
    })} />)

    expect(html).toContain('実行者の種別: service')
    expect(html).toContain('まとめ先: work-item / team/core/issue/MUK-1')
    expect(html).not.toContain('条件なし（すべての記録）')
  })

  test('renders the English panel', () => {
    const html = renderToStaticMarkup(<AuditLogPanel {...panelProps({ locale: 'en', t: createTranslator('en') })} />)

    expect(html).toContain('Member role changed')
    expect(html).toContain('Export with these filters')
  })
})
