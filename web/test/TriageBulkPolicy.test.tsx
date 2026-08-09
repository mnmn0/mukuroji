import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageEntryFixtures } from '../src/triage/fixtures'
import { createTriageEntryView } from '../src/triage/model/triageView'
import { TriageBulkToolbar } from '../src/triage/ui/TriageBulkToolbar'

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
})
