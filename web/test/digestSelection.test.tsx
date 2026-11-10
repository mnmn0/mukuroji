import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DigestSavedFeedSelection } from '../src/features/update-feed/ui/DigestSavedFeedSelection'
import { validDigestSelection } from '../src/features/update-feed/model/digestSelection'
import { createTranslator } from '../src/shared/i18n/i18n'
import type { UpdateFeedDigestPreferences } from '@mukuroji/contracts'

test('unavailable/deleted saved selections expose no remembered ID or private label', () => {
  const preferences: UpdateFeedDigestPreferences = { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['sensitive-id'] } }
  for (const collection of [undefined, { revision: 2, feeds: [] }]) {
    expect(validDigestSelection(preferences, collection)).toBe(false)
    expect(validDigestSelection({ ...preferences, enabled: false }, collection)).toBe(true)
    const html = renderToStaticMarkup(<DigestSavedFeedSelection preferences={preferences} collection={collection} t={createTranslator('en')} onChange={() => undefined} />)
    expect(html).not.toContain('sensitive-id')
    expect(html).toContain('Clear custom selection')
    expect(html).toContain('role="alert"')
  }
  expect(validDigestSelection({ enabled: true, frequency: 'daily', views: ['recent'] })).toBe(true)
})

test('pending saved definitions do not assert an error or permit clearing a retained selection', () => {
  const preferences: UpdateFeedDigestPreferences = { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['sensitive-id'] } }
  const html = renderToStaticMarkup(<DigestSavedFeedSelection status="loading" preferences={preferences} t={createTranslator('en')} onChange={() => undefined} />)
  expect(html).toContain('Loading saved feeds')
  expect(html).toContain('role="status"')
  expect(html).not.toContain('role="alert"')
  expect(html).not.toContain('Clear custom selection')
  expect(html).not.toContain('sensitive-id')
})
