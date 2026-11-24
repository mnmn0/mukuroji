import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createPlanningUpdateWorkItemEvidenceValue } from '../model/statusUpdateView'
import { evidenceKey } from '../model/baselineDelayEvidence'
import { PlanningStatusUpdateComposer } from './PlanningUpdatePrimitives'
import { createPlanningLabels } from './labels'
import { aiPlanningGenerationFixture } from '../../features/ai-assistance/fixtures'

/** Japanese labels shared by the stories and their play assertions. */
const storyLabels = createPlanningLabels('ja')

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
    labels: storyLabels,
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
          key: evidenceKey({ type: 'planning-entity', entityId: 'milestone-beta' }),
          kind: 'milestone',
          title: 'Beta ready',
          delayDays: 7,
          reportedBefore: true,
          evidence: { type: 'planning-entity', entityId: 'milestone-beta' },
        },
        {
          key: evidenceKey({ type: 'work-item', teamId: 'core-team', workItemId: 'journey-copy' }),
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

/** Workspace template text and required fields; publishing an empty required field is refused. */
export const WorkspaceRequiredFields: Story = {
  args: {
    template: {
      requiredFields: ['riskSummary', 'nextAction'],
      template: {
        summary: '今週の完了事項:\n来週の予定:',
        nextAction: '担当と期日を書く',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText(/^リスク.*（必須）/)).toBeRequired()
    await userEvent.click(canvas.getByRole('button', { name: storyLabels.publishUpdate }))
    await expect(await canvas.findByText(/この Workspace では次の項目が必須です/)).toBeVisible()
  },
}

/** The composer waits while the Workspace settings load, so a late template never replaces typed text. */
export const WorkspaceTemplateLoading: Story = {
  args: { templateLoadState: { status: 'loading' } },
}

/** The Workspace settings failed to load; the form stays usable and offers a retry. */
export const WorkspaceTemplateLoadFailed: Story = {
  args: { templateLoadState: { status: 'error', onRetry: () => undefined } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: storyLabels.retryHistory })).toBeEnabled()
  },
}
