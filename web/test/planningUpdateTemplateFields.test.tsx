import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { PlanningUpdateTemplateFields } from '../src/workspace/ui/PlanningUpdateTemplateFields'

describe('Workspace health update template editor', () => {
  test('shows the saved required fields and template text', () => {
    const html = renderToStaticMarkup(
      <PlanningUpdateTemplateFields
        disabled={false}
        onChange={() => undefined}
        settings={{ requiredFields: ['evidence'], template: { summary: '## This week' } }}
        t={createTranslator('en')}
      />,
    )
    expect(html).toContain('Health update required fields and template')
    expect(html).toContain('data-testid="tenant-planning-update-required-evidence" type="checkbox" checked=""')
    expect(html).toContain('data-testid="tenant-planning-update-required-riskSummary" type="checkbox"/>')
    expect(html).toContain('## This week</textarea>')
    expect(html).toContain('Template for Next action')
  })
})
