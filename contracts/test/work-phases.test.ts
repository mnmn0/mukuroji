import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS,
  NO_WORK_PHASE_GROUP_KEY,
  findRemovedWorkPhaseKeys,
  readWorkPhaseKey,
  readWorkspaceWorkPhaseSettings,
  resolveWorkCategoryPhase,
} from '../src/work-phases'

describe('work phases', () => {
  test('accepts the defaults and Workspace phases with labels', () => {
    expect(readWorkspaceWorkPhaseSettings(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS)).toEqual(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS)
    expect(readWorkspaceWorkPhaseSettings({
      phases: [{ key: 'review', label: ' レビュー ', active: false }, { key: 'custom-ops', label: '運用', active: true }],
    })).toEqual({
      phases: [{ key: 'review', label: 'レビュー', active: false }, { key: 'custom-ops', label: '運用', active: true }],
      categoryPhases: {},
    })
  })

  test('refuses unnamed added phases, repeated keys, reserved keys, and unknown mapped phases', () => {
    expect(readWorkspaceWorkPhaseSettings({ phases: [{ key: 'custom-ops', active: true }] })).toBeUndefined()
    expect(readWorkspaceWorkPhaseSettings({ phases: [{ key: 'review', active: true }, { key: 'review', active: false }] })).toBeUndefined()
    expect(readWorkspaceWorkPhaseSettings({ phases: [] })).toBeUndefined()
    expect(readWorkPhaseKey(NO_WORK_PHASE_GROUP_KEY)).toBeUndefined()
    expect(readWorkPhaseKey('Review')).toBeUndefined()
    expect(readWorkspaceWorkPhaseSettings({
      phases: [{ key: 'review', active: true }],
      categoryPhases: { meeting: 'design' },
    })).toBeUndefined()
    expect(readWorkspaceWorkPhaseSettings({
      phases: [{ key: 'review', active: true }],
      categoryPhases: { 'no-work-item': 'review' },
    })).toBeUndefined()
  })

  test('resolves the phase of a category and lists dropped phases', () => {
    expect(resolveWorkCategoryPhase(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS, 'implementation')).toBe('implementation')
    expect(resolveWorkCategoryPhase(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS, 'meeting')).toBe(NO_WORK_PHASE_GROUP_KEY)
    expect(resolveWorkCategoryPhase(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS, undefined)).toBe(NO_WORK_PHASE_GROUP_KEY)
    expect(resolveWorkCategoryPhase(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS, 'constructor')).toBe(NO_WORK_PHASE_GROUP_KEY)
    expect(findRemovedWorkPhaseKeys(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS, {
      phases: [{ key: 'design', active: true }],
      categoryPhases: {},
    })).toEqual(['requirements', 'implementation', 'review', 'evaluation'])
  })
})
