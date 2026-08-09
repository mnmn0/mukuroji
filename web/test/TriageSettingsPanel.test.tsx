import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { triageConfigurationFixture } from '../src/triage/fixtures'
import { TriageSettingsPanel } from '../src/triage/ui/TriageSettingsPanel'

describe('TriageSettingsPanel', () => {
  test('renders the configured bulk action checkboxes in a compact policy section', () => {
    const html = renderToStaticMarkup(
      <TriageSettingsPanel
        canManage
        configuration={{
          ...triageConfigurationFixture,
          allowedBulkActions: ['assign', 'snooze'],
        }}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Bulk actions')
    expect(html).toContain('name="allowedBulkActions"')
    expect(html).toMatch(/name="allowedBulkActions" checked="" value="assign"/u)
    expect(html).toContain('value="decline"')
    expect(html).not.toMatch(/name="allowedBulkActions" checked="" value="decline"/u)
    expect(html).toMatch(/name="allowedBulkActions" checked="" value="snooze"/u)
  })

  test('disables bulk action checkboxes in the read-only settings projection', () => {
    const html = renderToStaticMarkup(
      <TriageSettingsPanel
        canManage={false}
        configuration={triageConfigurationFixture}
        t={createTranslator('ja')}
      />,
    )

    expect(html).toContain('一括操作')
    expect(html).toContain('<fieldset class="grid grid-cols-3')
    expect(html).toContain('disabled=""')
  })
})
