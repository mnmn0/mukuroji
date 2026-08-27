import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageEntryFixtures } from '../src/triage/fixtures'
import { createTriageEntryView } from '../src/triage/model/triageView'
import { createTriageBulkInput } from '../src/triage/model/triageBulk'
import { TriageBulkToolbar } from '../src/triage/ui/TriageBulkToolbar'
import { TriageQueue } from '../src/triage/ui/TriageQueue'

describe('Triage bulk policy projection', () => {
  test('renders only operations enabled by the permission-safe queue policy', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageBulkToolbar
        allowedActions={['decline']}
        entries={[createTriageEntryView(entry)]}
        onApply={async () => []}
        onClear={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('>Decline<')
    expect(html).not.toContain('>Assign<')
    expect(html).not.toContain('>Snooze<')
  })

  test('serializes a blank Project as an explicit clear for bulk owner assignment', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const formData = new FormData()
    formData.set('ownerUserId', 'owner@example.com')
    formData.set('projectId', '')

    const input = createTriageBulkInput(
      [createTriageEntryView(entry)],
      'assign',
      formData,
    )

    expect(input?.operation).toEqual({
      action: 'assign',
      ownerUserId: 'owner@example.com',
      projectId: null,
    })
  })

  test('fences triage source controls while an AI operation is pending', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageQueue
        allowedBulkActions={['assign']}
        counts={{ breached: 0, pending: 1, unowned: 1 }}
        entries={[createTriageEntryView(entry)]}
        filters={{ owner: 'all' }}
        hasMore
        isAiOperationPending
        isLoadingMore={false}
        locale="en"
        onEntrySelectionChange={() => undefined}
        onFiltersChange={() => undefined}
        onLoadMore={() => undefined}
        onSelectEntry={() => undefined}
        onVisibleSelectionChange={() => undefined}
        selectedEntryIds={[]}
        t={createTranslator('en')}
      />,
    )

    expect(html).toMatch(/data-testid="triage-entry-[^"]+"[^>]*disabled=""/)
    expect(html).toContain('aria-label="Select visible"')
    expect(html).toMatch(/aria-label="Select visible"[^>]*disabled=""/)
    expect(html).toContain('type="search"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('>Load more</button>')
  })
})
