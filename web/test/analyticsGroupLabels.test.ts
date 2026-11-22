import { describe, expect, test } from 'bun:test'
import { createSearchWorkItemTypeKey, resolveAnalyticsGroupLabel } from '@mukuroji/contracts'
import {
  createAnalyticsDisplayNames,
  createAnalyticsGroupLabelLookup,
} from '../src/analytics/model/groupLabels'
import { createTranslator } from '../src/shared/i18n/i18n'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

describe('Analytics group labels', () => {
  const lookup = createAnalyticsGroupLabelLookup(
    createAnalyticsDisplayNames(
      projectDirectoryFixtures,
      [{ filterValue: createSearchWorkItemTypeKey('core-team', 'bug'), label: 'コアチーム · バグ' }],
      [{ id: 'sato@example.com', email: 'sato@example.com' }],
    ),
    createTranslator('ja'),
  )

  test('replaces IDs with names and localizes status categories and unset groups', () => {
    expect(resolveAnalyticsGroupLabel({ dimension: 'team' }, { key: 'core-team', label: 'core-team' }, lookup))
      .toBe('コアチーム')
    expect(resolveAnalyticsGroupLabel({ dimension: 'project' }, { key: 'refero', label: 'refero' }, lookup))
      .toBe('Refero')
    expect(resolveAnalyticsGroupLabel({ dimension: 'project' }, { key: '', label: 'Unassigned' }, lookup))
      .toBe('未設定')
    expect(resolveAnalyticsGroupLabel(
      { dimension: 'custom-field', customFieldId: 'impact' },
      { key: 'unset', label: 'Unassigned' },
      lookup,
    )).toBe('未設定')
    expect(resolveAnalyticsGroupLabel({ dimension: 'status' }, { key: 'completed', label: 'completed' }, lookup))
      .toBe('完了')
    // A member without a name shows the email address.
    expect(resolveAnalyticsGroupLabel(
      { dimension: 'assignee' },
      { key: 'sato@example.com', label: 'sato@example.com' },
      lookup,
    )).toBe('sato@example.com')
  })

  test('names a Work Item Type by its Team when the type itself is unknown', () => {
    expect(resolveAnalyticsGroupLabel(
      { dimension: 'work-item-type' },
      { key: createSearchWorkItemTypeKey('core-team', 'bug'), label: 'core-team · bug' },
      lookup,
    )).toBe('コアチーム · バグ')
    expect(resolveAnalyticsGroupLabel(
      { dimension: 'work-item-type' },
      { key: createSearchWorkItemTypeKey('core-team', 'epic'), label: 'core-team · epic' },
      lookup,
    )).toBe('コアチーム · epic')
    expect(resolveAnalyticsGroupLabel(
      { dimension: 'week' },
      { key: '2026-07-06', label: '2026-07-06' },
      lookup,
    )).toBe('2026-07-06')
  })
})
