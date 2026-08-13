import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  createPlanningUpdateEvidenceCandidates,
  createPlanningUpdateWorkItemEvidenceValue,
  readPlanningEvidenceHttpsUrl,
  readPlanningUpdateEvidence,
  submitPlanningUpdateCommentAndReset,
} from '../src/planning/model/statusUpdateView'
import {
  PlanningStatusUpdateComposer,
  readNonNegativeNumber,
} from '../src/planning/ui/PlanningUpdatePrimitives'
import { createPlanningLabels } from '../src/planning/ui/labels'

const labels = createPlanningLabels('en')

describe('Planning update evidence composer', () => {
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
