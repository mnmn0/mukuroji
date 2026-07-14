import { describe, expect, test } from 'bun:test'
import type { CustomFieldDefinition } from '@mukuroji/contracts'
import {
  createCustomFieldFormName,
  createDefaultCustomFieldValues,
  formatCustomFieldValue,
  isCustomFieldApplicable,
  matchesCustomFieldFilter,
  parseCustomFieldFormData,
  readCustomFieldIdFromFormName,
  validateCustomFieldValue,
} from '../src/work-items/customFields'
import { workspaceWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import {
  matchesWorkItemDefinitionFilter,
} from '../src/work-items/workItemFilters'
import {
  formatWorkItemCustomFieldValue,
  isCompletedWorkItem,
  isOpenWorkItem,
  matchesWorkItemCustomFieldFilter,
  resolveAllowedWorkflowStatuses,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusLabel,
} from '../src/work-items/workItemDisplay'

const definitions = workspaceWorkItemConfigurationFixture.customFields

describe('custom field form data', () => {
  test('round-trips encoded field names', () => {
    const name = createCustomFieldFormName('risk/impact 日本語')

    expect(name).toBe('custom-field:risk%2Fimpact%20%E6%97%A5%E6%9C%AC%E8%AA%9E')
    expect(readCustomFieldIdFromFormName(name)).toBe('risk/impact 日本語')
    expect(readCustomFieldIdFromFormName('title')).toBeUndefined()
    expect(readCustomFieldIdFromFormName('custom-field:%E0%A4%A')).toBeUndefined()
  })

  test('parses every mutable field type and excludes formula values', () => {
    const formData = new FormData()

    appendField(formData, 'customer-impact', 'Enterprise onboarding remains self-service.')
    appendField(formData, 'story-points', '13')
    appendField(formData, 'release-blocker', 'false')
    appendField(formData, 'release-blocker', 'true')
    appendField(formData, 'target-date', '2026-07-31')
    appendField(formData, 'risk-level', 'high')
    appendField(formData, 'disciplines', 'frontend')
    appendField(formData, 'disciplines', 'backend')
    appendField(formData, 'reviewer', 'member:sato@example.com')
    appendField(formData, 'budget', '1250000')
    appendField(formData, 'estimate', '16.5')
    appendField(formData, 'weighted-score', '999')

    expect(parseCustomFieldFormData(formData, definitions, { projectId: 'refero' })).toEqual({
      errors: [],
      values: {
        'customer-impact': 'Enterprise onboarding remains self-service.',
        'story-points': 13,
        'release-blocker': true,
        'target-date': '2026-07-31',
        'risk-level': 'high',
        disciplines: ['frontend', 'backend'],
        reviewer: 'member:sato@example.com',
        budget: 1_250_000,
        estimate: 16.5,
      },
    })
  })

  test('applies scoped defaults defensively and treats an unchecked boolean as false', () => {
    const defaults = createDefaultCustomFieldValues(definitions, 'refero')
    const defaultDisciplines = defaults.disciplines

    expect(defaults).toMatchObject({
      'story-points': 3,
      'release-blocker': false,
      'risk-level': 'moderate',
      disciplines: ['frontend'],
      estimate: 8,
    })
    expect(defaults).not.toHaveProperty('weighted-score')
    expect(isCustomFieldApplicable(getDefinition('budget'), 'refero')).toBe(true)
    expect(isCustomFieldApplicable(getDefinition('budget'), 'other-project')).toBe(false)

    if (Array.isArray(defaultDisciplines)) {
      defaultDisciplines.push('backend')
    }
    expect(createDefaultCustomFieldValues(definitions, 'refero').disciplines).toEqual(['frontend'])

    const parsed = parseCustomFieldFormData(new FormData(), [
      { ...getDefinition('release-blocker'), defaultValue: true },
    ], { applyDefaults: true })

    expect(parsed.values).toEqual({ 'release-blocker': false })
  })
})

describe('custom field validation and display', () => {
  test('returns stable validation codes for malformed values', () => {
    expect(validateCustomFieldValue(getDefinition('customer-impact'), undefined)).toEqual([
      { fieldId: 'customer-impact', code: 'required' },
    ])
    expect(validateCustomFieldValue(getDefinition('story-points'), 'many')).toEqual([
      { fieldId: 'story-points', code: 'invalid-type' },
    ])
    expect(validateCustomFieldValue(getDefinition('risk-level'), 'critical')).toEqual([
      { fieldId: 'risk-level', code: 'invalid-option' },
    ])
    expect(validateCustomFieldValue(getDefinition('target-date'), '2026-02-30')).toEqual([
      { fieldId: 'target-date', code: 'invalid-date' },
    ])
    expect(validationCodes('story-points', -1)).toContain('min')
    expect(validationCodes('story-points', 101)).toContain('max')
    expect(validationCodes('customer-impact', 'brief')).toEqual(['min-length'])
    expect(validationCodes('customer-impact', ' '.repeat(12))).toContain('pattern')
    expect(validationCodes('disciplines', ['frontend', 'backend', 'design', 'research']))
      .toContain('max-length')
  })

  test('formats and filters typed values using definitions', () => {
    expect(formatCustomFieldValue(getDefinition('risk-level'), 'moderate')).toBe('Moderate')
    expect(formatCustomFieldValue(getDefinition('disciplines'), ['frontend', 'design']))
      .toBe('Frontend, Design')
    expect(formatCustomFieldValue(getDefinition('reviewer'), 'member:sato@example.com', {
      personLabels: { 'member:sato@example.com': '佐藤 花子' },
    })).toBe('佐藤 花子')
    expect(formatCustomFieldValue(getDefinition('budget'), 1_200, { locale: 'ja-JP' }))
      .toContain('1,200')
    expect(formatCustomFieldValue(getDefinition('estimate'), 24)).toBe('24 hours')
    expect(formatCustomFieldValue(getDefinition('estimate'), 24, {
      durationUnitLabels: { hours: '時間' },
    })).toBe('24 時間')
    expect(formatCustomFieldValue(getDefinition('release-blocker'), false, {
      falseLabel: 'いいえ',
    })).toBe('いいえ')

    expect(matchesCustomFieldFilter(getDefinition('customer-impact'), 'Launch risk reduced', 'RISK'))
      .toBe(true)
    expect(matchesCustomFieldFilter(getDefinition('disciplines'), ['frontend', 'design'], ['design']))
      .toBe(true)
    expect(matchesCustomFieldFilter(getDefinition('risk-level'), 'moderate', 'high')).toBe(false)
  })
})

describe('workflow-aware Work Item display', () => {
  test('resolves configured labels, categories, and allowed transitions', () => {
    const workItem = { status: 'todo' as const, workflowStatusId: 'active' }

    expect(resolveWorkflowStatusLabel(workItem, workspaceWorkItemConfigurationFixture)).toBe(
      'In progress',
    )
    expect(resolveWorkflowStatusCategory(workItem, workspaceWorkItemConfigurationFixture)).toBe(
      'started',
    )
    expect(resolveAllowedWorkflowStatuses('active', workspaceWorkItemConfigurationFixture)
      .map((status) => status.id)).toEqual(['active', 'review', 'canceled'])
    expect(resolveWorkflowStatusCategory({
      ...workItem,
      statusCategory: 'completed',
    }, workspaceWorkItemConfigurationFixture)).toBe('completed')
  })

  test('keeps legacy completion semantics and supports custom field list helpers', () => {
    expect(isCompletedWorkItem({ status: 'done' })).toBe(true)
    expect(isCompletedWorkItem({ status: 'review' })).toBe(false)
    expect(isOpenWorkItem({ status: 'todo', statusCategory: 'canceled' })).toBe(false)
    expect(isOpenWorkItem({ status: 'in-progress' })).toBe(true)

    const workItem = {
      customFieldValues: {
        'risk-level': 'high' as const,
        disciplines: ['frontend', 'backend'],
      },
    }

    expect(formatWorkItemCustomFieldValue(workItem, getDefinition('risk-level'))).toBe('High')
    expect(matchesWorkItemCustomFieldFilter(
      workItem,
      getDefinition('disciplines'),
      ['backend'],
    )).toBe(true)
  })

  test('combines workflow category, typed custom field, and project scope filters', () => {
    const workItem = {
      assignedProjectId: 'refero',
      customFieldValues: {
        'release-blocker': false,
        'risk-level': 'high' as const,
      },
      status: 'in-progress' as const,
      statusCategory: 'started' as const,
      workflowStatusId: 'active',
    }

    expect(matchesWorkItemDefinitionFilter(
      workItem,
      workspaceWorkItemConfigurationFixture,
      { category: 'started', customFieldId: 'risk-level', customFieldValue: 'high' },
    )).toBe(true)
    expect(matchesWorkItemDefinitionFilter(
      workItem,
      workspaceWorkItemConfigurationFixture,
      { category: 'completed', customFieldId: '' },
    )).toBe(false)
    expect(matchesWorkItemDefinitionFilter(
      workItem,
      workspaceWorkItemConfigurationFixture,
      { category: 'all', customFieldId: 'release-blocker', customFieldValue: false },
    )).toBe(true)
    expect(matchesWorkItemDefinitionFilter(
      { ...workItem, assignedProjectId: 'other-project', customFieldValues: { budget: 100 } },
      workspaceWorkItemConfigurationFixture,
      { category: 'all', customFieldId: 'budget', customFieldValue: 100 },
    )).toBe(false)
  })
})

function appendField(formData: FormData, fieldId: string, value: string) {
  formData.append(createCustomFieldFormName(fieldId), value)
}

function getDefinition(fieldId: string): CustomFieldDefinition {
  const definition = definitions.find((candidate) => candidate.id === fieldId)

  if (!definition) {
    throw new Error(`Missing custom field fixture: ${fieldId}`)
  }

  return definition
}

function validationCodes(fieldId: string, value: string | number | boolean | string[]) {
  return validateCustomFieldValue(getDefinition(fieldId), value).map((error) => error.code)
}
