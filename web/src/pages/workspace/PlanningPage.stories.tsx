import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  emptyPlanningSnapshotFixture,
  planningSnapshotFixture,
  planningUpdateHistoryFixture,
} from '../../planning/fixtures'
import {
  createPlanningTargetUpdateView,
  type PlanningUpdateTargetDetailView,
} from '../../planning/model/statusUpdateView'
import { PlanningScreen } from '../../planning/ui/PlanningScreen'
import { createPlanningLabels } from '../../planning/ui/labels'

const initiativeUpdateDetails = createInitiativeUpdateDetails()
const projectUpdateDetails = createProjectUpdateDetails()

/** Creates the Initiative detail projection shared by update stories. */
function createInitiativeUpdateDetails(): PlanningUpdateTargetDetailView[] {
  const updateSummary = planningSnapshotFixture.updateTargets.find((candidate) =>
    candidate.target.type === 'initiative' &&
    candidate.target.entityId === 'initiative-onboarding'
  )
  if (!updateSummary) return []
  return [{
    summary: {
      context: 'Core team',
      health: 'at-risk',
      ownerMemberKey: 'lead@example.com',
      progress: 58,
      target: updateSummary.target,
      title: 'Onboarding acceleration',
    },
    updateView: createPlanningTargetUpdateView(
      updateSummary,
      planningUpdateHistoryFixture,
    ),
  }]
}

/** Creates the Team-qualified Project detail projection shared by update stories. */
function createProjectUpdateDetails(): PlanningUpdateTargetDetailView[] {
  const updateSummary = planningSnapshotFixture.updateTargets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === 'core-team' &&
    candidate.target.projectId === 'refero'
  )
  if (!updateSummary) return []
  return [{
    summary: {
      context: 'Core team',
      health: updateSummary.latestUpdate?.health ?? 'unknown',
      ownerMemberKey: updateSummary.cadence?.updateOwnerMemberKey ?? '',
      progress: updateSummary.latestUpdate?.progressSnapshot.percent ?? 0,
      target: updateSummary.target,
      title: 'Refero',
    },
    updateView: createPlanningTargetUpdateView(updateSummary),
  }]
}

/**
 * PlanningScreen の Storybook meta です。
 */
const meta = {
  title: 'Application/Pages/PlanningPage',
  component: PlanningScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    activeView: 'timeline',
    canCreateInScope: () => true,
    createScopeTeams: [{
      id: 'core-team',
      name: 'Core team',
      projects: [{ id: 'refero', name: 'Refero' }],
    }],
    labels: createPlanningLabels('ja'),
    snapshot: planningSnapshotFixture,
    onArchiveEntity: async () => undefined,
    onPublishUpdate: async () => undefined,
    onSaveUpdateCadence: async () => undefined,
    onChangeMilestoneDate: async () => undefined,
    onCreateDependency: async () => undefined,
    onCreateEntity: async () => undefined,
    onDeleteDependency: async () => undefined,
    onDeleteWorkItemLink: async () => undefined,
    onDuplicateEntity: async () => undefined,
    onMoveEntity: async () => undefined,
    onOpenWorkItem: () => undefined,
    onRetry: () => undefined,
    onRolloverCycle: async () => undefined,
    onSaveWorkItemLink: async () => undefined,
    onViewChange: () => undefined,
    updateTargetDetails: [...initiativeUpdateDetails, ...projectUpdateDetails],
  },
} satisfies Meta<typeof PlanningScreen>

export default meta

/**
 * PlanningScreen stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Milestone、dependency、cycle rollover を操作できる Timeline です。
 */
export const Timeline: Story = {}

/**
 * Create form for a Cycle in a Workspace whose week starts on Sunday, after a later reload of the
 * week start failed: the proposed dates start on a Sunday and a notice offers to read it again.
 */
export const CycleWeekStartFromWorkspace: Story = {
  args: {
    onRetryWeekStart: () => undefined,
    weekStartDay: 0,
    weekStartErrorMessage: 'Workspace の週の開始曜日を読み直せませんでした。新しい Cycle の日付は前回読み込んだ設定で提案しています。',
  },
  play: async ({ canvasElement }) => {
    const form = within(canvasElement.querySelector<HTMLElement>('[data-testid="planning-create-entity"]') ?? canvasElement)
    await userEvent.selectOptions(form.getByRole('combobox', { name: /種別/u }), 'cycle')
    await expect(form.getByTestId('planning-cycle-week-start-error')).toBeVisible()
    const startDate = canvasElement.querySelector<HTMLInputElement>('[data-testid="planning-create-entity"] input[name="startDate"]')
    await expect(new Date(`${startDate?.value ?? ''}T00:00:00.000Z`).getUTCDay()).toBe(0)
  },
}

/**
 * 作成フォームの下にアーカイブ済みの計画と復元結果を表示した Roadmap です。
 */
export const ArchivedPlans: Story = {
  args: {
    activeView: 'roadmap',
    archive: {
      entities: [{
        id: 'cycle-2026-08',
        type: 'cycle',
        title: '2026 年 8 月 Cycle',
        teamId: 'core-team',
        ownerMemberKey: 'lead@example.com',
        archivedAt: '2026-09-01T00:00:00.000Z',
      }],
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
      results: [{
        entityId: 'goal-retention',
        title: '継続率の改善',
        summary: {
          restoredLinkCount: 30,
          droppedLinkCount: 2,
          restoredDependencyCount: 1,
          retainedDependencyCount: 0,
          droppedDependencyCount: 0,
          pendingReferenceCount: 12,
        },
      }],
      onLoadMore: () => undefined,
      onOpen: () => undefined,
      onRestore: async () => undefined,
      onRetry: () => undefined,
    },
  },
}

