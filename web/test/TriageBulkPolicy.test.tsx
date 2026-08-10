import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageEntryFixtures } from '../src/triage/fixtures'
import { createTriageEntryView } from '../src/triage/model/triageView'
import { createTriageBulkInput } from '../src/triage/model/triageBulk'
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

  test('omits the optional Project when bulk owner assignment leaves it blank', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const formData = new FormData()
    formData.set('ownerUserId', 'owner@example.com')

    const input = createTriageBulkInput(
      [createTriageEntryView(entry)],
      'assign',
      formData,
    )

    expect(input?.operation).toEqual({
      action: 'assign',
      ownerUserId: 'owner@example.com',
    })
  })
})
