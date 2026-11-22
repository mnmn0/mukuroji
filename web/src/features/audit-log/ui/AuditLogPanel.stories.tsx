import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { auditEventsFixture, auditExportsFixture } from '../fixtures'
import { emptyAuditLogFilterDraft } from '../model/auditLogFilters'
import { AuditLogPanel } from './AuditLogPanel'

/** Storybook metadata for the Workspace audit log panel. */
const meta = {
  title: 'Application/Settings/Workspace/Audit Log',
  component: AuditLogPanel,
  parameters: { layout: 'padded' },
  args: {
    locale: 'ja',
    timeZone: 'Asia/Tokyo',
    t: createTranslator('ja'),
    draft: { ...emptyAuditLogFilterDraft, actorId: 'sub-sato', fromDate: '2026-11-10', toDate: '2026-11-16' },
    hasSearched: true,
    events: auditEventsFixture,
    isLoading: false,
    hasMore: true,
    isLoadingMore: false,
    canExport: true,
    exports: auditExportsFixture,
    exportsFailed: false,
    isRequestingExport: false,
    exportLinks: {
      exp_completed: {
        issuedAt: Date.parse('2026-11-17T02:05:00.000Z'),
        download: {
          export: auditExportsFixture[0]!,
          parts: [{ index: 1, eventCount: 128, byteLength: 48_210, sha256: 'ab'.repeat(32), url: 'https://example.com/part-1.ndjson' }],
        },
      },
    },
    onChangeDraft: fn(),
    onSearch: fn(),
    onReset: fn(),
    onLoadMore: fn(),
    onRetry: fn(),
    onFilterByActor: fn(),
    onFilterByTarget: fn(),
    onRequestExport: fn(),
    onRetryExports: fn(),
    onIssueExportLinks: fn(),
  },
} satisfies Meta<typeof AuditLogPanel>

export default meta

/** Story type for the audit log panel. */
type Story = StoryObj<typeof meta>

/** An owner's search for one member's actions last week, with exports. */
export const Results: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('メンバーのロールの変更')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'この条件で export を依頼' })).toBeVisible()
  },
}

/** The panel before the first search, which reads nothing. */
export const BeforeSearch: Story = {
  args: { hasSearched: false, events: [], hasMore: false, draft: emptyAuditLogFilterDraft },
}

/** An auditor who may read but not export. */
export const ReadOnlyAuditor: Story = {
  args: { canExport: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByTestId('audit-export-section')).toBeNull()
  },
}

/** A search the server refused. */
export const Forbidden: Story = {
  args: { events: [], loadFailure: 'forbidden', canExport: false },
}

/** The English panel. */
export const English: Story = {
  args: { locale: 'en', t: createTranslator('en') },
}
