import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxDigestPanel } from '../src/features/update-feed/ui/InboxDigestPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

test('Inbox permission denial suppresses cached consent and never offers send/preview actions', () => {
  const html = renderToStaticMarkup(<InboxDigestPanel state={{ revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [] }} loading={false} pending={false} canEdit={false} failure="denied" t={createTranslator('en')} onSave={async () => true} onReload={() => undefined} />)
  expect(html).toContain('Automatic delivery is not active yet')
  expect(html).not.toContain('<form')
  expect(html).not.toContain('Generate preview')
  expect(html).toContain('role="alert"')
  expect(html).not.toContain('Delivery preference saved')
})

for (const enabled of [false, true]) test(`guest reads saved consent ${enabled} without receiving a mutation control`, () => {
  const html = renderToStaticMarkup(<InboxDigestPanel state={{ revision: 1, preferences: { enabled, frequency: 'daily', views: ['recent'] }, history: [] }} loading={false} pending={false} canEdit={false} t={createTranslator('en')} onSave={async () => true} onReload={() => undefined} />)
  expect(html).toContain(enabled ? 'Delivery preference saved.' : 'Inbox digests are off.')
  expect(html).toContain('<dd>Daily</dd>')
  expect(html).toContain('<dd>Recent</dd>')
  expect(html).not.toContain('<form')
  expect(html).not.toContain('<input')
  expect(html).not.toContain('Save Inbox settings')
})
