import { describe, expect, test } from 'bun:test'
import { isAiAssistanceUiEnabled } from '../src/features/ai-assistance/model/aiAssistanceRollout'

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
})
