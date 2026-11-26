import type { AiPlanningDraft, WorkItemDependencyEndpoint } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiPlanningGenerationFixture } from '../fixtures'
import { AiPlanningStructureAdoption } from './AiPlanningStructureAdoption'

const planningContent = aiPlanningGenerationFixture.content

/** Planning draft of the fixture generation; the fixture is always available. */
const planningDraft: AiPlanningDraft = planningContent.availability === 'available' &&
  planningContent.draft.kind === 'planning'
  ? planningContent.draft
  : { kind: 'planning', subtasks: [], dependencies: [] }

/** Resolves fixture dependency endpoints to visible labels. */
function resolvePlanningEndpoint(endpoint: WorkItemDependencyEndpoint): string {
  if (endpoint.workItemId === 'accessibility-review') return 'Accessibility review'
  if (endpoint.workItemId === 'staged-launch') return 'Staged launch'
  return endpoint.workItemId
}

/** Storybook metadata for choosing and creating proposed children and dependencies. */
const meta = {
  title: 'Application/AI Assistance/Planning Structure Adoption',
  component: AiPlanningStructureAdoption,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <section className="workbench-toolbar mx-auto max-w-5xl p-5 max-[480px]:p-4">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    adopt: async (input) => ({
      childWorkItemIds: Object.fromEntries(input.children.map((child, index) => [child.rowId, `child-${index + 1}`])),
      dependencyRowIds: input.dependencies.map((dependency) => dependency.rowId),
    }),
    approve: async () => true,
    childTypes: [{ id: 'task', name: 'Task' }, { id: 'deliverable', name: 'Deliverable' }],
    draft: planningDraft,
    generationId: aiPlanningGenerationFixture.id,
    isPending: false,
    resolveWorkItemLabel: resolvePlanningEndpoint,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiPlanningStructureAdoption>

export default meta

type Story = StoryObj<typeof meta>

/** English selection of proposed rows. */
export const English: Story = {}

/** Japanese selection of proposed rows. */
export const Japanese: Story = {
  args: { t: createTranslator('ja') },
}

/** A parent type that allows no children keeps only the dependencies creatable. */
export const NoChildType: Story = {
  args: { childTypes: [] },
}

/** Creation in flight disables every control. */
export const Pending: Story = {
  args: { isPending: true },
}
