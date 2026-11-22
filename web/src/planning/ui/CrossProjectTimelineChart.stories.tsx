import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanningEntity } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../fixtures'
import { CrossProjectTimelineChart } from './CrossProjectTimelineChart'
import { createPlanningLabels } from './labels'

const labels = createPlanningLabels('ja')

/** Phase and Milestone pairs for ten Projects, staggered across one quarter. */
const tenProjectEntities: PlanningEntity[] = planningSnapshotFixture.entities.flatMap((entity: PlanningEntity): PlanningEntity[] => {
  if (entity.id !== 'phase-build' && entity.id !== 'milestone-beta') return [entity]
  return Array.from({ length: 10 }, (_, index) => {
    const offset = index * 6
    /** Moves one fixture date later by the Project offset. */
    const shift = (date: string) => {
      const value = new Date(`${date}T00:00:00Z`)
      value.setUTCDate(value.getUTCDate() + offset)
      return value.toISOString().slice(0, 10)
    }
    return {
      ...entity,
      id: `${entity.id}-${index + 1}`,
      title: `${entity.title} ${index + 1}`,
      projectId: `project-${index + 1}`,
      baseline: { startDate: shift(entity.baseline.startDate), endDate: shift(entity.baseline.endDate) },
      forecast: { startDate: shift(entity.forecast.startDate), endDate: shift(entity.forecast.endDate) },
    }
  })
})

const meta = {
  title: 'Application/Planning/CrossProjectTimelineChart',
  component: CrossProjectTimelineChart,
  args: {
    criticalEntityIds: new Set(planningSnapshotFixture.criticalPath.entityIds),
    dependencies: planningSnapshotFixture.dependencies,
    directory: [{
      id: 'core-team',
      name: 'Core',
      projects: [
        { id: 'refero', name: 'Refero アプリ' },
        ...Array.from({ length: 10 }, (_, index) => ({ id: `project-${index + 1}`, name: `Project ${index + 1}` })),
      ],
    }],
    entities: planningSnapshotFixture.entities,
    entityTypes: labels.entityTypes,
    labels: labels.crossProjectTimeline,
    onOpenProjectGantt: () => undefined,
    onOpenProjectOverview: () => undefined,
    onSelectEntity: () => undefined,
    today: '2026-08-20',
  },
} satisfies Meta<typeof CrossProjectTimelineChart>

export default meta

/** Story object bound to the cross-Project timeline chart metadata. */
type Story = StoryObj<typeof meta>

/** Fixture snapshot with one Project, dependencies, and baseline drift. */
export const Default: Story = {}

/** Ten Projects compared on one axis. */
export const TenProjects: Story = {
  args: { entities: tenProjectEntities },
}

/** Rows grouped by Portfolio name their Project and open its overview or Gantt chart. */
export const GroupedByPortfolio: Story = {
  args: { entities: tenProjectEntities },
  beforeEach: () => {
    window.sessionStorage.setItem('mukuroji.planning.crossProjectTimeline.grouping', 'portfolio')
    return () => window.sessionStorage.removeItem('mukuroji.planning.crossProjectTimeline.grouping')
  },
}

/** No timeline entity has dates yet. */
export const Empty: Story = {
  args: { entities: [] },
}
