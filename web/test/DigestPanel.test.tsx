import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { DigestPanel } from '../src/features/update-feed/ui/DigestPanel'
import { createTranslator } from '../src/shared/i18n/i18n'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'

test('permission denial suppresses even supplied cached bodies and settings', () => {
  const html = renderToStaticMarkup(<MemoryRouter><DigestPanel state={{ revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [] }} preview={{ id: 'daily:2026-10-03', replay: true, entries: updateFeedFixture.entries.slice(0, 1), transport: 'preview', truncated: false }} loading={false} pending={false} canEdit={false} failure="denied" t={createTranslator('en')} onSave={async () => true} onGenerate={async () => true} onReload={() => undefined} onDismiss={() => undefined} /></MemoryRouter>)
  expect(html).toContain('No notifications are sent')
  expect(html).not.toContain('Customer onboarding')
  expect(html).not.toContain('<form')
  expect(html).toContain('role="alert"')
})

test('a changed custom collection suppresses an otherwise successful cached preview', () => {
  const html = renderToStaticMarkup(<MemoryRouter><DigestPanel state={{ revision: 1, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['private-id'] } }, history: [] }} savedFeeds={{ revision: 2, feeds: [] }} preview={{ id: 'daily:2026-10-03', replay: true, entries: updateFeedFixture.entries.slice(0, 1), transport: 'preview', truncated: false }} loading={false} pending={false} canEdit={true} t={createTranslator('en')} onSave={async () => true} onGenerate={async () => true} onReload={() => undefined} onDismiss={() => undefined} /></MemoryRouter>)
  expect(html).not.toContain('Customer onboarding')
  expect(html).not.toContain('private-id')
  expect(html).not.toContain('aria-label="Current preview"')
  expect(html).toContain('Clear custom selection')
})
