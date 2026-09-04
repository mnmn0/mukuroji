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
    const loadMoreButton = html.match(/<button[^>]*>Load more<\/button>/)?.[0]
    expect(loadMoreButton).toBeDefined()
    expect(loadMoreButton).not.toContain('disabled=""')
  })

  test('fences selected bulk mutations while an AI operation is pending', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageBulkToolbar
        allowedActions={['assign', 'snooze', 'decline']}
        entries={[createTriageEntryView(entry)]}
        isAiOperationPending
        onApply={async () => []}
        onClear={() => undefined}
        t={createTranslator('en')}
      />,
    )

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Change owner<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Snooze<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Decline<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Clear selection<\/button>/)
  })

  test('preserves activity order when Work Item Type runs are interleaved', () => {
    const sourceEntry = triageEntryFixtures[2]
    if (!sourceEntry?.canonicalWorkItem) throw new Error('Expected a canonical triage fixture.')
    const createView = (id: string, workItemTypeId: string) => createTriageEntryView({
      ...sourceEntry,
      canonicalWorkItem: {
        ...sourceEntry.canonicalWorkItem,
        workItemId: id,
        workItemTypeId,
      },
      id,
    })
    const html = renderToStaticMarkup(
      <TriageQueue
        allowedBulkActions={[]}
        counts={{ breached: 0, pending: 0, unowned: 0 }}
        entries={[
          createView('triage-a', 'type-a'),
          createView('triage-b', 'type-b'),
          createView('triage-c', 'type-a'),
        ]}
        filters={{ owner: 'all' }}
        locale="en"
        onEntrySelectionChange={() => undefined}
        onFiltersChange={() => undefined}
        onSelectEntry={() => undefined}
        onVisibleSelectionChange={() => undefined}
        selectedEntryIds={[]}
        t={createTranslator('en')}
      />,
    )

    expect(html.indexOf('data-testid="triage-entry-triage-a"')).toBeLessThan(
      html.indexOf('data-testid="triage-entry-triage-b"'),
    )
    expect(html.indexOf('data-testid="triage-entry-triage-b"')).toBeLessThan(
      html.indexOf('data-testid="triage-entry-triage-c"'),
    )
  })
})
