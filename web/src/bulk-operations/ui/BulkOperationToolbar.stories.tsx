import { AUTOMATION_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { BulkOperation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { BulkOperationToolbar, type BulkOperationSelection } from './BulkOperationToolbar'
import { expect, fn, userEvent, within } from 'storybook/test'

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

const partialOperation: BulkOperation = {
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

const runningOperation = {
  ...partialOperation,
  id: 'bulk-running-1',
  status: 'running' as const,
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

/** Keeps the preview open when the owning detail editor declines a destructive mutation. */
export const BeforeMutationCanCancel: Story = {
  args: {
    onApply: fn(async () => partialOperation),
    onBeforeMutation: fn(() => false),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const editValue = canvas.getByRole('textbox')
    await userEvent.type(editValue, 'review')
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }))

    expect(args.onBeforeMutation).toHaveBeenCalledTimes(1)
    expect(args.onApply).not.toHaveBeenCalled()
    expect(canvas.getByRole('region', { name: 'Bulk operation preview' })).toBeInTheDocument()
  },
}

/** Keeps retry and undo from dispatching while the owning detail declines the mutation. */
export const DurableActionsRespectDraftGuard: Story = {
  args: {
    initialOperation: partialOperation,
    onBeforeMutation: fn(() => false),
    onRetry: fn(async () => partialOperation),
    onUndo: fn(async () => ({ ...succeededOperation, status: 'undone' as const })),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('bulk-retry-failed'))
    await userEvent.click(canvas.getByTestId('bulk-undo'))

    expect(args.onBeforeMutation).toHaveBeenCalledTimes(2)
    expect(args.onRetry).not.toHaveBeenCalled()
    expect(args.onUndo).not.toHaveBeenCalled()
    expect(canvas.getByTestId('bulk-operation-review')).toBeInTheDocument()
  },
}

/** Keeps resume from dispatching while a running operation targets a dirty detail. */
export const ResumeRespectsDraftGuard: Story = {
  args: {
    onBeforeMutation: fn(({ kind }) => kind !== 'resume'),
    onApply: fn(async () => runningOperation),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByRole('textbox'), 'review')
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }))
    await expect(canvas.getByTestId('bulk-resume')).toBeInTheDocument()
    await userEvent.click(canvas.getByTestId('bulk-resume'))

    expect(args.onBeforeMutation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resume' }))
    expect(args.onApply).toHaveBeenCalledTimes(1)
    expect(canvas.getByTestId('bulk-operation-review')).toBeInTheDocument()
  },
}
