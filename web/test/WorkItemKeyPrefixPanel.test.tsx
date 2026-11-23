import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createWorkItemKeyPrefixChoices, readWorkItemKeyPrefixInput } from '../src/work-items/model/workItemKeys'
import { WorkItemKeyPrefixPanel, type WorkItemKeyPrefixPanelProps } from '../src/work-items/ui/WorkItemKeyPrefixPanel'

const props: WorkItemKeyPrefixPanelProps = {
  teams: [{ id: 'core-team', name: 'Core' }],
  teamId: 'core-team',
  onSelectTeam: () => {},
  settings: { teamId: 'core-team', keyPrefix: 'CT', previousPrefixes: ['CORE'], lastNumber: 9, canManage: true },
  isLoading: false,
  hasLoadError: false,
  onRetry: () => {},
  projectCodeChoices: ['CT', 'REFERO'],
  isSaving: false,
  onSave: () => {},
  t: createTranslator('ja'),
}

describe('Work Item key prefix input', () => {
  test('reads typed prefixes and makes choices from Project codes', () => {
    expect(readWorkItemKeyPrefixInput(' core ')).toBe('CORE')
    expect(readWorkItemKeyPrefixInput('1AB')).toBeUndefined()
    expect(readWorkItemKeyPrefixInput('A')).toBeUndefined()
    expect(readWorkItemKeyPrefixInput('AB-C')).toBeUndefined()
    expect(createWorkItemKeyPrefixChoices(['core-api', 'CORE_API', '2025-OPS', 'X', undefined, 'VERYLONGPROJECTCODE']))
      .toEqual(['COREAPI', 'VERYLONGPR'])
  })
})

describe('Work Item key prefix panel', () => {
  test('shows the current and earlier prefixes and offers Project code choices to a manager', () => {
    const html = renderToStaticMarkup(<WorkItemKeyPrefixPanel {...props} />)

    expect(html).toContain('data-testid="work-item-key-prefix-current">CT<')
    expect(html).toContain('CORE')
    expect(html).toContain('>REFERO</button>')
    // The current prefix is not offered again.
    expect(html).not.toContain('>CT</button>')
    expect(html).toContain('data-testid="work-item-key-prefix-input"')
  })

  test('shows the prefix read-only to a member and the first key of a Team without one', () => {
    const html = renderToStaticMarkup(<WorkItemKeyPrefixPanel
      {...props}
      settings={{ teamId: 'core-team', suggestedKeyPrefix: 'CT', previousPrefixes: [], lastNumber: 0, canManage: false }}
    />)

    expect(html).toContain('CT-1')
    expect(html).toContain('Team の管理者だけが変更できます')
    expect(html).not.toContain('data-testid="work-item-key-prefix-input"')
  })

  test('explains a prefix that another Team holds', () => {
    expect(renderToStaticMarkup(<WorkItemKeyPrefixPanel {...props} saveResult="taken" />))
      .toContain('この prefix は別の Team が使っています')
  })
})
