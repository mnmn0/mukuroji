import { expect, test } from 'bun:test'
import {
  DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS,
  findRemovedInvestmentCategoryKeys,
  readInvestmentGroup,
  readTeamInvestmentAssignments,
  readWorkspaceInvestmentCategorySettings,
  resolveInvestmentCategory,
} from '../src/investment-categories'

test('defaults group development as Capex and operations and management as Opex', () => {
  expect(readWorkspaceInvestmentCategorySettings(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS)).toEqual(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS)
  expect(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS.categories.map(({ key, group }) => `${key}:${group}`)).toEqual([
    'new-development:capex',
    'enhancement:capex',
    'maintenance:capex',
    'operations:opex',
    'management:opex',
  ])
  expect(readInvestmentGroup(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS, 'operations')).toBe('opex')
})

test('refuses invalid settings', () => {
  const valid = DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS
  for (const invalid of [
    { ...valid, personMonthHours: 0 },
    { ...valid, personMonthHours: 160.5 },
    { ...valid, categories: [] },
    { ...valid, categories: valid.categories.map((category) => ({ ...category, active: false })) },
    { ...valid, categories: [...valid.categories, { key: 'custom-x', group: 'capex', active: true }] },
    { ...valid, categories: [...valid.categories, { key: 'unclassified', label: 'x', group: 'capex', active: true }] },
    { ...valid, categories: [...valid.categories, { key: 'custom-x', label: 'x', group: 'other', active: true }] },
    { ...valid, categories: [...valid.categories, valid.categories[0]] },
  ]) {
    expect(readWorkspaceInvestmentCategorySettings(invalid)).toBeUndefined()
  }
  expect(findRemovedInvestmentCategoryKeys(valid, { ...valid, categories: valid.categories.slice(1) })).toEqual(['new-development'])
})

test('resolves a Work Item category before its Project default', () => {
  const assignments = readTeamInvestmentAssignments({ projects: { alpha: 'new-development' }, workItems: { 'task-1': 'maintenance' } })
  expect(assignments).toBeDefined()
  if (!assignments) return
  expect(resolveInvestmentCategory(assignments, { workItemId: 'task-1', projectId: 'alpha' })).toBe('maintenance')
  expect(resolveInvestmentCategory(assignments, { workItemId: 'task-2', projectId: 'alpha' })).toBe('new-development')
  expect(resolveInvestmentCategory(assignments, { projectId: 'beta' })).toBe('unclassified')
  expect(resolveInvestmentCategory(assignments, { projectId: 'toString' })).toBe('unclassified')
  expect(readTeamInvestmentAssignments({ projects: { 'a b': 'maintenance' }, workItems: {} })).toBeUndefined()
  expect(readTeamInvestmentAssignments(JSON.parse('{"projects":{"__proto__":"maintenance"}}'))).toBeUndefined()
})
