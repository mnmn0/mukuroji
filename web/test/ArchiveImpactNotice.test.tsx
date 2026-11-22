import { describe, expect, test } from 'bun:test'
import type { DirectoryArchiveImpactResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { createArchiveImpactLabels, createTranslator, type Locale } from '../src/shared/i18n/i18n'
import {
  ArchiveImpactNotice,
  isArchiveImpactConfirmDisabled,
} from '../src/shared/ui/archive-impact'

/** Impact with nothing affected, overridden per test. */
const emptyImpact: DirectoryArchiveImpactResponse = {
  openWorkItems: { count: 0, hasMore: false },
  activeAgentRuns: { count: 0, hasMore: false },
  planningEntities: 0,
  planningWorkItemLinks: 0,
  planningDependencies: 0,
  webhookSubscriptions: 0,
  archiveBlocked: false,
}

describe('ArchiveImpactNotice', () => {
  test('lists warnings, marks a count that stopped early, and keeps the archive allowed', () => {
    const locales: Locale[] = ['ja', 'en']

    for (const locale of locales) {
      const t = createTranslator(locale)
      const labels = createArchiveImpactLabels(t)
      const impact: DirectoryArchiveImpactResponse = {
        ...emptyImpact,
        openWorkItems: { count: 2000, hasMore: true },
        activeAgentRuns: { count: 1, hasMore: false },
        webhookSubscriptions: 2,
      }
      const markup = renderToStaticMarkup(
        <ArchiveImpactNotice labels={labels} state={{ status: 'ready', impact }} />,
      )

      expect(markup).toContain(labels.openWorkItems(labels.count({ count: 2000, hasMore: true })))
      expect(markup).toContain(labels.activeAgentRuns(labels.count({ count: 1, hasMore: false })))
      expect(markup).toContain(labels.webhookSubscriptions(labels.count({ count: 2, hasMore: false })))
      expect(markup).toContain(labels.warning)
      expect(markup).not.toContain(labels.blocked)
      expect(isArchiveImpactConfirmDisabled({ status: 'ready', impact })).toBe(false)
    }
  })

  test('explains a Planning block and disables the archive until the counts load', () => {
    const t = createTranslator('ja')
    const labels = createArchiveImpactLabels(t)
    const impact: DirectoryArchiveImpactResponse = { ...emptyImpact, planningEntities: 1, archiveBlocked: true }

    const markup = renderToStaticMarkup(
      <ArchiveImpactNotice labels={labels} state={{ status: 'ready', impact }} />,
    )

    expect(markup).toContain(labels.blocked)
    expect(markup).toContain(labels.planningEntities(labels.count({ count: 1, hasMore: false })))
    expect(isArchiveImpactConfirmDisabled({ status: 'ready', impact })).toBe(true)
    expect(isArchiveImpactConfirmDisabled({ status: 'loading' })).toBe(true)
    // A failed read leaves the decision to the server's own checks.
    expect(isArchiveImpactConfirmDisabled({ status: 'error' })).toBe(false)
    expect(isArchiveImpactConfirmDisabled(undefined)).toBe(false)
  })

  test('says nothing is affected when every count is zero', () => {
    const labels = createArchiveImpactLabels(createTranslator('en'))

    const markup = renderToStaticMarkup(
      <ArchiveImpactNotice labels={labels} state={{ status: 'ready', impact: emptyImpact }} />,
    )

    expect(markup).toContain(labels.none)
  })
})
