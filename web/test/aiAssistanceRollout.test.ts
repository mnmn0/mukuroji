import { describe, expect, test } from 'bun:test'
import {
  isAiAssistanceTaskEnabled,
  isAiAssistanceUiEnabled,
} from '../src/features/ai-assistance/model/aiAssistanceRollout'

describe('AI assistance UI rollout', () => {
  /** Verifies the API owns availability while builds retain an explicit kill switch. */
  test('defaults to server availability and honors the UI kill switch', () => {
    expect(isAiAssistanceUiEnabled({})).toBe(true)
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: 'false' })).toBe(false)
    expect(isAiAssistanceUiEnabled({ VITE_AI_ASSISTANCE_ENABLED: false })).toBe(false)
  })

  /** Verifies explicit true values also permit server-gated controls. */
  test('accepts explicit true rollout values', () => {
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
