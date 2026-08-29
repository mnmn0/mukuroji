import type { Meta, StoryObj } from '@storybook/react-vite'
import { createPlanningUpdateWorkItemEvidenceValue } from '../model/statusUpdateView'
import { PlanningStatusUpdateComposer } from './PlanningUpdatePrimitives'
import { createPlanningLabels } from './labels'
import { aiPlanningGenerationFixture } from '../../features/ai-assistance/fixtures'

const evidenceCandidates = {
  planningEntities: [{
    entityId: 'milestone-beta',
    label: 'Beta ready · milestone-beta',
    value: 'milestone-beta',
  }],
  workItems: [{
    label: 'Finalize onboarding copy · journey-copy',
    teamId: 'core-team',
    value: createPlanningUpdateWorkItemEvidenceValue('core-team', 'journey-copy'),
    workItemId: 'journey-copy',
  }],
}

/** Storybook metadata for the focused structured Planning update composer. */
const meta = {
  title: 'Application/Planning/StatusUpdateComposer',
  component: PlanningStatusUpdateComposer,
  parameters: { layout: 'centered' },
  args: {
    evidenceCandidates,
    health: 'at-risk',
    labels: createPlanningLabels('ja'),
    onPublish: async () => undefined,
    progress: 58,
  },
  decorators: [(Story) => (
    <div className="w-[min(920px,calc(100vw-2rem))]">
      <Story />
    </div>
  )],
} satisfies Meta<typeof PlanningStatusUpdateComposer>

export default meta

/** Story type for focused structured composer states. */
type Story = StoryObj<typeof meta>

/** Canonical Work Item evidence selection. */
export const WorkItemEvidence: Story = {
  args: { initialEvidenceType: 'work-item' },
}

/** Canonical Planning entity evidence selection. */
export const PlanningEntityEvidence: Story = {
  args: { initialEvidenceType: 'planning-entity' },
}

/** File evidence with a required immutable HTTPS permalink. */
export const FileEvidence: Story = {
  args: { initialEvidenceType: 'file' },
}

/** Generic external evidence link and optional label. */
export const LinkEvidence: Story = {
  args: { initialEvidenceType: 'link' },
}

/** Existing form prefilled from an approved AI status update without publishing it. */
export const AiDraftPrefill: Story = {
  args: {
    initialDraft: aiPlanningGenerationFixture.content.availability === 'available' &&
      aiPlanningGenerationFixture.content.draft.kind === 'planning'
      ? aiPlanningGenerationFixture.content.draft.statusUpdate
      : undefined,
  },
}

/** Explicit Planning generation entry point before any provider request is made. */
export const AiGenerationIdle: Story = {
  args: {
    aiAssistance: {
      accessToken: 'storybook-access-token',
      locale: 'en',
      source: {
        expectedRevision: 12,
        target: { projectId: 'launch-readiness', teamId: 'core-team', type: 'project' },
        type: 'planning-target',
      },
    },
  },
}
