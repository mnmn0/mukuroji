import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
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

/** Work Items and a Milestone behind the baseline, attachable as evidence in one action. */
export const BaselineDelays: Story = {
  args: {
    baselineDelays: {
      status: 'ready',
      candidates: [
        {
          key: 'milestone-beta',
          kind: 'milestone',
          title: 'Beta ready',
          delayDays: 7,
          reportedBefore: true,
          evidence: { type: 'planning-entity', entityId: 'milestone-beta' },
        },
        {
          key: 'journey-copy',
          kind: 'work-item',
          title: 'Finalize onboarding copy',
          delayDays: 5,
          reportedBefore: false,
          evidence: { type: 'work-item', teamId: 'core-team', workItemId: 'journey-copy' },
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '遅れ 2 件を根拠に添付' }))
    await expect(canvas.getByRole('status')).toHaveTextContent('2 件を根拠に添付しています。')
    await userEvent.click(canvas.getByRole('button', { name: '添付を外す' }))
    await expect(canvas.getByRole('button', { name: '遅れ 2 件を根拠に添付' })).toBeEnabled()
  },
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
