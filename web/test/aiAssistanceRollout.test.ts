import { describe, expect, test } from 'bun:test'
import {
  isAiAssistanceTaskEnabled,
  isAiAssistanceUiEnabled,
} from '../src/features/ai-assistance/model/aiAssistanceRollout'

describe('AI assistance UI rollout', () => {
  /** Verifies rollout remains disabled until deployment opts in explicitly. */
  test('stays disabled unless the deployment opts in explicitly', () => {
    expect(isAiAssistanceUiEnabled({})).toBe(false)
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: 'false' })).toBe(false)
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: '1' })).toBe(false)
  })

  /** Verifies only the explicit true value enables the rollout. */
  test('accepts only the explicit true rollout value', () => {
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: true })).toBe(true)
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: 'true' })).toBe(true)
  })

  /** Verifies personal opt-out and manager policy task allowlists fail closed. */
  test('gates task controls using the saved preference and policy', () => {
    const base = {
      authenticated: true,
      canManagePolicy: true,
      preferenceEnabled: true,
      rolloutEnabled: true,
    }

    expect(isAiAssistanceTaskEnabled('summary', base)).toBe(false)
    expect(isAiAssistanceTaskEnabled('summary', {
      ...base,
      policy: { enabled: true, enabledTasks: ['summary'] },
    })).toBe(true)
    expect(isAiAssistanceTaskEnabled('search', {
      ...base,
      policy: { enabled: true, enabledTasks: ['summary'] },
    })).toBe(false)
    expect(isAiAssistanceTaskEnabled('summary', {
      ...base,
      preferenceEnabled: false,
      policy: { enabled: true, enabledTasks: ['summary'] },
    })).toBe(false)
  })

  /** Verifies non-managers defer the unreadable Workspace policy to the server. */
  test('keeps non-manager controls available when personal preference is enabled', () => {
    expect(isAiAssistanceTaskEnabled('summary', {
      authenticated: true,
      canManagePolicy: false,
      preferenceEnabled: true,
      rolloutEnabled: true,
    })).toBe(true)
  })
})
