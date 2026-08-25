import { describe, expect, test } from 'bun:test'
import { resolveDocumentContextTabTarget } from '../src/documents/model/contextTabs'
import { createAiAssistantSessionKey } from '../src/features/ai-assistance/model/assistantSessionKey'
import { aiPlanningGenerationFixture } from '../src/features/ai-assistance/fixtures'
import { routeAiPlanningDraftAdoption } from '../src/planning/model/aiDraftAdoption'

describe('AI assistant source sessions', () => {
  test('changes the mounted session key with source identity or revision', () => {
    const original = createAiAssistantSessionKey({
      expectedRevision: 7,
      teamId: 'core-team',
      type: 'work-item',
      workItemId: 'launch-review',
    })

    expect(createAiAssistantSessionKey({
      expectedRevision: 8,
      teamId: 'core-team',
      type: 'work-item',
      workItemId: 'launch-review',
    })).not.toBe(original)
    expect(createAiAssistantSessionKey({
      expectedRevision: 7,
      teamId: 'core-team',
      type: 'work-item',
      workItemId: 'accessibility-review',
    })).not.toBe(original)
  })

  test('serializes equivalent Planning targets deterministically', () => {
    const first = createAiAssistantSessionKey({
      expectedRevision: 14,
      target: {
        projectId: 'launch',
        teamId: 'core-team',
        type: 'project',
      },
      type: 'planning-target',
    })
    const second = createAiAssistantSessionKey({
      type: 'planning-target',
      target: {
        type: 'project',
        teamId: 'core-team',
        projectId: 'launch',
      },
      expectedRevision: 14,
    })

    expect(second).toBe(first)
    expect(createAiAssistantSessionKey({
      expectedRevision: 15,
      target: {
        projectId: 'launch',
        teamId: 'core-team',
        type: 'project',
      },
      type: 'planning-target',
    })).not.toBe(first)
  })
})

describe('Planning AI draft adoption safety', () => {
  test('stages a reviewed draft instead of replacing dirty manual fields', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }
    const draft = content.draft.statusUpdate
    if (!draft) throw new Error('Planning fixture must include a status update.')

    let appliedCount = 0
    let confirmationCount = 0
    const result = routeAiPlanningDraftAdoption(draft, true, {
      apply: () => { appliedCount += 1 },
      confirm: () => { confirmationCount += 1 },
    })

    expect(result).toBe('confirmation-required')
    expect(appliedCount).toBe(0)
    expect(confirmationCount).toBe(1)
  })

  test('prefills a clean form without publishing a domain update', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }
    const draft = content.draft.statusUpdate
    if (!draft) throw new Error('Planning fixture must include a status update.')

    let appliedCount = 0
    const publishCount = 0
    const result = routeAiPlanningDraftAdoption(draft, false, {
      apply: () => { appliedCount += 1 },
      confirm: () => undefined,
    })

    expect(result).toBe('applied')
    expect(appliedCount).toBe(1)
    expect(publishCount).toBe(0)
  })

  test('uses the same confirmation boundary for a complete Work Item plan', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }

    let stagedDraft = content.draft
    const result = routeAiPlanningDraftAdoption(content.draft, true, {
      apply: () => undefined,
      confirm: (draft) => { stagedDraft = draft },
    })

    expect(result).toBe('confirmation-required')
    expect(stagedDraft.subtasks).toHaveLength(1)
    expect(stagedDraft.dependencies).toHaveLength(1)
    expect(stagedDraft.plannedEffortMinutes?.value).toBe(240)
  })
})

describe('Document context tab keyboard navigation', () => {
  const tabsWithoutBrief = [
    'comments',
    'backlinks',
    'versions',
    'activity',
  ] as const

  test('wraps Arrow navigation within the rendered permission-filtered tabs', () => {
    expect(resolveDocumentContextTabTarget(
      'comments',
      'ArrowLeft',
      tabsWithoutBrief,
    )).toBe('activity')
    expect(resolveDocumentContextTabTarget(
      'activity',
      'ArrowRight',
      tabsWithoutBrief,
    )).toBe('comments')
  })

  test('supports Home and End without focusing an omitted Brief tab', () => {
    expect(resolveDocumentContextTabTarget(
      'versions',
      'Home',
      tabsWithoutBrief,
    )).toBe('comments')
    expect(resolveDocumentContextTabTarget(
      'backlinks',
      'End',
      tabsWithoutBrief,
    )).toBe('activity')
    expect(resolveDocumentContextTabTarget(
      'comments',
      'Enter',
      tabsWithoutBrief,
    )).toBeUndefined()
  })
})
