import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  emptyPlanningSnapshotFixture,
  planningSnapshotFixture,
  planningUpdateHistoryFixture,
} from '../src/planning/fixtures'
import {
  createPlanningTargetUpdateView,
  type PlanningUpdateTargetDetailView,
} from '../src/planning/model/statusUpdateView'
import { createPlanningLabels } from '../src/planning/ui/labels'
import {
  PlanningScreen,
} from '../src/planning/ui/PlanningScreen'
import {
  resolvePlanningMoveSelection,
  resolvePlanningParentCandidates,
} from '../src/planning/model/hierarchy'
import { createPlanningEntityDetailKey } from '../src/planning/model/selectors'
import {
  createPlanningDependencyAnchorId,
  createPlanningDependencyPath,
  resolvePlanningViewTabTarget,
} from '../src/shared/routing/paths'

const labels = createPlanningLabels('en')

/** Creates the fixture-backed Initiative detail projection used by screen tests. */
function createInitiativeUpdateDetail(): PlanningUpdateTargetDetailView {
  const targetSummary = planningSnapshotFixture.updateTargets.find(
    (candidate) => candidate.target.type === 'initiative',
  )
  const initiative = planningSnapshotFixture.entities.find(
    (candidate) => candidate.id === 'initiative-onboarding',
  )
  if (!targetSummary || !initiative) {
    throw new Error('Planning Initiative fixture is incomplete.')
  }

  return {
    summary: {
      context: initiative.teamId,
      health: initiative.health,
      ownerMemberKey: initiative.ownerMemberKey,
      progress: initiative.progress,
      target: targetSummary.target,
      title: initiative.title,
    },
    updateView: createPlanningTargetUpdateView(
      targetSummary,
      planningUpdateHistoryFixture,
    ),
  }
}

/** Creates the fixture-backed Project detail projection used by screen tests. */
function createProjectUpdateDetail(): PlanningUpdateTargetDetailView {
  const targetSummary = planningSnapshotFixture.updateTargets.find(
    (candidate) => candidate.target.type === 'project',
  )
  if (!targetSummary || targetSummary.target.type !== 'project') {
    throw new Error('Planning Project fixture is incomplete.')
  }

  return {
    summary: {
      context: targetSummary.target.teamId,
      health: 'on-track',
      ownerMemberKey: 'builder@example.com',
      progress: 60,
      target: targetSummary.target,
      title: 'Refero',
    },
    updateView: createPlanningTargetUpdateView(targetSummary),
  }
}

