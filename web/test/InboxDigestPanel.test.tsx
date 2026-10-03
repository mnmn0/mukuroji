import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxDigestPanel } from '../src/features/update-feed/ui/InboxDigestPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

test('Inbox permission denial suppresses cached consent and never offers send/preview actions', () => {
  const html = renderToStaticMarkup(<InboxDigestPanel state={{ revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [] }} loading={false} pending={false} canEdit={false} failure="denied" t={createTranslator('en')} onSave={async () => true} onReload={() => undefined} />)
  expect(html).toContain('Automatic delivery also requires operator activation')
  expect(html).not.toContain('<form')
  expect(html).not.toContain('Generate preview')
  expect(html).toContain('role="alert"')
})
