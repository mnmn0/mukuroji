import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  emptyPlanningSnapshotFixture,
  planningSnapshotFixture,
} from '../src/planning/fixtures'
import { createPlanningLabels } from '../src/planning/labels'
import {
  PlanningScreen,
} from '../src/planning/PlanningScreen'
import {
  resolvePlanningMoveSelection,
  resolvePlanningParentCandidates,
} from '../src/planning/hierarchy'
import { createPlanningEntityDetailKey } from '../src/planning/selectors'
import { resolvePlanningViewTabTarget } from '../src/routes/paths'

const labels = createPlanningLabels('en')

describe('PlanningScreen', () => {
  test('uses roving tab stops and wraps Planning view arrow navigation', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        labels={labels}
        snapshot={planningSnapshotFixture}
      />,
    )
    const tabMarkup = (view: 'timeline' | 'roadmap' | 'portfolio') => {
      const markerIndex = html.indexOf(`data-testid="planning-view-${view}"`)
      return html.slice(
        html.lastIndexOf('<button', markerIndex),
        html.indexOf('</button>', markerIndex),
      )
    }

    expect(tabMarkup('timeline')).toContain('aria-selected="false"')
    expect(tabMarkup('timeline')).toContain('aria-controls="planning-view-panel"')
    expect(tabMarkup('timeline')).toContain('tabindex="-1"')
    expect(tabMarkup('roadmap')).toContain('aria-selected="true"')
    expect(tabMarkup('roadmap')).toContain('tabindex="0"')
    expect(tabMarkup('portfolio')).toContain('aria-selected="false"')
    expect(tabMarkup('portfolio')).toContain('tabindex="-1"')
    expect(html).toContain('aria-labelledby="planning-view-roadmap"')
    expect(html).toContain('id="planning-view-panel"')
    expect(html).toContain('role="tabpanel"')
    expect(resolvePlanningViewTabTarget('timeline', 'ArrowLeft')).toBe('portfolio')
    expect(resolvePlanningViewTabTarget('portfolio', 'ArrowRight')).toBe('timeline')
    expect(resolvePlanningViewTabTarget('roadmap', 'Home')).toBe('timeline')
    expect(resolvePlanningViewTabTarget('roadmap', 'End')).toBe('portfolio')
    expect(resolvePlanningViewTabTarget('roadmap', 'Enter')).toBeUndefined()
  })

  test('remounts detail forms when the same Entity receives new saved defaults', () => {
    const entity = planningSnapshotFixture.entities.find((candidate) => candidate.id === 'cycle-14')!

    expect(createPlanningEntityDetailKey({
      ...entity,
      teamId: 'next-team',
      updatedAt: '2026-07-16T10:00:00.000Z',
    })).not.toBe(createPlanningEntityDetailKey(entity))
    expect(createPlanningEntityDetailKey({
      ...entity,
      health: 'off-track',
      updatedAt: '2026-07-16T10:00:00.000Z',
    })).not.toBe(createPlanningEntityDetailKey(entity))
  })

  test('renders critical path, milestone editing, dependencies, cycle rollover, and creation', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onChangeMilestoneDate={() => undefined}
        onCreateDependency={() => undefined}
        onCreateEntity={() => undefined}
        onDeleteDependency={() => undefined}
        onRolloverCycle={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-timeline"')
    expect(html).toContain('data-critical="true"')
    expect(html).toContain('data-testid="milestone-date-editor"')
    expect(html).toContain('data-testid="dependency-editor"')
    expect(html).toContain('data-testid="cycle-rollover"')
    expect(html).toContain('data-testid="planning-create-entity"')
    expect(html).toContain(labels.dependencyLag)
    expect(html).toContain(`name="goalFramework"`)
    expect(html).toContain('value="objective"')
    expect(html).toContain('value="key-result"')
    expect(html).toContain('value="cycle-15" selected=""')
    expect(html).toContain('Build onboarding journey')
  })

  test('exposes Cycle archive, duplicate, root move scope, and status controls in Timeline', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        canManageEntity={() => true}
        canUpdateEntityStatus={() => true}
        initialSelectedEntityId="cycle-14"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onAddStatusUpdate={() => undefined}
        onArchiveEntity={() => undefined}
        onDuplicateEntity={() => undefined}
        onMoveEntity={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-timeline-entity-detail"')
    expect(html).toContain('data-testid="planning-status-update"')
    expect(html).toContain('data-testid="planning-entity-actions"')
    expect(html).toContain('data-testid="planning-root-move-scope"')
    expect(html).toContain('value="core-team"')
    expect(html).toContain(`>${labels.archive}</button>`)
    expect(html).toContain(`>${labels.duplicate}</button>`)
    expect(html).toContain(`>${labels.move}</button>`)
  })

  test('hides rollover execution and explains when the selected source Cycle is closed', () => {
    const snapshot = {
      ...planningSnapshotFixture,
      entities: planningSnapshotFixture.entities.map((entity) =>
        entity.id === 'cycle-14' ? { ...entity, status: 'completed' as const } : entity,
      ),
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        labels={labels}
        snapshot={snapshot}
        onRolloverCycle={() => undefined}
      />,
    )
    const rolloverHtml = html.slice(
      html.indexOf('data-testid="cycle-rollover"'),
      html.indexOf('</form>', html.indexOf('data-testid="cycle-rollover"')),
    )

    expect(rolloverHtml).toContain('data-testid="cycle-rollover-closed"')
    expect(rolloverHtml).toContain(labels.closedCycleRollover)
    expect(rolloverHtml).not.toContain('name="targetCycleId"')
    expect(rolloverHtml).not.toContain('type="submit"')
  })

  test('traces a selected Goal to canonical Work Items and exposes planning editors', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="goal-activation"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onAddStatusUpdate={() => undefined}
        onArchiveEntity={() => undefined}
        onDeleteWorkItemLink={() => undefined}
        onDuplicateEntity={() => undefined}
        onMoveEntity={() => undefined}
        onOpenWorkItem={() => undefined}
        onSaveWorkItemLink={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-roadmap"')
    expect(html).toContain('Improve first-week activation')
    expect(html).toContain('Finalize onboarding copy')
    expect(html).toContain('Instrument activation events')
    expect(html).toContain('data-testid="planning-status-update"')
    expect(html).toContain('data-testid="planning-work-item-link"')
    expect(html).toContain('data-testid="planning-entity-actions"')
    expect(html).toContain('value="cycle-14" selected=""')
    expect(html).toContain('value="milestone-beta" selected=""')
    expect(html).toContain('value="goal-activation" selected=""')
    expect(html).toContain('multiple="" name="goalIds"')
    expect(html).toContain('value="initiative-onboarding" selected=""')
  })

  test('shows reported and roll-up health independently in Portfolio', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="portfolio"
        labels={labels}
        snapshot={planningSnapshotFixture}
      />,
    )

    expect(html).toContain('data-testid="planning-portfolio"')
    expect(html).toContain(labels.reportedHealth)
    expect(html).toContain(labels.rollupHealth)
    expect(html).toContain('Product portfolio')
    expect(html).toContain(labels.healthValues['at-risk'])
  })

  test('rolls a Key Result Work Item up through its Objective strategic trace', () => {
    const objective = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'goal-activation',
    )!
    const keyResult: PlanningEntity = {
      ...objective,
      id: 'key-result-events',
      title: 'Activation event coverage',
      parentId: objective.id,
      goalFramework: 'key-result',
      linkedWorkItemCount: 1,
    }
    const snapshot = {
      ...planningSnapshotFixture,
      entities: [...planningSnapshotFixture.entities, keyResult],
      workItemLinks: planningSnapshotFixture.workItemLinks.map((link) =>
        link.workItemId === 'journey-events'
          ? { ...link, goalIds: [keyResult.id] }
          : link,
      ),
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId={objective.id}
        labels={labels}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('data-testid="planning-work-item-trace-journey-events"')
    expect(html).toContain(
      'Product portfolio › Growth roadmap › Onboarding acceleration › Improve first-week activation › Activation event coverage',
    )
    expect(html).toContain('Instrument activation events')
  })

  test('traces a milestone-only Work Item through its Goal strategic ancestors', () => {
    const snapshot = {
      ...planningSnapshotFixture,
      entities: planningSnapshotFixture.entities.map((entity) => {
        if (entity.id === 'goal-activation') return { ...entity, linkedWorkItemCount: 1 }
        if (entity.id === 'phase-build') return { ...entity, parentId: 'goal-activation' }
        if (entity.id === 'milestone-beta') return { ...entity, parentId: 'phase-build' }
        return entity
      }),
      workItemLinks: [{
        ...planningSnapshotFixture.workItemLinks[0]!,
        cycleId: undefined,
        goalIds: [],
      }],
      workItems: [planningSnapshotFixture.workItems[0]!],
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="goal-activation"
        labels={labels}
        snapshot={snapshot}
      />,
    )
    const goalWorkItemsHtml = html.slice(
      html.indexOf('data-testid="goal-work-items"'),
      html.indexOf('</section>', html.indexOf('data-testid="goal-work-items"')),
    )

    expect(html).toContain(`Goal / OKR · ${labels.workItemCount(1)}`)
    expect(goalWorkItemsHtml).toContain('Finalize onboarding copy')
    expect(goalWorkItemsHtml).toContain(
      'Product portfolio › Growth roadmap › Onboarding acceleration › Improve first-week activation',
    )
  })

  test('excludes archived and canceled Goal subtrees from ancestor Work Item rollups', () => {
    const objective = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'goal-activation',
    )!

    for (const closedFields of [
      { archivedAt: '2026-07-16T04:00:00.000Z' },
      { status: 'canceled' as const },
    ]) {
      const closedKeyResult: PlanningEntity = {
        ...objective,
        id: 'key-result-closed',
        title: 'Closed activation result',
        parentId: objective.id,
        goalFramework: 'key-result',
        linkedWorkItemCount: 0,
        ...closedFields,
      }
      const snapshot = {
        ...planningSnapshotFixture,
        entities: [...planningSnapshotFixture.entities, closedKeyResult],
        workItemLinks: planningSnapshotFixture.workItemLinks.map((link) =>
          link.workItemId === 'journey-events'
            ? { ...link, goalIds: [closedKeyResult.id] }
            : link,
        ),
      }
      const html = renderToStaticMarkup(
        <PlanningScreen
          activeView="roadmap"
          initialSelectedEntityId={objective.id}
          labels={labels}
          snapshot={snapshot}
        />,
      )
      const goalWorkItemsHtml = html.slice(
        html.indexOf('data-testid="goal-work-items"'),
        html.indexOf('</section>', html.indexOf('data-testid="goal-work-items"')),
      )

      expect(goalWorkItemsHtml).toContain('Finalize onboarding copy')
      expect(goalWorkItemsHtml).not.toContain('Instrument activation events')
      expect(goalWorkItemsHtml).not.toContain('planning-work-item-trace-journey-events')
    }
  })

  test('shows status update message, author, timestamp, health, and risk history', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        labels={labels}
        snapshot={planningSnapshotFixture}
      />,
    )

    expect(html).toContain('data-testid="planning-status-update-history"')
    expect(html).toContain('Research is complete; implementation risk remains.')
    expect(html).toContain('lead@example.com')
    expect(html).toContain('2026')
    expect(html).toContain(labels.healthValues['at-risk'])
    expect(html).toContain(`${labels.risk}: ${labels.riskValues.high}`)
  })

  test('filters Work Item link choices by selected Work Item scope and open lifecycle', () => {
    const milestone = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'milestone-beta',
    )!
    const snapshot = {
      ...planningSnapshotFixture,
      entities: [
        ...planningSnapshotFixture.entities,
        { ...milestone, id: 'milestone-other-team', title: 'Other team milestone', teamId: 'other-team' },
        { ...milestone, id: 'milestone-other-project', title: 'Other project milestone', projectId: 'other-project' },
        { ...milestone, id: 'milestone-completed', title: 'Completed milestone', status: 'completed' as const },
      ],
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        labels={labels}
        snapshot={snapshot}
        onSaveWorkItemLink={() => undefined}
      />,
    )
    const linkEditorHtml = html.slice(
      html.indexOf('data-testid="planning-work-item-link"'),
      html.indexOf('</form>', html.indexOf('data-testid="planning-work-item-link"')),
    )

    expect(linkEditorHtml).toContain('Beta ready')
    expect(linkEditorHtml).toContain('Improve first-week activation')
    expect(linkEditorHtml).not.toContain('Other team milestone')
    expect(linkEditorHtml).not.toContain('Other project milestone')
    expect(linkEditorHtml).not.toContain('Completed milestone')
  })

  test('allows unlinking archived targets without offering them as new link choices', () => {
    const archivedEntityIds = new Set([
      'cycle-14',
      'milestone-beta',
      'goal-activation',
    ])
    const snapshot = {
      ...planningSnapshotFixture,
      entities: planningSnapshotFixture.entities.map((entity) =>
        archivedEntityIds.has(entity.id)
          ? { ...entity, archivedAt: '2026-07-16T05:00:00.000Z' }
          : entity,
      ),
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        labels={labels}
        snapshot={snapshot}
        onDeleteWorkItemLink={() => undefined}
        onSaveWorkItemLink={() => undefined}
      />,
    )
    const linkEditorHtml = html.slice(
      html.indexOf('data-testid="planning-work-item-link"'),
      html.indexOf('</form>', html.indexOf('data-testid="planning-work-item-link"')),
    )
    const unlinkLabel = `>${labels.unlinkWorkItem}</button>`
    const unlinkLabelIndex = linkEditorHtml.indexOf(unlinkLabel)

    expect(linkEditorHtml).toContain('Cycle 15')
    expect(linkEditorHtml).not.toContain('Cycle 14')
    expect(linkEditorHtml).not.toContain('Beta ready')
    expect(linkEditorHtml).not.toContain('Improve first-week activation')
    expect(unlinkLabelIndex).toBeGreaterThan(-1)
    expect(linkEditorHtml.slice(
      linkEditorHtml.lastIndexOf('<button', unlinkLabelIndex),
      unlinkLabelIndex,
    )).not.toContain(' disabled=""')
  })

  test('offers Objective parents only to Key Results', () => {
    const objective = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'goal-activation',
    )!

    expect(resolvePlanningParentCandidates(
      planningSnapshotFixture.entities,
      'goal',
      'key-result',
    )).toEqual([objective])
    expect(resolvePlanningParentCandidates(
      planningSnapshotFixture.entities,
      'goal',
      'objective',
    ).map((entity) => entity.id)).toEqual(['initiative-onboarding'])
  })

  test('inherits target parent scope for a parent-driven subtree move', () => {
    const target = resolvePlanningMoveSelection(
      planningSnapshotFixture.entities,
      'goal-activation',
    )

    expect(target?.parent?.id).toBe('goal-activation')
    expect(target?.teamId).toBe('core-team')
    expect(target?.projectId).toBeUndefined()
  })

  test('hides duplicate when the effective parent is outside manager scope', () => {
    const roadmap = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'roadmap-growth',
    )!
    const snapshot = {
      ...planningSnapshotFixture,
      entities: planningSnapshotFixture.entities.map((entity) =>
        entity.id === roadmap.id
          ? { ...entity, teamId: 'core-team', projectId: 'refero' }
          : entity,
      ),
    }
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        canManageEntity={(entity) => entity.id === roadmap.id}
        initialSelectedEntityId={roadmap.id}
        labels={labels}
        snapshot={snapshot}
        onDuplicateEntity={() => undefined}
      />,
    )

    expect(html).toContain(roadmap.title)
    expect(html).not.toContain(`>${labels.duplicate}</button>`)
  })

  test('keeps entity creation available from the empty state', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        labels={labels}
        snapshot={emptyPlanningSnapshotFixture}
        onCreateEntity={() => undefined}
      />,
    )

    expect(html).toContain(labels.emptyTitle)
    expect(html).toContain('data-testid="planning-create-entity"')
    expect(html).toContain('value="portfolio" selected=""')
  })

  test('only offers manageable root scopes when creating an entity', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        canCreateInScope={(scope) => scope.teamId === 'managed-team' &&
          (!scope.projectId || scope.projectId === 'managed-project')}
        createScopeTeams={[
          {
            id: 'managed-team',
            name: 'Managed team',
            projects: [
              { id: 'managed-project', name: 'Managed project' },
              { id: 'viewer-project', name: 'Viewer project' },
            ],
          },
          {
            id: 'viewer-team',
            name: 'Viewer team',
            projects: [],
          },
        ]}
        labels={labels}
        snapshot={emptyPlanningSnapshotFixture}
        onCreateEntity={() => undefined}
      />,
    )
    const createFormHtml = html.slice(
      html.indexOf('data-testid="planning-create-entity"'),
      html.indexOf('</form>', html.indexOf('data-testid="planning-create-entity"')),
    )

    expect(createFormHtml).toContain('Managed team')
    expect(createFormHtml).toContain('Managed project')
    expect(createFormHtml).not.toContain('Viewer team')
    expect(createFormHtml).not.toContain('Viewer project')
    expect(createFormHtml).toContain('value="managed-team" selected=""')
  })

  test('disables root entity creation when no manageable scope is available', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        canCreateInScope={() => false}
        labels={labels}
        snapshot={emptyPlanningSnapshotFixture}
        onCreateEntity={() => undefined}
      />,
    )
    const createFormHtml = html.slice(
      html.indexOf('data-testid="planning-create-entity"'),
      html.indexOf('</form>', html.indexOf('data-testid="planning-create-entity"')),
    )
    const createLabel = `>${labels.create}</button>`
    const createButtonIndex = createFormHtml.indexOf(createLabel)

    expect(createButtonIndex).toBeGreaterThan(-1)
    expect(createFormHtml.slice(
      createFormHtml.lastIndexOf('<button', createButtonIndex),
      createButtonIndex,
    )).toContain(' disabled=""')
  })
})
