import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageEntryFixtures } from '../src/triage/fixtures'
import { createTriageEntryView } from '../src/triage/model/triageView'
import { TriageEntryDetail } from '../src/triage/ui/TriageEntryDetail'

describe('TriageEntryDetail', () => {
  test('renders source trace and safe action forms for full visibility', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        locale="en"
        t={createTranslator('en')}
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).toContain('Workspace provisioning blocks customer launch')
    expect(html).toContain('Open original source')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('Accept')
    expect(html).toContain('Change routing')
    expect(html).toContain('Request information')
  })

  test('does not render source body, email, routing, or reply action for metadata-only access', () => {
    const entry = triageEntryFixtures[1]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        locale="en"
        t={createTranslator('en')}
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).not.toContain('This body must not be rendered')
    expect(html).not.toContain('Billing mailbox default route')
    expect(html).not.toContain('Request information')
    expect(html).toContain('Metadata only')
  })

  test('does not leak denied source title or body into the detail DOM', () => {
    const entry = triageEntryFixtures[3]
    if (!entry) throw new Error('Expected a triage fixture.')
    const html = renderToStaticMarkup(
      <TriageEntryDetail
        locale="en"
        t={createTranslator('en')}
        view={createTriageEntryView(entry)}
        onBack={() => undefined}
      />,
    )

    expect(html).not.toContain('This denied title must never render')
    expect(html).not.toContain('This denied body must never render')
    expect(html).toContain('Source unavailable')
    expect(html).toContain('No actions are available')
  })
})
