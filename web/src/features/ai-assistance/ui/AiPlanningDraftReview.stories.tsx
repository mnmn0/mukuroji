import type { WorkItemDependencyEndpoint } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiPlanningGenerationFixture } from '../fixtures'
import { AiPlanningDraftReview } from './AiPlanningDraftReview'

const planningContent = aiPlanningGenerationFixture.content

/** Resolves the fixture's configured workflow status to a visible label. */
function resolvePlanningStatus(statusId: string): string {
  return statusId === 'review' ? 'In review' : statusId
}

/** Resolves fixture dependency endpoints without changing the proposed identifiers. */
function resolvePlanningEndpoint(endpoint: WorkItemDependencyEndpoint): string {
  if (endpoint.workItemId === 'accessibility-review') return 'Accessibility review'
  if (endpoint.workItemId === 'staged-launch') return 'Staged launch'
  return endpoint.workItemId
}

/** Storybook metadata for the reusable unapplied planning draft review. */
const meta = {
  title: 'Application/AI Assistance/Planning Draft Review',
  component: AiPlanningDraftReview,
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
    citations: planningContent.citations,
    draft: planningContent.draft,
    locale: 'en',
    resolveStatusLabel: resolvePlanningStatus,
    resolveWorkItemLabel: resolvePlanningEndpoint,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiPlanningDraftReview>

export default meta

/** Story type for the reusable planning draft review. */
type Story = StoryObj<typeof meta>

/** Desktop review shows unapplied fields, children, dependencies, and status update. */
export const Desktop: Story = {}

/** Narrow review stacks planning definitions and wraps long evidence labels. */
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
}

/** An intentionally sparse draft states which proposal sections are empty. */
export const SparseDraft: Story = {
  args: {
    draft: {
      kind: 'planning',
      subtasks: [],
      dependencies: [],
      status: planningContent.draft.status,
    },
  },
}

/** A citation removed after generation fails closed before proposed values render. */
export const MissingEvidence: Story = {
  args: {
    citations: planningContent.citations.filter((citation) => citation.id !== 'citation-plan-1'),
  },
}
