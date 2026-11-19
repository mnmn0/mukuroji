import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  planningSnapshotFixture,
  planningUpdateHistoryFixture,
} from '../fixtures'
import {
  createPlanningTargetUpdateView,
  type PlanningUpdateCollaborationController,
} from '../model/statusUpdateView'
import { PlanningStatusUpdateLedger } from './PlanningUpdatePrimitives'
import { createPlanningLabels } from './labels'

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
    labels: createPlanningLabels('ja'),
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
