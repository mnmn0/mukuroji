import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  collectPlanningOwnerCandidates,
  createPlanningEntityEditorDraft,
  readPlanningOption,
  resolvePlanningEntityEdit,
  planningRiskOptions,
} from '../src/planning/model/entityEditor'
import { createPlanningLabels } from '../src/planning/ui/labels'
import { PlanningScreen } from '../src/planning/ui/PlanningScreen'

const labels = createPlanningLabels('en')

/** Returns a fixture entity by ID, failing the test when the fixture changes. */
function fixtureEntity(id: string): PlanningEntity {
  const entity = planningSnapshotFixture.entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Planning fixture ${id} is missing.`)
  return entity
}

describe('planning entity edit patch', () => {
  test('reports no change for an untouched draft', () => {
    const phase = fixtureEntity('phase-build')
    expect(resolvePlanningEntityEdit(phase, createPlanningEntityEditorDraft(phase))).toEqual({
      kind: 'unchanged',
    })
  })

  test('sends only the fields that changed, such as completing a Milestone and changing its owner', () => {
    const milestone = fixtureEntity('milestone-beta')
    const result = resolvePlanningEntityEdit(milestone, {
      ...createPlanningEntityEditorDraft(milestone),
      status: 'completed',
      ownerMemberKey: '  new-owner@example.com ',
    })
    expect(result).toEqual({
      kind: 'patch',
      patch: { status: 'completed', ownerMemberKey: 'new-owner@example.com' },
    })
  })

  test('keeps Milestone ranges single-day by following the end date', () => {
    const milestone = fixtureEntity('milestone-beta')
    const result = resolvePlanningEntityEdit(milestone, {
      ...createPlanningEntityEditorDraft(milestone),
      forecastStart: '2000-01-01',
      forecastEnd: '2099-12-31',
    })
    expect(result).toEqual({
      kind: 'patch',
      patch: { forecast: { startDate: '2099-12-31', endDate: '2099-12-31' } },
    })
  })

  test('re-plans a Phase and updates its manual progress', () => {
    const phase = fixtureEntity('phase-build')
    const result = resolvePlanningEntityEdit(phase, {
      ...createPlanningEntityEditorDraft(phase),
      forecastStart: '2099-01-01',
      forecastEnd: '2099-02-01',
      progressMode: 'manual',
      manualProgress: '40',
      health: 'at-risk',
      risk: 'high',
    })
    expect(result).toEqual({
      kind: 'patch',
      patch: {
        health: 'at-risk',
        risk: 'high',
        manualProgress: 40,
        forecast: { startDate: '2099-01-01', endDate: '2099-02-01' },
      },
    })
  })

  test('switches a Phase back to automatic progress without touching the stored manual value', () => {
    const phase = fixtureEntity('phase-build')
    expect(resolvePlanningEntityEdit(phase, {
      ...createPlanningEntityEditorDraft(phase),
      progressMode: 'automatic',
      manualProgress: '',
    })).toEqual({ kind: 'patch', patch: { progressMode: 'automatic' } })
  })

  test('clears a stored description with null and trims a new one', () => {
    const goal = { ...fixtureEntity('goal-activation'), description: 'Old' }
    expect(resolvePlanningEntityEdit(goal, {
      ...createPlanningEntityEditorDraft(goal),
      description: '   ',
    })).toEqual({ kind: 'patch', patch: { description: null } })
    expect(resolvePlanningEntityEdit(goal, {
      ...createPlanningEntityEditorDraft(goal),
      description: ' New ',
    })).toEqual({ kind: 'patch', patch: { description: 'New' } })
  })

  test('rejects drafts the server would refuse', () => {
    const phase = fixtureEntity('phase-build')
    const draft = createPlanningEntityEditorDraft(phase)
    const problem = (change: Partial<typeof draft>) => {
      const result = resolvePlanningEntityEdit(phase, { ...draft, ...change })
      return result.kind === 'invalid' ? result.problem : undefined
    }
    expect(problem({ title: '  ' })).toBe('title-required')
    expect(problem({ ownerMemberKey: '' })).toBe('owner-required')
    expect(problem({ baselineEnd: '' })).toBe('date-required')
    expect(problem({ forecastStart: '2099-02-02', forecastEnd: '2099-02-01' })).toBe('date-range')
    expect(problem({ progressMode: 'manual', manualProgress: '' })).toBe('manual-progress')
    expect(problem({ progressMode: 'manual', manualProgress: '101' })).toBe('manual-progress')
    expect(problem({ progressMode: 'manual', manualProgress: '12.5' })).toBe('manual-progress')
  })

  test('suggests each owner once and narrows select values to known options', () => {
    expect(collectPlanningOwnerCandidates(planningSnapshotFixture.entities)).toEqual([
      'builder@example.com',
      'lead@example.com',
      'owner@example.com',
    ])
    expect(readPlanningOption('high', planningRiskOptions)).toBe('high')
    expect(readPlanningOption('severe', planningRiskOptions)).toBeUndefined()
  })
})

describe('planning entity editor', () => {
  test('shows the selected Milestone with single-day dates and a save button', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="milestone-beta"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onUpdateEntity={() => undefined}
      />,
    )
    const editor = html.slice(html.indexOf('data-testid="planning-entity-editor"'))
    expect(editor).toContain(labels.entityEditor.title)
    expect(editor).toContain(labels.entityEditor.forecastDate)
    expect(editor).not.toContain(labels.entityEditor.forecastStart)
    expect(editor).toContain(labels.entityEditor.save)
  })

  test('is read-only without permission and hidden for Cycles', () => {
    const readOnly = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        canManageEntity={() => false}
        initialSelectedEntityId="phase-build"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onUpdateEntity={() => undefined}
      />,
    )
    const editor = readOnly.slice(readOnly.indexOf('data-testid="planning-entity-editor"'))
    expect(editor).toContain('<fieldset class="grid gap-3" disabled=""')
    expect(editor).toContain(labels.entityEditor.readOnly)

    const cycle = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="cycle-14"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onUpdateEntity={() => undefined}
      />,
    )
    expect(cycle).not.toContain('data-testid="planning-entity-editor"')
  })
})
