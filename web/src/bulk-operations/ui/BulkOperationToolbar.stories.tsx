import { AUTOMATION_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { BulkOperationToolbar, type BulkOperationSelection } from './BulkOperationToolbar'

const selectedItems: BulkOperationSelection[] = [
  {
    expectedRevision: 3,
    label: 'Release checklist',
    selectionKey: 'refero:core-team:release-checklist',
    teamId: 'core-team',
    workItemId: 'release-checklist',
  },
  {
    expectedRevision: 5,
    label: 'Brand review',
    selectionKey: 'refero:design-team:brand-review',
    teamId: 'design-team',
    workItemId: 'brand-review',
  },
  {
    expectedRevision: 2,
    label: 'Publish notes',
    selectionKey: 'refero:core-team:publish-notes',
    teamId: 'core-team',
    workItemId: 'publish-notes',
  },
]

const operationTargets = selectedItems.map(({ expectedRevision, teamId, workItemId }) => ({
  expectedRevision,
  teamId,
  workItemId,
}))

const partialOperation = {
  action: { archived: true, type: 'archive' as const },
  actorMemberKey: 'member-owner',
  createdAt: '2026-07-16T02:00:00.000Z',
  id: 'bulk-partial-1',
  revision: 4,
  items: [
    {
      ...operationTargets[0],
      retryable: false,
      status: 'succeeded' as const,
      undoable: true,
    },
    {
      ...operationTargets[1],
      errorCode: 'WorkItemRevisionConflict',
      errorMessage: 'The Work Item changed after preview.',
      retryable: false,
      status: 'failed' as const,
      undoable: false,
    },
    {
      ...operationTargets[2],
      errorCode: 'DynamoDbThrottled',
      errorMessage: 'The item can be retried safely.',
      retryable: true,
      status: 'failed' as const,
      undoable: false,
    },
  ],
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  status: 'partial' as const,
  updatedAt: '2026-07-16T02:00:02.000Z',
  workspaceId: 'workspace-1',
}

const succeededOperation = {
  ...partialOperation,
  id: 'bulk-succeeded-1',
  items: partialOperation.items.map((item) => ({
    ...item,
    errorCode: undefined,
    errorMessage: undefined,
    retryable: false,
    status: 'succeeded' as const,
    undoable: true,
  })),
  status: 'succeeded' as const,
}

const meta = {
  title: 'Application/Projects/Bulk Operation Toolbar',
  component: BulkOperationToolbar,
  parameters: { layout: 'padded' },
  args: {
    projectOptions: [
      { id: 'refero', label: 'Refero' },
      { id: 'product-roadmap', label: 'Product Roadmap' },
    ],
    selectedItems,
    t: createTranslator('en'),
    visibleItems: selectedItems,
    workspaceId: 'workspace-1',
    onApply: async () => partialOperation,
    onPreview: async (request) => ({
      action: request.action,
      canApply: true,
      items: request.items.map((item) => ({
        ...item,
        retryable: false,
        status: 'ready' as const,
        undoable: false,
      })),
      operationToken: 'preview-token',
    }),
    onRetry: async () => partialOperation,
    onUndo: async () => ({ ...succeededOperation, status: 'undone' as const }),
    onVisibleSelectionChange: () => undefined,
  },
} satisfies Meta<typeof BulkOperationToolbar>

/** Bulk operation toolbar Storybook metadata です。 */
export default meta

/** Bulk operation toolbar Story の型です。 */
type Story = StoryObj<typeof meta>

/** Success、conflict、retryable failure が混在する結果です。 */
export const PartialFailure: Story = {
  args: { initialOperation: partialOperation },
}

/** 成功 item を undo できる結果です。 */
export const UndoAvailable: Story = {
  args: { initialOperation: succeededOperation },
}

/** Guest/read-only user に一括操作を許可しない状態です。 */
export const ReadOnly: Story = {
  args: {
    initialOperation: undefined,
    onApply: undefined,
    onPreview: undefined,
    onRetry: undefined,
    onUndo: undefined,
    readOnly: true,
  },
}
