import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  collectPlanningOwnerCandidates,
  createPlanningEntityEditorDraft,
  readPlanningOption,
  rebasePlanningEntityEditorDraft,
  resolvePlanningEntityEdit,
  resolvePlanningOwnerOptions,
  planningRiskOptions,
  type PlanningEntityEditorDraft,
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
    expect(problem({ progressMode: 'manual', manualProgress: '-1' })).toBe('manual-progress')
    expect(problem({ progressMode: 'manual', manualProgress: 'abc' })).toBe('manual-progress')
  })

  test('changes a Cycle cadence, capacity and carry-over policy', () => {
    const cycle = fixtureEntity('cycle-14')
    expect(resolvePlanningEntityEdit(cycle, createPlanningEntityEditorDraft(cycle), 2)).toEqual({
      kind: 'unchanged',
    })
    expect(resolvePlanningEntityEdit(cycle, {
      ...createPlanningEntityEditorDraft(cycle),
      cadenceUnit: 'month',
      cadenceCount: '1',
      capacity: '30',
      carryOverPolicy: 'keep-incomplete',
    }, 2)).toEqual({
      kind: 'patch',
      patch: {
        cadence: { unit: 'month', count: 1 },
        capacity: 30,
        carryOverPolicy: 'keep-incomplete',
      },
    })
  })

  test('rejects Cycle settings that would refuse Work Items', () => {
    const cycle = fixtureEntity('cycle-14')
    const draft = createPlanningEntityEditorDraft(cycle)
    const problem = (change: Partial<PlanningEntityEditorDraft>, committed = 2) => {
      const result = resolvePlanningEntityEdit(cycle, { ...draft, ...change }, committed)
      return result.kind === 'invalid' ? result.problem : result.kind
    }
    expect(problem({ cadenceCount: '0' })).toBe('cadence-count')
    expect(problem({ cadenceCount: '1.5' })).toBe('cadence-count')
    expect(problem({ capacity: '0' })).toBe('capacity')
    expect(problem({ capacity: '' })).toBe('capacity')
    expect(problem({ capacity: '2.5' })).toBe('capacity')
    expect(problem({ capacity: '1' })).toBe('capacity-below-committed')
    expect(problem({ capacity: '2' })).toBe('patch')
  })

  test('keeps a stored capacity of 0 so other Cycle fields stay editable', () => {
    const cycle = { ...fixtureEntity('cycle-14'), capacity: 0 }
    expect(resolvePlanningEntityEdit(cycle, {
      ...createPlanningEntityEditorDraft(cycle),
      title: 'Cycle 14 renamed',
    })).toEqual({ kind: 'patch', patch: { title: 'Cycle 14 renamed' } })
  })

  test('ignores Cycle fields for other entities', () => {
    const phase = fixtureEntity('phase-build')
    expect(resolvePlanningEntityEdit(phase, {
      ...createPlanningEntityEditorDraft(phase),
      capacity: 'not a number',
      cadenceCount: '',
    })).toEqual({ kind: 'unchanged' })
  })

  test('accepts stored fractional manual progress so unrelated edits can be saved', () => {
    const phase = { ...fixtureEntity('phase-build'), manualProgress: 12.5 }
    expect(resolvePlanningEntityEdit(phase, {
      ...createPlanningEntityEditorDraft(phase),
      title: 'Renamed',
    })).toEqual({ kind: 'patch', patch: { title: 'Renamed' } })
    expect(resolvePlanningEntityEdit(phase, {
      ...createPlanningEntityEditorDraft(phase),
      manualProgress: '33.3',
    })).toEqual({ kind: 'patch', patch: { manualProgress: 33.3 } })
  })

  test('keeps unsaved edits and takes other fields from a newer stored version', () => {
    const phase = fixtureEntity('phase-build')
    const draft: PlanningEntityEditorDraft = { ...createPlanningEntityEditorDraft(phase), title: 'My title', risk: 'critical' }
    const newer: PlanningEntity = { ...phase, health: 'off-track', title: 'Their title', updatedAt: '2099-01-01T00:00:00.000Z' }
    const rebased = rebasePlanningEntityEditorDraft(phase, newer, draft)
    expect(rebased).toEqual({
      ...createPlanningEntityEditorDraft(newer),
      title: 'My title',
      risk: 'critical',
    })
    expect(resolvePlanningEntityEdit(newer, rebased)).toEqual({
      kind: 'patch',
      patch: { title: 'My title', risk: 'critical' },
    })
  })

  test('resets to the stored values after a successful save', () => {
    const phase = fixtureEntity('phase-build')
    const draft: PlanningEntityEditorDraft = { ...createPlanningEntityEditorDraft(phase), status: 'completed' }
    const saved: PlanningEntity = { ...phase, status: 'completed', updatedAt: '2099-01-01T00:00:00.000Z' }
    expect(rebasePlanningEntityEditorDraft(phase, saved, draft)).toEqual(
      createPlanningEntityEditorDraft(saved),
    )
  })

  test('treats saved values that the save normalized as no longer edited', () => {
    const phase = fixtureEntity('phase-build')
    const draft: PlanningEntityEditorDraft = {
      ...createPlanningEntityEditorDraft(phase),
      title: ' New title ',
      ownerMemberKey: ' New-Owner@Example.com',
      manualProgress: '40.0',
    }
    const saved: PlanningEntity = {
      ...phase,
      title: 'New title',
      ownerMemberKey: 'new-owner@example.com',
      manualProgress: 40,
      updatedAt: '2099-01-01T00:00:00.000Z',
    }
    const rebased = rebasePlanningEntityEditorDraft(phase, saved, draft)
    expect(rebased).toEqual(createPlanningEntityEditorDraft(saved))

    // A later change by someone else now replaces the saved title instead of being reverted.
    const later: PlanningEntity = { ...saved, title: 'Their title', updatedAt: '2099-01-02T00:00:00.000Z' }
    expect(rebasePlanningEntityEditorDraft(saved, later, rebased).title).toBe('Their title')
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

describe('planning owner options', () => {
  test('lists members by label and keeps owners that no member matches', () => {
    expect(resolvePlanningOwnerOptions(
      [
        { memberKey: 'Zed@Example.com', label: 'Zed (zed@example.com)' },
        { memberKey: 'ann@example.com', label: 'Ann (ann@example.com)' },
        { memberKey: 'zed@example.com', label: 'Duplicate' },
      ],
      ['left@example.com', ' ANN@example.com', ''],
    )).toEqual([
      { memberKey: 'ann@example.com', label: 'Ann (ann@example.com)' },
      { memberKey: 'zed@example.com', label: 'Zed (zed@example.com)' },
      { memberKey: 'left@example.com', label: 'left@example.com' },
    ])
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

  test('is read-only without permission', () => {
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

  })

  test('shows the Cycle settings with the Work Items already in the Cycle', () => {
    const cycle = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="cycle-14"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onUpdateEntity={() => undefined}
      />,
    )
    const editor = cycle.slice(cycle.indexOf('data-testid="planning-entity-editor"'))
    expect(editor).toContain('data-testid="planning-entity-editor-cycle"')
    expect(editor).toContain('name="cadenceCount"')
    expect(editor).toContain('name="capacity"')
    expect(editor).toContain('name="carryOverPolicy"')
    expect(editor).toContain(labels.entityEditor.capacityHint(2))

    const phase = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="phase-build"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onUpdateEntity={() => undefined}
      />,
    )
    expect(phase).not.toContain('data-testid="planning-entity-editor-cycle"')
  })
  test('suggests members by name while the owner stays typeable', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="milestone-beta"
        labels={labels}
        ownerOptions={[{ memberKey: 'ann@example.com', label: 'Ann (ann@example.com)' }]}
        snapshot={planningSnapshotFixture}
        onCreateEntity={() => undefined}
        onUpdateEntity={() => undefined}
      />,
    )
    const milestone = fixtureEntity('milestone-beta')
    const editor = html.slice(
      html.indexOf('data-testid="planning-entity-editor"'),
      html.indexOf('data-testid="planning-create-entity"'),
    )
    expect(editor).toContain(`name="ownerMemberKey" value="${milestone.ownerMemberKey}"`)
    expect(editor).toContain('<option label="Ann (ann@example.com)" value="ann@example.com">')
    expect(editor).toContain(labels.entityEditor.ownerPickerHint)
    expect(editor).not.toContain('<select class="workbench-input h-10 px-3" name="ownerMemberKey"')

    const create = html.slice(html.indexOf('data-testid="planning-create-entity"'))
    expect(create).toContain(`placeholder="${labels.ownerPlaceholder}"`)
    expect(create).toContain('<option label="Ann (ann@example.com)" value="ann@example.com">')
    expect(create).not.toContain(labels.retry)
  })

  test('keeps the typed owner field and offers a retry when members fail to load', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="milestone-beta"
        labels={labels}
        ownerOptionsErrorMessage="Some members could not be loaded."
        snapshot={planningSnapshotFixture}
        onCreateEntity={() => undefined}
        onRetryOwnerOptions={() => undefined}
        onUpdateEntity={() => undefined}
      />,
    )
    const editor = html.slice(
      html.indexOf('data-testid="planning-entity-editor"'),
      html.indexOf('data-testid="planning-create-entity"'),
    )
    expect(editor).toContain('<datalist')
    expect(editor).toContain(labels.entityEditor.ownerHint)
    expect(editor).toContain('Some members could not be loaded.')
    expect(editor).toContain(`>${labels.retry}</button>`)
    const create = html.slice(html.indexOf('data-testid="planning-create-entity"'))
    expect(create).toContain('Some members could not be loaded.')
  })
})
