import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkItemSchedule, WorkItemScheduleChangePreview } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskSchedulePreviewMetadata } from './TaskSchedulePreviewMetadata'

const t = createTranslator('ja')

const beforeSchedule = createPreviewSchedule('2026-06-03')
const afterSchedule = createPreviewSchedule('2026-06-05')

const basePreview = {
  affectedMilestoneIds: ['milestone-beta'],
  affectedProjectIds: ['refero', 'brand-refresh'],
  affectedProjects: [
    { projectId: 'refero', teamId: 'core-team' },
    { projectId: 'brand-refresh', teamId: 'design-team' },
  ],
  conflicts: [],
  evaluatedRevisions: [
    { expectedRevision: 4, teamId: 'core-team', workItemId: 'wireframe' },
    { expectedRevision: 7, teamId: 'design-team', workItemId: 'brand-guideline' },
  ],
  expectedRevision: 4,
  impacts: [
    {
      after: afterSchedule,
      before: beforeSchedule,
      dateDeltaDays: 2,
      expectedRevision: 4,
      kind: 'direct',
      teamId: 'core-team',
      workItemId: 'wireframe',
    },
    {
      after: createPreviewSchedule('2026-06-06'),
      before: createPreviewSchedule('2026-06-05'),
      dateDeltaDays: 1,
      dependencyId: 'dependency-wireframe-brand',
      expectedRevision: 7,
      kind: 'dependency',
      teamId: 'design-team',
      workItemId: 'brand-guideline',
    },
  ],
  planningRevision: 12,
  relationGraphRevision: 8,
  requiresConfirmation: true,
  warnings: [],
} satisfies WorkItemScheduleChangePreview

/** Storybook metadata for dependency-aware schedule preview details. */
const meta = {
  title: 'Application/Projects/Task Views/Schedule Preview Metadata',
  component: TaskSchedulePreviewMetadata,
  args: {
    preview: basePreview,
    t,
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <section className="workbench-panel mx-auto max-w-2xl p-5">
          <Story />
        </section>
      </main>
    ),
  ],
} satisfies Meta<typeof TaskSchedulePreviewMetadata>

export default meta

/** Story type for the dependency-aware preview metadata. */
type Story = StoryObj<typeof meta>

/** Direct and dependency-propagated date movement. */
export const NormalImpact: Story = {}

/** Team-qualified affected Project and Milestone scopes. */
export const AffectedScopes: Story = {
  args: {
    preview: {
      ...basePreview,
      impacts: basePreview.impacts.slice(0, 1),
    },
  },
}

/** Blocking dependency conflict with required and current dates. */
export const Conflict: Story = {
  args: {
    preview: {
      ...basePreview,
      conflicts: [{
        actualDate: '2026-06-05',
        code: 'constraint-violation',
        dependencyId: 'dependency-wireframe-brand',
        requiredDate: '2026-06-04',
        workItem: { teamId: 'design-team', workItemId: 'brand-guideline' },
      }],
    },
  },
}

/** Creates one canonical due-date schedule for preview-only stories. */
function createPreviewSchedule(dueDate: string): WorkItemSchedule {
  return {
    calendarPolicy: {
      holidays: [],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dueDate,
    mode: 'due-date',
  }
}