/**
 * Goal から Work Item を辿れる Roadmap です。
 */
export const Roadmap: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'goal-activation',
  },
}

/**
 * 上位計画の roll-up を比較する Portfolio です。
 */
export const Portfolio: Story = {
  args: {
    activeView: 'portfolio',
  },
}

/** Initiative detail with the structured composer and immutable comparison ledger. */
export const InitiativeUpdateLedger: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Initiative ledger with watcher state, append-only comments, and member reactions. */
export const InitiativeUpdateCollaboration: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    updateCollaboration: {
      commentsByUpdateId: {
        'update-initiative-2': [{
          authorMemberKey: 'reviewer@example.com',
          bodyMarkdown: '分析レビュー日を確認してください。',
          createdAt: '2026-07-15T10:00:00.000Z',
          id: 'comment-1',
          updateId: 'update-initiative-2',
        }],
      },
      isLoading: false,
      isPending: false,
      onAddComment: async () => undefined,
      onExport: async () => undefined,
      onToggleReaction: async () => undefined,
      onToggleWatch: async () => undefined,
      reactionsByUpdateId: {
        'update-initiative-2': [{
          count: 3,
          reactedByViewer: true,
          reaction: '👍',
        }],
      },
      watch: { subscribed: true, watcherCount: 5 },
    },
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Project health stays on track while its operational update state is overdue. */
export const ProjectOverdueWithKnownHealth: Story = {
  args: {
    activeView: 'portfolio',
    initialSelectedUpdateTarget: {
      type: 'project',
      teamId: 'core-team',
      projectId: 'refero',
    },
    updateTargetDetails: projectUpdateDetails,
  },
}

/** Never-updated Project keeps unknown health separate from its missing delivery state. */
export const ProjectMissingAndUnknown: Story = {
  args: {
    activeView: 'portfolio',
    initialSelectedUpdateTarget: {
      type: 'project',
      teamId: 'core-team',
      projectId: 'refero',
    },
    updateTargetDetails: projectUpdateDetails.map((detail) => ({
      summary: { ...detail.summary, health: 'unknown', progress: 0 },
      updateView: {
        ...detail.updateView,
        freshness: 'missing',
        updates: [],
      },
    })),
  },
}

/** Mobile detail pane stacks schedule, composer, and ledger below the primary view. */
export const MobileInitiativeUpdate: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    updateTargetDetails: initiativeUpdateDetails,
  },
  globals: {
    viewport: {
      value: 'mobile1',
      isRotated: false,
    },
  },
}

/**
 * Planning entity がまだない empty state です。
 */
export const Empty: Story = {
  args: {
    snapshot: emptyPlanningSnapshotFixture,
  },
}

/**
 * Planning snapshot の初回 loading state です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    snapshot: undefined,
  },
}

/**
 * Planning mutation の競合を表示する state です。
 */
export const Conflict: Story = {
  args: {
    errorMessage: '他のユーザーが計画を更新しました。再読み込みしてください。',
  },
}

/**
 * Entity mutation 権限がない Roadmap です。
 */
export const ReadOnly: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    onArchiveEntity: undefined,
    onCreateEntity: undefined,
    onDeleteDependency: undefined,
    onDeleteWorkItemLink: undefined,
    onDuplicateEntity: undefined,
    onMoveEntity: undefined,
    onPublishUpdate: undefined,
    onSaveUpdateCadence: undefined,
    onSaveWorkItemLink: undefined,
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Selected update detail while its full immutable history is loading. */
export const UpdateHistoryLoading: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    isUpdateHistoryLoading: true,
    updateTargetDetails: initiativeUpdateDetails.map((detail) => ({
      ...detail,
      updateView: { ...detail.updateView, updates: [] },
    })),
  },
}

/** Selected update detail with another cursor-paginated history page available. */
export const UpdateHistoryHasMore: Story = {
  args: {
    activeView: 'roadmap',
    hasMoreUpdateHistory: true,
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    onLoadMoreUpdateHistory: async () => undefined,
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Selected update detail with a recoverable history-query failure. */
export const UpdateHistoryError: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    onRetryUpdateHistory: () => undefined,
    updateHistoryErrorMessage: '更新履歴を取得できませんでした。',
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Selected update detail while watcher and annotation projections are loading. */
export const UpdateCollaborationLoading: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    updateCollaboration: {
      commentsByUpdateId: {},
      isLoading: true,
      isPending: false,
      onExport: async () => undefined,
      reactionsByUpdateId: {},
    },
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/** Selected update detail with recoverable watcher and annotation failure. */
export const UpdateCollaborationError: Story = {
  args: {
    activeView: 'roadmap',
    initialSelectedEntityId: 'initiative-onboarding',
    initialSelectedUpdateTarget: {
      type: 'initiative',
      entityId: 'initiative-onboarding',
    },
    updateCollaboration: {
      commentsByUpdateId: {},
      errorMessage: 'コメントとリアクションを取得できませんでした。',
      isLoading: false,
      isPending: false,
      onExport: async () => undefined,
      onRetry: () => undefined,
      reactionsByUpdateId: {},
    },
    updateTargetDetails: initiativeUpdateDetails,
  },
}

/**
 * English locale の Planning workbench です。
 */
export const English: Story = {
  args: {
    labels: createPlanningLabels('en'),
  },
}
