import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  type WorkspaceTimeEntryCategorySettings,
} from '@mukuroji/contracts'
import { selectSelectableTimeEntryCategories } from '../src/features/time-tracking/model/timeEntryCategories'
import { TimeEntryCategoryContext } from '../src/features/time-tracking/ui/timeEntryCategoryContext'
import { IndirectTimeEntryForm } from '../src/features/time-tracking/ui/IndirectTimeEntryForm'
import { describeTimeEntryCategory, describeTimeEntrySubject } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTimeEntryFixture } from '../src/features/time-tracking/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  addTimeEntryCategory,
  hasTimeEntryCategoryProblem,
  moveTimeEntryCategory,
} from '../src/workspace/model/timeEntryCategories'

const ja = createTranslator('ja')

const settings: WorkspaceTimeEntryCategorySettings = {
  categories: [
    { key: 'meeting', label: '打ち合わせ', active: true },
    { key: 'custom-sales', label: '営業支援', active: true },
    { key: 'leave', active: false },
  ],
}

test('names categories by the Workspace name, the built-in name, or the key', () => {
  expect(describeTimeEntryCategory(ja, 'meeting', settings)).toBe('打ち合わせ')
  expect(describeTimeEntryCategory(ja, 'leave', settings)).toBe(describeTimeEntryCategory(ja, 'leave'))
  expect(describeTimeEntryCategory(ja, 'custom-sales', settings)).toBe('営業支援')
  // A key the Workspace no longer lists still shows something rather than nothing.
  expect(describeTimeEntryCategory(ja, 'custom-gone', settings)).toBe('custom-gone')
  expect(describeTimeEntrySubject(ja, { category: 'custom-sales' }, {}, settings)).toBe('間接作業・営業支援')
})

test('offers active categories plus the retired one an entry already has', () => {
  expect(selectSelectableTimeEntryCategories(settings)).toEqual(['meeting', 'custom-sales'])
  expect(selectSelectableTimeEntryCategories(settings, 'leave')).toEqual(['meeting', 'custom-sales', 'leave'])
  expect(selectSelectableTimeEntryCategories(settings, 'custom-gone')).toEqual(['meeting', 'custom-sales', 'custom-gone'])
})

test('renders the indirect-work form with the Workspace categories', () => {
  const html = renderToStaticMarkup(
    <TimeEntryCategoryContext value={settings}>
      <IndirectTimeEntryForm
        defaultDate="2026-11-10"
        onCancel={() => undefined}
        onSave={async () => undefined}
        t={ja}
        targets={{ projects: [], allowNoProject: true }}
      />
    </TimeEntryCategoryContext>,
  )
  expect(html).toContain('<option value="custom-sales">営業支援</option>')
  expect(html).not.toContain('value="leave"')
  expect(html).not.toContain('value="design"')

  const retired = createTimeEntryFixture({ id: 'leave', workItemId: undefined, category: 'leave', durationOnly: true })
  const editing = renderToStaticMarkup(
    <TimeEntryCategoryContext value={settings}>
      <IndirectTimeEntryForm
        defaultDate="2026-11-10"
        entry={retired}
        onCancel={() => undefined}
        onSave={async () => undefined}
        t={ja}
        targets={{ projects: [], allowNoProject: true }}
      />
    </TimeEntryCategoryContext>,
  )
  expect(editing).toContain('value="leave"')
})

test('adds, reorders, and checks edited categories', () => {
  const added = addTimeEntryCategory(DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS, ' 営業支援 ', () => 'abc123')
  expect(added.categories.at(-1)).toEqual({ key: 'custom-abc123', label: '営業支援', active: true })
  expect(addTimeEntryCategory(added, '   ')).toBe(added)
  expect(hasTimeEntryCategoryProblem(added)).toBe(false)

  const moved = moveTimeEntryCategory(added, 0, 1)
  expect(moved.categories.slice(0, 2).map((category) => category.key)).toEqual(['implementation', 'design'])
  expect(moveTimeEntryCategory(added, 0, -1)).toBe(added)

  expect(hasTimeEntryCategoryProblem({ categories: [{ key: 'custom-x', label: '', active: true }] })).toBe(true)
  expect(hasTimeEntryCategoryProblem({ categories: [{ key: 'meeting', active: false }] })).toBe(true)
})

test('reads entries recorded under a Workspace category from the API', async () => {
  const { readTimeEntry } = await import('../src/features/time-tracking/api/timeTrackingValidation')
  const entry = createTimeEntryFixture({ id: 'sales', workItemId: undefined, category: 'custom-sales', durationOnly: true })
  expect(readTimeEntry(entry)?.category).toBe('custom-sales')
  expect(readTimeEntry({ ...entry, category: 'Sales Support' })).toBeUndefined()
})
