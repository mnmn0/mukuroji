import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { aiPlanningGenerationFixture } from '../src/features/ai-assistance/fixtures'
import {
  isValidPlanningDateTime,
  readNonNegativeNumber,
} from '../src/planning/model/cadenceForm'
import {
  createPlanningUpdateEvidenceCandidates,
  createPlanningUpdateWorkItemEvidenceValue,
  readPlanningEvidenceHttpsUrl,
  readPlanningUpdateEvidence,
  submitPlanningUpdateCommentAndReset,
} from '../src/planning/model/statusUpdateView'
import { PlanningStatusUpdateComposer } from '../src/planning/ui/PlanningUpdatePrimitives'
import { createPlanningLabels } from '../src/planning/ui/labels'

const labels = createPlanningLabels('en')

describe('Planning update evidence composer', () => {
  test('prefills an adopted AI status update without publishing it', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }
    const statusUpdate = content.draft.statusUpdate
    if (!statusUpdate) throw new Error('Planning fixture must include a status update.')
    let publishCount = 0
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        health="on-track"
        initialDraft={statusUpdate}
        labels={labels}
        onPublish={() => { publishCount += 1 }}
        progress={40}
      />,
    )

    expect(html).toContain('value="at-risk" selected=""')
    expect(html).toContain('value="medium" selected=""')
    expect(html).toContain(statusUpdate.summary)
    expect(html).toContain(statusUpdate.nextAction)
    expect(publishCount).toBe(0)
  })

  /** Verifies an in-flight AI decision cannot race the canonical publish action. */
  test('disables the manual publish form while an AI operation is pending', () => {
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        aiAssistance={{
          accessToken: 'test-access-token',
          isAiOperationPending: true,
          locale: 'en',
          source: {
            expectedRevision: planningSnapshotFixture.revision,
            target: {
              projectId: 'refero',
              teamId: 'core-team',
              type: 'project',
            },
            type: 'planning-target',
          },
        }}
        health="on-track"
        initialEvidenceType="link"
        labels={labels}
        onPublish={() => undefined}
        progress={40}
      />,
    )

    expect(html).toContain('name="summary" required=""')
    expect(html).toMatch(/<textarea[^>]*disabled=""[^>]*name="summary"/)
    expect(html).toContain('disabled="" aria-busy="false" type="submit"')
    expect(html).toMatch(/<input(?=[^>]*name="evidenceUrl")(?=[^>]*disabled="")[^>]*>/)
  })

  test('requires an explicit timezone offset for cadence deadlines', () => {
    expect(isValidPlanningDateTime('2026-03-01T15:00:00')).toBe(false)
    expect(isValidPlanningDateTime('2026-03-01T15:00:00.000Z')).toBe(true)
    expect(isValidPlanningDateTime('2026-03-01T15:00:00+09:00')).toBe(true)
  })

  test('rejects an empty non-negative number instead of converting it to zero', () => {
    expect(readNonNegativeNumber('')).toBeUndefined()
    expect(readNonNegativeNumber('   ')).toBeUndefined()
    expect(readNonNegativeNumber('0')).toBe(0)
  })

  test('preserves special characters in Team-qualified Work Item form values', () => {
    const teamId = 'team/"north"\0'
    const workItemId = 'issue?42&next=🚀'
    const value = createPlanningUpdateWorkItemEvidenceValue(teamId, workItemId)
    const candidates = {
      planningEntities: [],
      workItems: [{
        label: 'Special Work Item',
        teamId,
        value,
        workItemId,
      }],
    }
    const form = new FormData()
    form.set('evidenceType', 'work-item')
    form.set('evidenceWorkItem', value)
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        evidenceCandidates={candidates}
        health="on-track"
        initialEvidenceType="work-item"
        labels={labels}
        onPublish={() => undefined}
        progress={40}
      />,
    )

    expect(JSON.parse(value)).toEqual([teamId, workItemId])
    expect(html).toContain('name="evidenceWorkItem"')
    expect(html).toContain('Special Work Item')
    expect(readPlanningUpdateEvidence(form, candidates)).toEqual([{
      type: 'work-item',
      teamId,
      workItemId,
    }])
  })

  test('builds every supported typed evidence contract', () => {
    const candidates = {
      planningEntities: [{
        entityId: 'milestone-beta',
        label: 'Beta ready',
        value: 'milestone-beta',
      }],
      workItems: [],
    }
    const cases = [
      {
        fields: {
          evidenceType: 'planning-entity',
          evidencePlanningEntity: 'milestone-beta',
        },
        expected: [{ type: 'planning-entity', entityId: 'milestone-beta' }],
      },
      {
        fields: {
          evidenceType: 'file',
          evidenceFileId: 'brief.pdf',
          evidenceFileUrl: 'https://example.com/files/brief.pdf',
        },
        expected: [{
          type: 'file',
          fileId: 'brief.pdf',
          url: 'https://example.com/files/brief.pdf',
        }],
      },
      {
        fields: {
          evidenceType: 'link',
          evidenceLabel: 'Research',
          evidenceUrl: 'https://example.com/research',
        },
        expected: [{
          type: 'link',
          label: 'Research',
          url: 'https://example.com/research',
        }],
      },
    ]

    for (const { expected, fields } of cases) {
      const form = new FormData()
      for (const [name, value] of Object.entries(fields)) form.set(name, value)
      expect(readPlanningUpdateEvidence(form, candidates)).toEqual(expected)
    }
  })

  test('accepts only credential-free HTTPS evidence permalinks', () => {
    expect(readPlanningEvidenceHttpsUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    )
    expect(readPlanningEvidenceHttpsUrl('http://example.com/path')).toBeUndefined()
    expect(readPlanningEvidenceHttpsUrl('https://user@example.com/path')).toBeUndefined()
    expect(readPlanningEvidenceHttpsUrl('https://user:secret@example.com/path')).toBeUndefined()
    expect(readPlanningEvidenceHttpsUrl('https://example.com/path?token=secret')).toBeUndefined()
  })

  test('keeps Team-only Initiative evidence outside Project-specific records', () => {
    const target = { type: 'initiative' as const, entityId: 'initiative-onboarding' }
    const candidates = createPlanningUpdateEvidenceCandidates(planningSnapshotFixture, target)

    expect(candidates.planningEntities.some(({ entityId }) => entityId === 'initiative-onboarding')).toBe(true)
    expect(candidates.planningEntities.some(({ entityId }) => entityId === 'goal-activation')).toBe(true)
    expect(candidates.planningEntities.some(({ entityId }) => entityId === 'phase-build')).toBe(false)
    expect(candidates.workItems).toEqual([])
  })

  test('keeps Project evidence qualified by the exact Team and Project pair', () => {
    const candidates = createPlanningUpdateEvidenceCandidates(planningSnapshotFixture, {
      type: 'project',
      teamId: 'core-team',
      projectId: 'refero',
    })

    expect(candidates.planningEntities.map(({ entityId }) => entityId)).toEqual([
      'phase-build',
      'milestone-beta',
    ])
    expect(candidates.workItems.map(({ workItemId }) => workItemId)).toEqual([
      'journey-copy',
      'journey-events',
    ])
  })

  test('resets a comment only after persistence succeeds', async () => {
    let resetCount = 0
    await submitPlanningUpdateCommentAndReset(
      async () => undefined,
      'update-1',
      'Persisted comment',
      () => { resetCount += 1 },
    )
    expect(resetCount).toBe(1)

    await expect(submitPlanningUpdateCommentAndReset(
      async () => { throw new Error('persistence failed') },
      'update-1',
      'Keep this draft',
      () => { resetCount += 1 },
    )).rejects.toThrow('persistence failed')
    expect(resetCount).toBe(1)
  })
})
