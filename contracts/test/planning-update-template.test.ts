import { describe, expect, test } from 'bun:test'
import {
  listMissingPlanningUpdateFields,
  MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH,
  readPlanningUpdateTemplateSettings,
} from '../src/planning-update-template'

describe('Planning update template settings', () => {
  test('orders required fields, drops duplicates and blank template text', () => {
    expect(readPlanningUpdateTemplateSettings({
      requiredFields: ['evidence', 'riskSummary', 'evidence'],
      template: { summary: '## Done\n', nextAction: '   ' },
    })).toEqual({
      requiredFields: ['riskSummary', 'evidence'],
      template: { summary: '## Done\n' },
    })
  })

  test('rejects unknown fields, non-text, and over-long template text', () => {
    expect(readPlanningUpdateTemplateSettings({ requiredFields: ['summary'], template: {} })).toBeUndefined()
    expect(readPlanningUpdateTemplateSettings({ requiredFields: [], template: { health: 'x' } })).toBeUndefined()
    expect(readPlanningUpdateTemplateSettings({ requiredFields: [], template: { summary: 1 } })).toBeUndefined()
    expect(readPlanningUpdateTemplateSettings({
      requiredFields: [],
      template: { summary: 'a'.repeat(MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH + 1) },
    })).toBeUndefined()
    expect(readPlanningUpdateTemplateSettings([])).toBeUndefined()
  })

  test('lists required fields that an update leaves blank', () => {
    const settings = { requiredFields: ['helpNeeded' as const, 'nextAction' as const, 'evidence' as const], template: {} }
    const input = { riskSummary: '', decisionSummary: '', helpNeeded: ' ', nextAction: 'Ship', evidence: [] }
    expect(listMissingPlanningUpdateFields(settings, input)).toEqual(['helpNeeded', 'evidence'])
    expect(listMissingPlanningUpdateFields(settings, { ...input, helpNeeded: 'Review', evidence: [{}] })).toEqual([])
  })
})
