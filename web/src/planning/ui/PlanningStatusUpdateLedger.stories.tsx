import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import {
  planningSnapshotFixture,
  planningUpdateHistoryFixture,
} from '../fixtures'
import {
  createPlanningTargetUpdateView,
  type PlanningUpdateCollaborationController,
} from '../model/statusUpdateView'
import {
  PlanningStatusUpdateLedger,
  type PlanningStatusUpdateLedgerProps,
} from './PlanningUpdatePrimitives'
import { createPlanningLabels } from './labels'

/** Japanese labels shared by the stories and their play assertions. */
const storyLabels = createPlanningLabels('ja')

const onboardingSummary = planningSnapshotFixture.updateTargets.find((summary) =>
  summary.target.type === 'initiative' &&
  summary.target.entityId === 'initiative-onboarding'
) ?? planningSnapshotFixture.updateTargets[0]

/**
 * Builds a read-only collaboration controller with the given reviewer confirmation states.
 *
 * @param acknowledgementsByUpdateId - Reviewer confirmation state keyed by update ID.
 * @returns Collaboration controller without mutation callbacks.
 */
function createCollaboration(
  acknowledgementsByUpdateId?: PlanningUpdateCollaborationController['acknowledgementsByUpdateId'],
): PlanningUpdateCollaborationController {
  return {
    ...(acknowledgementsByUpdateId ? { acknowledgementsByUpdateId } : {}),
    commentsByUpdateId: {},
    isLoading: false,
    isPending: false,
    reactionsByUpdateId: {},
  }
}

/** Storybook metadata for the immutable Planning update history ledger. */
const meta = {
  title: 'Application/Planning/StatusUpdateLedger',
  component: PlanningStatusUpdateLedger,
  parameters: { layout: 'centered' },
  args: {
    labels: storyLabels,
    updateView: createPlanningTargetUpdateView(onboardingSummary, planningUpdateHistoryFixture),
  },
  decorators: [(Story) => (
    <div className="w-[min(920px,calc(100vw-2rem))]">
      <Story />
    </div>
  )],
} satisfies Meta<typeof PlanningStatusUpdateLedger>

export default meta

/** Story type for ledger reviewer confirmation states. */
type Story = StoryObj<typeof meta>

/** Latest update awaits the reviewer while the previous one is already reviewed. */
export const ReviewedAndAwaitingReview: Story = {
  args: {
    collaboration: createCollaboration({
      'update-initiative-1': {
        acknowledgedAt: '2026-07-09T00:00:00.000Z',
        reviewerMemberKey: 'manager@example.com',
      },
      'update-initiative-2': { reviewerMemberKey: 'manager@example.com' },
    }),
  },
}

/** Every visible update has been reviewed by the escalation reviewer. */
export const AllReviewed: Story = {
  args: {
    collaboration: createCollaboration({
      'update-initiative-1': {
        acknowledgedAt: '2026-07-09T00:00:00.000Z',
        reviewerMemberKey: 'manager@example.com',
      },
      'update-initiative-2': {
        acknowledgedAt: '2026-07-16T00:00:00.000Z',
        reviewerMemberKey: 'manager@example.com',
      },
    }),
  },
}

/** No escalation reviewer is configured, so no confirmation badge is shown. */
export const ReviewerNotConfigured: Story = {
  args: {
    collaboration: createCollaboration(),
  },
}

/** Reviewer who acknowledges in the interactive stories. */
const storyReviewerMemberKey = 'manager@example.com'

/**
 * Renders the ledger as the cadence reviewer, recording acknowledgements and remarks in story state.
 *
 * @param props - Ledger props; the collaboration controller is replaced by the stateful one.
 * @returns The ledger with working comment and acknowledgement callbacks.
 */
function ReviewerLedger(props: PlanningStatusUpdateLedgerProps & { pending?: boolean }) {
  const { pending = false, ...ledgerProps } = props
  const [acknowledgements, setAcknowledgements] = useState<
    NonNullable<PlanningUpdateCollaborationController['acknowledgementsByUpdateId']>
  >({
    'update-initiative-1': {
      acknowledgedAt: '2026-07-09T00:00:00.000Z',
      reviewerMemberKey: storyReviewerMemberKey,
    },
    'update-initiative-2': { reviewerMemberKey: storyReviewerMemberKey },
  })
  const [comments, setComments] = useState<PlanningUpdateCollaborationController['commentsByUpdateId']>({})
  /** Appends one comment from the reviewer to story state. */
  const addComment = (updateId: string, bodyMarkdown: string) => {
    setComments((current) => ({
      ...current,
      [updateId]: [...(current[updateId] ?? []), {
        id: `story-comment-${updateId}-${(current[updateId] ?? []).length + 1}`,
        updateId,
        authorMemberKey: storyReviewerMemberKey,
        bodyMarkdown,
        createdAt: '2026-07-17T00:00:00.000Z',
      }],
    }))
  }
  return (
    <PlanningStatusUpdateLedger
      {...ledgerProps}
      collaboration={{
        acknowledgementsByUpdateId: acknowledgements,
        commentsByUpdateId: comments,
        isLoading: false,
        isPending: pending,
        reactionsByUpdateId: {},
        onAddComment: addComment,
        onAcknowledge: (updateId, bodyMarkdown) => {
          addComment(updateId, bodyMarkdown ?? '確認しました。')
          setAcknowledgements((current) => ({
            ...current,
            [updateId]: {
              acknowledgedAt: '2026-07-17T00:00:00.000Z',
              reviewerMemberKey: storyReviewerMemberKey,
            },
          }))
        },
      }}
    />
  )
}

/** The reviewer writes a remark and records 確認済み; the remark becomes the acknowledgement comment. */
export const ReviewerAcknowledgesWithRemark: Story = {
  render: (args) => <ReviewerLedger {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const acknowledge = canvas.getByTestId('planning-update-acknowledge')
    const form = acknowledge.closest('form')
    if (!form) throw new Error('The acknowledgement button must sit in the comment form.')
    await userEvent.type(within(form).getByRole('textbox'), 'リスク対応の方針で進めてください。')
    await userEvent.click(acknowledge)
    await expect(await canvas.findByText('リスク対応の方針で進めてください。')).toBeVisible()
    await expect(canvas.queryByTestId('planning-update-acknowledge')).toBeNull()
  },
}

/** While an acknowledgement is being saved, the remark box and both actions are disabled. */
export const AcknowledgementPending: Story = {
  render: (args) => <ReviewerLedger {...args} pending />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('planning-update-acknowledge')).toBeDisabled()
  },
}