/** Returns markup from one test marker through the requested closing element. */
function sliceElement(html: string, marker: string, closingElement: string) {
  const startIndex = html.indexOf(marker)
  if (startIndex < 0) {
    throw new Error(`Test marker not found in markup: ${marker}`)
  }
  const endIndex = html.indexOf(closingElement, startIndex)
  if (endIndex < 0) {
    throw new Error(`Test closing element not found in markup: ${closingElement}`)
  }
  return html.slice(
    html.lastIndexOf('<', startIndex),
    endIndex + closingElement.length,
  )
}

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

  test('keeps Planning readable while a recoverable access query can be retried', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        accessErrorMessage="Project directory unavailable. Project details may be missing."
        activeView="roadmap"
        labels={labels}
        onRetryAccess={() => undefined}
        snapshot={planningSnapshotFixture}
      />,
    )

    expect(html).toContain('data-testid="planning-access-error"')
    expect(html).toContain('Project directory unavailable. Project details may be missing.')
    expect(html).toContain(labels.retry)
    expect(html).toContain('data-testid="planning-roadmap"')
  })

  test('does not fabricate Project update details from an unrelated Planning entity', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        accessErrorMessage="Project directory unavailable. Project details may be missing."
        activeView="portfolio"
        initialSelectedUpdateTarget={{
          type: 'project',
          teamId: 'missing-team',
          projectId: 'missing-project',
        }}
        labels={labels}
        snapshot={planningSnapshotFixture}
      />,
    )

    expect(html).toContain('data-testid="planning-access-error"')
    expect(html).not.toContain('data-testid="planning-update-composer"')
    expect(html).not.toContain('missing-project</h2>')
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
        onOpenMilestone={() => undefined}
        onOpenProject={() => undefined}
        onOpenWorkItem={() => undefined}
        onRolloverCycle={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-timeline"')
    expect(html).toContain('data-critical="true"')
    expect(html).toContain('data-testid="milestone-date-editor"')
    expect(html).toContain('data-testid="dependency-editor"')
    expect(html).toContain('data-testid="planning-work-item-dependencies"')
    expect(html).toContain('data-testid="work-item-dependency-panel"')
    expect(html).toContain('work-item-dependency-copy-events')
    expect(html).toContain(`id="${createPlanningDependencyAnchorId('dependency-build-beta')}"`)
    expect(html).toContain('refero')
    expect(html).toContain('milestone-beta')
    expect(html).toContain('value="start-to-finish"')
    expect(html).toContain('name="constraintKind"')
    expect(html).toContain('name="constraintDate"')
    expect(html).toContain('aria-label="Predecessor: Finalize onboarding copy"')
    expect(html).toContain('aria-label="Successor: Instrument activation events"')
    expect(html).toContain('aria-label="1 affected Projects: core-team / refero"')
    expect(html).toContain('aria-label="1 affected Milestones: milestone-beta"')
    expect(html).toContain('data-testid="cycle-rollover"')
    expect(html).toContain('data-testid="planning-create-entity"')
    expect(html).toContain(labels.dependencyLag)
    expect(html).toContain(`name="goalFramework"`)
    expect(html).toContain('value="objective"')
    expect(html).toContain('value="key-result"')
    expect(html).toContain('value="cycle-15" selected=""')
    expect(html).toContain('Build onboarding journey')
  })

  test('exposes Cycle archive, duplicate, and root move scope in Timeline', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        canManageEntity={() => true}
        initialSelectedEntityId="cycle-14"
        labels={labels}
        snapshot={planningSnapshotFixture}
        onArchiveEntity={() => undefined}
        onDuplicateEntity={() => undefined}
        onMoveEntity={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-timeline-entity-detail"')
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
    expect(html).toContain('data-testid="planning-work-item-link"')
    expect(html).toContain('data-testid="planning-entity-actions"')
    expect(html).toContain('value="cycle-14" selected=""')
    expect(html).toContain('value="milestone-beta" selected=""')
    expect(html).toContain('value="goal-activation" selected=""')
    expect(html).toContain('multiple="" name="goalIds"')
    expect(html).toContain('value="initiative-onboarding" selected=""')
  })

  test('keeps Roadmap hierarchy names and metadata readable in the mobile row layout', () => {
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        labels={labels}
        snapshot={planningSnapshotFixture}
      />,
    )
    const rowHtml = sliceElement(
      html,
      'data-testid="roadmap-entity-initiative-onboarding"',
      '</button>',
    )

    expect(rowHtml).toContain('grid-cols-[minmax(0,1fr)_minmax(72px,auto)]')
    expect(rowHtml).toContain('min-[640px]:grid-cols-[minmax(0,1fr)_100px_110px]')
    expect(rowHtml).toContain('padding-left:clamp(12px, calc(12px + 5vw), 52px)')
    expect(rowHtml).toContain('whitespace-nowrap')
    expect(rowHtml).toContain('Onboarding acceleration')
    expect(rowHtml).toContain(labels.workItemCount(3))
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

    const goalRowHtml = sliceElement(
      html,
      'data-testid="roadmap-entity-goal-activation"',
      '</button>',
    )
    expect(goalRowHtml).toContain('Goal / OKR')
    expect(goalRowHtml).toContain(labels.workItemCount(1))
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

  test('shows structured immutable update history with evidence and comparison fields', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
      />,
    )

    expect(html).toContain('data-testid="planning-status-update-history"')
    expect(html).toContain('Research is complete; implementation risk remains.')
    expect(html).toContain('lead@example.com')
    expect(html).toContain('2026')
    expect(html).toContain(labels.healthValues['at-risk'])
    expect(html).toContain('Research findings')
    expect(html).toContain('journey-events')
    expect(html).toContain('/teams/core-team/issues?issueId=journey-events')
    expect(html).toContain('https://example.com/files/research-findings.pdf')
    expect(html).toContain(labels.comparePrevious)
    expect(html).toContain(labels.changeLabels.progress)
    expect(html).toContain(labels.changeLabels['target-date'])
    expect(html).toContain(`href="${createPlanningDependencyPath('dependency-build-beta')}"`)
  })

  test('links added Milestone comparisons to the canonical Timeline entity', () => {
    const updateSummary = planningSnapshotFixture.updateTargets.find(
      (candidate) => candidate.target.type === 'initiative',
    )
    if (!updateSummary) throw new Error('Planning update fixture is incomplete.')
    const [latestUpdate, ...olderUpdates] = planningUpdateHistoryFixture
    if (!latestUpdate) throw new Error('Planning history fixture is incomplete.')
    const view = createPlanningTargetUpdateView(updateSummary, [{
      ...latestUpdate,
      changes: [
        ...latestUpdate.changes,
        {
          type: 'milestones' as const,
          addedIds: ['milestone-beta'],
          changedIds: [],
          removedIds: [],
        },
      ],
    }, ...olderUpdates])

    expect(view.updates[0]?.changes.find(({ field }) => field === 'milestones')?.url).toBe(
      '/planning/timeline?entityId=milestone-beta',
    )
  })

  test('offers cursor-backed immutable history pagination with a loading state', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const availableHtml = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        hasMoreUpdateHistory
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
        onLoadMoreUpdateHistory={() => undefined}
      />,
    )
    const loadingHtml = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        hasMoreUpdateHistory
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        isLoadingMoreUpdateHistory
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
        onLoadMoreUpdateHistory={() => undefined}
      />,
    )

    expect(availableHtml).toContain(labels.loadMoreHistory)
    expect(loadingHtml).toContain(labels.loadingMoreHistory)
    expect(sliceElement(
      loadingHtml,
      labels.loadingMoreHistory,
      '</button>',
    )).toContain('disabled=""')
  })

  test('keeps Project health and update freshness independent in the detail pane', () => {
    const projectDetail = createProjectUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="phase-build"
        initialSelectedUpdateTarget={projectDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[projectDetail]}
      />,
    )
    const detailHtml = sliceElement(html, 'data-testid="planning-update-detail-pane"', '</aside>')

    expect(detailHtml).toContain(labels.healthValues['on-track'])
    expect(detailHtml).toContain(labels.freshnessValues.overdue)
    expect(detailHtml).toContain('data-testid="planning-update-freshness"')
    expect(detailHtml).toContain('builder@example.com')
    expect(detailHtml).toContain(labels.nextDueAt)
  })

  test('renders latest update and next due metadata in Timeline and Portfolio lists', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const projectDetail = createProjectUpdateDetail()
    const timelineHtml = renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[projectDetail]}
      />,
    )
    const portfolioHtml = renderToStaticMarkup(
      <PlanningScreen
        activeView="portfolio"
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
      />,
    )

    expect(timelineHtml).toContain(labels.updateState)
    expect(timelineHtml).toContain(labels.latestUpdate)
    expect(timelineHtml).toContain('builder@example.com')
    expect(timelineHtml).toContain(labels.freshnessValues.overdue)
    expect(timelineHtml).toContain('data-testid="timeline-update-summary-phase-build"')
    expect(portfolioHtml).toContain('lead@example.com')
    expect(portfolioHtml).toContain(labels.freshnessValues.current)
    expect(portfolioHtml).toContain('data-testid="portfolio-update-summary-initiative-onboarding"')
    expect(timelineHtml).toContain('min-[761px]:min-w-[1180px]')
    expect(portfolioHtml).toContain('min-[761px]:min-w-[1320px]')
  })

  test('renders cadence controls and the complete structured manual composer', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
        onPublishUpdate={() => undefined}
        onSaveUpdateCadence={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="planning-update-cadence"')
    expect(html).toContain('name="updateOwnerMemberKey"')
    expect(html).toContain('name="cadenceCount"')
    expect(html).toContain('name="timeZone"')
    expect(html).toContain('name="nextDueAt"')
    expect(html).toContain('data-testid="planning-update-composer"')
    expect(html).toContain('name="summary"')
    expect(html).toContain('name="riskSummary"')
    expect(html).toContain('name="decisionSummary"')
    expect(html).toContain('name="helpNeeded"')
    expect(html).toContain('name="nextAction"')
    expect(html).toContain('name="evidenceType"')
    expect(html).toContain('value="work-item"')
    expect(html).toContain('value="planning-entity"')
    expect(html).toContain('value="file"')
    expect(html).toContain('value="link"')
  })

  test('makes cadence and publishing controls explicitly read-only without permissions', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[initiativeDetail]}
      />,
    )
    const cadenceHtml = sliceElement(
      html,
      'data-testid="planning-update-cadence"',
      '</section>',
    )
    const composerHtml = sliceElement(
      html,
      'data-testid="planning-update-composer"',
      '</section>',
    )

    expect(cadenceHtml).toContain(labels.cadenceDisabled)
    expect(cadenceHtml).toContain('disabled=""')
    expect(composerHtml).toContain('disabled=""')
    expect(composerHtml).toContain(labels.publishUpdate)
  })

  test('keeps the composer disabled until an update cadence is configured', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const notConfiguredDetail = {
      ...initiativeDetail,
      updateView: {
        freshness: 'not-configured',
        target: initiativeDetail.updateView.target,
        updates: initiativeDetail.updateView.updates,
      },
    } satisfies PlanningUpdateTargetDetailView
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        canPublishUpdate={() => false}
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={notConfiguredDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateTargetDetails={[notConfiguredDetail]}
        onPublishUpdate={() => undefined}
      />,
    )
    const composerHtml = sliceElement(
      html,
      'data-testid="planning-update-composer"',
      '</section>',
    )

    expect(html).toContain(labels.freshnessValues['not-configured'])
    expect(composerHtml).toContain('disabled=""')
    expect(composerHtml).toContain(labels.publishUpdate)
  })

  test('exposes production-ready watch, export, comment, and reaction controls', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateCollaboration={{
          commentsByUpdateId: {
            'update-initiative-2': [{
              authorMemberKey: 'reviewer@example.com',
              bodyMarkdown: 'Please confirm the analytics review date.',
              createdAt: '2026-07-15T10:00:00.000Z',
              id: 'comment-1',
              updateId: 'update-initiative-2',
            }],
          },
          isLoading: false,
          isPending: false,
          onAddComment: () => undefined,
          onExport: () => undefined,
          onToggleReaction: () => undefined,
          onToggleWatch: () => undefined,
          reactionsByUpdateId: {
            'update-initiative-2': [{ count: 2, reaction: '👍' }],
          },
          watch: { subscribed: true, watcherCount: 4 },
        }}
        updateTargetDetails={[initiativeDetail]}
      />,
    )

    expect(html).toContain(labels.watchingUpdates)
    expect(html).toContain(labels.exportHistory)
    expect(html).toContain('Please confirm the analytics review date.')
    expect(html).toContain('name="comment"')
    expect(html).toContain(`${labels.reaction}: 👍`)
    expect(html).toContain('👍 2')
  })

  test('keeps history collaboration readable while hiding member-only annotation actions', () => {
    const initiativeDetail = createInitiativeUpdateDetail()
    const html = renderToStaticMarkup(
      <PlanningScreen
        activeView="roadmap"
        initialSelectedEntityId="initiative-onboarding"
        initialSelectedUpdateTarget={initiativeDetail.summary.target}
        labels={labels}
        snapshot={planningSnapshotFixture}
        updateCollaboration={{
          commentsByUpdateId: {
            'update-initiative-2': [{
              authorMemberKey: 'reviewer@example.com',
              bodyMarkdown: 'Viewer-readable review note.',
              createdAt: '2026-07-15T10:00:00.000Z',
              id: 'comment-read-only',
              updateId: 'update-initiative-2',
            }],
          },
          isLoading: false,
          isPending: false,
          onExport: () => undefined,
          onToggleWatch: () => undefined,
          reactionsByUpdateId: {
            'update-initiative-2': [{ count: 1, reaction: '👍' }],
          },
          watch: { subscribed: false, watcherCount: 3 },
        }}
        updateTargetDetails={[initiativeDetail]}
      />,
    )

    expect(html).toContain('Viewer-readable review note.')
    expect(html).toContain(labels.exportHistory)
    expect(html).toContain(labels.watchUpdates)
    expect(html).not.toContain('name="comment"')
    expect(html).not.toContain(`aria-label="${labels.reaction}"`)
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
