import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanningRestoreResultView } from '../model/archive'
import { PlanningArchivePanel, type PlanningArchiveController } from './PlanningArchivePanel'
import { createPlanningLabels } from './labels'

const labels = createPlanningLabels('ja')

/** A restore that left references in the archive. */
const pendingResult: PlanningRestoreResultView = {
  entityId: 'goal-retention',
  title: '継続率の改善',
  summary: {
    restoredLinkCount: 30,
    droppedLinkCount: 2,
    restoredDependencyCount: 1,
    retainedDependencyCount: 1,
    droppedDependencyCount: 0,
    pendingReferenceCount: 12,
  },
}

/** Archived plans of both kinds with a further page to load. */
const loadedArchive: PlanningArchiveController = {
  entities: [
    {
      id: 'initiative-legacy',
      type: 'initiative',
      title: '旧オンボーディング施策',
      ownerMemberKey: 'lead@example.com',
      archivedAt: '2026-10-20T03:00:00.000Z',
    },
    {
      id: 'cycle-2026-08',
      type: 'cycle',
      title: '2026 年 8 月 Cycle',
      teamId: 'core-team',
      ownerMemberKey: 'lead@example.com',
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  hasMore: true,
  isLoading: false,
  isLoadingMore: false,
  results: [],
  onLoadMore: () => undefined,
  onOpen: () => undefined,
  onRestore: () => undefined,
  onRetry: () => undefined,
}

/** Storybook metadata for the archived plans disclosure of the Planning screen. */
const meta = {
  title: 'Application/Planning/ArchivePanel',
  component: PlanningArchivePanel,
  parameters: { layout: 'padded' },
  args: {
    archive: loadedArchive,
    defaultOpen: true,
    entityTypes: labels.entityTypes,
    labels: labels.archivedPlans,
    retry: labels.retry,
  },
} satisfies Meta<typeof PlanningArchivePanel>

export default meta

/** PlanningArchivePanel stories. */
type Story = StoryObj<typeof meta>

/** Loaded archived plans with a further page. */
export const Loaded: Story = {}

/** Closed until the caller opens it, as the Planning screen first shows it. */
export const Closed: Story = { args: { defaultOpen: false } }

/** The first page is loading. */
export const Loading: Story = { args: { archive: { ...loadedArchive, entities: [], hasMore: false, isLoading: true } } }

/** Nothing the caller can restore. */
export const Empty: Story = { args: { archive: { ...loadedArchive, entities: [], hasMore: false } } }

/** The list could not be loaded. */
export const LoadError: Story = { args: { archive: { ...loadedArchive, errorMessage: labels.archivedPlans.error } } }

/** A restore request is running. */
export const Restoring: Story = { args: { archive: { ...loadedArchive, restoringEntityId: 'cycle-2026-08' } } }

/** A restore left references in the archive and offers to restore the rest. */
export const PendingResult: Story = { args: { archive: { ...loadedArchive, results: [pendingResult] } } }

/** A finished restore next to an earlier one that still has references to restore. */
export const SeveralResults: Story = {
  args: {
    archive: {
      ...loadedArchive,
      results: [{
        entityId: 'milestone-beta-old',
        title: '旧ベータ版',
        summary: { ...pendingResult.summary, droppedLinkCount: 0, pendingReferenceCount: 0, retainedDependencyCount: 0 },
      }, pendingResult],
    },
  },
}

/** English labels. */
export const English: Story = {
  args: {
    archive: { ...loadedArchive, results: [pendingResult] },
    entityTypes: createPlanningLabels('en').entityTypes,
    labels: createPlanningLabels('en').archivedPlans,
    retry: createPlanningLabels('en').retry,
  },
}
