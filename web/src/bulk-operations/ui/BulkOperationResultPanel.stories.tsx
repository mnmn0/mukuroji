import {
  AUTOMATION_SCHEMA_VERSION,
  type BulkOperation,
  type BulkOperationItemResult,
  type BulkOperationPreview,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { BulkOperationResultPanel } from './BulkOperationResultPanel'

const readyItem = {
  expectedRevision: 3,
  retryable: false,
  status: 'ready',
  teamId: 'core-team',
  undoable: false,
  workItemId: 'release-checklist',
} satisfies BulkOperationItemResult

const succeededItem = {
  ...readyItem,
  resultingRevision: 4,
  status: 'succeeded',
  undoable: true,
} satisfies BulkOperationItemResult

const retryableItem = {
  errorCode: 'DynamoDbThrottled',
  errorMessage: 'The item can be retried safely.',
  expectedRevision: 5,
  retryable: true,
  status: 'failed',
  teamId: 'design-team',
  undoable: false,
  workItemId: 'brand-review',
} satisfies BulkOperationItemResult

const conflictItem = {
  errorCode: 'WorkItemRevisionConflict',
  errorMessage: 'The Work Item changed after preview.',
  expectedRevision: 2,
  retryable: false,
  status: 'failed',
  teamId: 'core-team',
  undoable: false,
  workItemId: 'publish-notes',
} satisfies BulkOperationItemResult

const preview = {
  action: { archived: true, type: 'archive' },
  canApply: true,
  items: [
    readyItem,
    {
      ...readyItem,
      expectedRevision: 5,
      teamId: 'design-team',
      workItemId: 'brand-review',
    },
  ],
  operationToken: 'preview-token',
} satisfies BulkOperationPreview

const operationBase = {
  action: { archived: true, type: 'archive' },
  actorMemberKey: 'member-owner',
  createdAt: '2026-07-16T02:00:00.000Z',
  revision: 4,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  updatedAt: '2026-07-16T02:00:02.000Z',
  workspaceId: 'workspace-1',
} satisfies Omit<BulkOperation, 'id' | 'items' | 'status'>

const runningOperation = {
  ...operationBase,
  id: 'bulk-running-1',
  items: [succeededItem, retryableItem, readyItem],
  status: 'running',
} satisfies BulkOperation

const partialOperation = {
  ...operationBase,
  id: 'bulk-partial-1',
  items: [succeededItem, retryableItem, conflictItem],
  status: 'partial',
} satisfies BulkOperation

const undoneOperation = {
  ...operationBase,
  id: 'bulk-undone-1',
  items: [
    { ...succeededItem, status: 'undone', undoable: false },
    {
      ...succeededItem,
      status: 'undone',
      teamId: 'design-team',
      undoable: false,
      workItemId: 'brand-review',
    },
  ],
  status: 'undone',
} satisfies BulkOperation

const meta = {
  title: 'Application/Projects/Bulk Operation Result Panel',
  component: BulkOperationResultPanel,
  parameters: { layout: 'padded' },
  args: {
    t: createTranslator('en'),
    onClose: () => undefined,
  },
} satisfies Meta<typeof BulkOperationResultPanel>

/** Bulk operation result panel Storybook metadata です。 */
export default meta

/** Bulk operation result panel Story の型です。 */
type Story = StoryObj<typeof meta>

/** Apply 可能な preview と apply action を表示します。 */
export const Preview: Story = {
  args: {
    onApply: () => undefined,
    preview,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('button', { name: 'Apply' })).toBeEnabled()
    await expect(canvas.queryByTestId('bulk-resume')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('bulk-retry-failed')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('bulk-undo')).not.toBeInTheDocument()
  },
}

/** Running operation では未完了 item の resume だけを許可します。 */
export const Running: Story = {
  args: {
    onResume: () => undefined,
    onRetry: () => undefined,
    onUndo: () => undefined,
    operation: runningOperation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByTestId('bulk-resume')).toBeEnabled()
    await expect(canvas.queryByTestId('bulk-retry-failed')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('bulk-undo')).not.toBeInTheDocument()
  },
}

/** Partial operation では retry と succeeded item の undo を許可します。 */
export const Partial: Story = {
  args: {
    onRetry: () => undefined,
    onUndo: () => undefined,
    operation: partialOperation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByTestId('bulk-retry-failed')).toBeEnabled()
    await expect(canvas.getByTestId('bulk-undo')).toBeEnabled()
    await expect(canvas.queryByTestId('bulk-resume')).not.toBeInTheDocument()
  },
}

/** Undone operation では retry、resume、undo action を表示しません。 */
export const Undone: Story = {
  args: {
    onResume: () => undefined,
    onRetry: () => undefined,
    onUndo: () => undefined,
    operation: undoneOperation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.queryByTestId('bulk-resume')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('bulk-retry-failed')).not.toBeInTheDocument()
    await expect(canvas.queryByTestId('bulk-undo')).not.toBeInTheDocument()
  },
}
