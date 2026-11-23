import {
  AUTOMATION_SCHEMA_VERSION,
  type BulkOperation,
  type BulkOperationPreview,
  type BulkOperationRequest,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'
import type { MemberWorkHandoverItem } from '../model/memberWorkHandover'
import { MemberWorkHandoverDialog } from './MemberWorkHandoverDialog'

const leaver = {
  createdAt: '2026-07-01T00:00:00.000Z',
  email: 'sato@example.com',
  id: 'member-sato',
  memberKey: 'sato@example.com',
  name: '佐藤 花子',
  role: 'member',
  status: 'deactivated',
  updatedAt: '2026-11-20T00:00:00.000Z',
  version: 3,
} satisfies WorkspaceMember

const successor = {
  ...leaver,
  email: 'suzuki@example.com',
  id: 'member-suzuki',
  memberKey: 'suzuki@example.com',
  name: '鈴木 一郎',
  status: 'active',
} satisfies WorkspaceMember

const guest = {
  ...leaver,
  email: 'guest@example.com',
  id: 'member-guest',
  memberKey: 'guest@example.com',
  name: 'Guest Reviewer',
  role: 'guest',
  status: 'active',
} satisfies WorkspaceMember

const items = [
  {
    contributor: false,
    key: 'CORE-12',
    owner: true,
    revision: 4,
    teamId: 'core-team',
    title: 'リリース手順を更新する',
    workItemId: 'release-runbook',
  },
  {
    contributor: true,
    key: 'CORE-18',
    owner: false,
    revision: 2,
    teamId: 'core-team',
    title: '受け入れテストを実施する',
    workItemId: 'acceptance-test',
  },
] satisfies MemberWorkHandoverItem[]

/**
 * Builds the preview the server returns for a handover request.
 *
 * @param request - Handover request.
 * @returns A preview where every Work Item is ready.
 */
function createPreview(request: BulkOperationRequest): BulkOperationPreview {
  return {
    action: request.action,
    canApply: true,
    items: request.items.map((item) => ({ ...item, retryable: false, status: 'ready', undoable: false })),
    operationToken: 'handover-preview-token',
  }
}

/**
 * Builds the operation the server returns after a handover is applied.
 *
 * @param request - Handover request.
 * @returns A succeeded operation.
 */
function createOperation(request: BulkOperationRequest): BulkOperation {
  return {
    action: request.action,
    actorMemberKey: 'owner@example.com',
    createdAt: '2026-11-23T03:00:00.000Z',
    id: 'bulk-handover-1',
    items: request.items.map((item) => ({
      ...item,
      resultingRevision: item.expectedRevision + 1,
      retryable: false,
      status: 'succeeded',
      undoable: true,
    })),
    revision: 2,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    status: 'succeeded',
    updatedAt: '2026-11-23T03:00:01.000Z',
    workspaceId: request.workspaceId,
  }
}

/** Number of applies the resume story has answered, so the first one reports a running operation. */
let applyCount = 0

const meta = {
  title: 'Application/Workspace/MemberWorkHandoverDialog',
  component: MemberWorkHandoverDialog,
  args: {
    handlers: {
      apply: fn(async (request: BulkOperationRequest) => createOperation(request)),
      preview: fn(async (request: BulkOperationRequest) => createPreview(request)),
      retry: fn(async (_operationId: string, operation?: BulkOperation) => {
        if (!operation) throw new Error('Missing operation.')
        return operation
      }),
      undo: fn(async (_operationId: string, operation?: BulkOperation): Promise<BulkOperation> => {
        if (!operation) throw new Error('Missing operation.')
        return { ...operation, status: 'undone' }
      }),
    },
    loadState: { status: 'loaded', items },
    member: leaver,
    members: [leaver, successor, guest],
    t: createTranslator('ja'),
    workspaceId: 'workspace-1',
    onClose: fn(),
    onReload: fn(),
  },
} satisfies Meta<typeof MemberWorkHandoverDialog>

export default meta

type Story = StoryObj<typeof meta>

/** Shows the member's open Work Items and hands them over after a preview. */
export const HandOverToSuccessor: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(canvas.getByTestId('member-work-handover-summary')).toHaveTextContent('責任者 1 件、Contributor 1 件')
    const successorSelect = canvas.getByTestId('member-work-handover-successor')
    // A guest cannot take over work, so only the active member is offered.
    await expect(within(successorSelect).queryByText(/Guest Reviewer/)).toBeNull()
    await userEvent.selectOptions(successorSelect, 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('member-work-handover-preview'))
    await expect(args.handlers.preview).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'reassign-member', fromMemberUserId: 'sato@example.com', toMemberUserId: 'suzuki@example.com' },
    }))
  },
}

/** Reading the member's Work Items. */
export const Loading: Story = {
  args: { loadState: { status: 'loading' } },
}

/** Reading the member's Work Items failed and can be retried. */
export const LoadFailed: Story = {
  args: { loadState: { status: 'failed' } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: '再読み込み' }))
    await expect(args.onReload).toHaveBeenCalled()
  },
}

/** The member has nothing left to hand over. */
export const NothingToHandOver: Story = {
  args: { loadState: { status: 'loaded', items: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement.ownerDocument.body).getByTestId('member-work-handover-empty')).toBeVisible()
  },
}

/** The handover was already running from another tab; resuming sends the same apply again. */
export const ResumeRunningHandover: Story = {
  args: {
    handlers: {
      ...meta.args.handlers,
      apply: fn(async (request: BulkOperationRequest): Promise<BulkOperation> => {
        const operation = createOperation(request)
        return applyCount++ === 0
          ? {
              ...operation,
              items: operation.items.map((item) => ({ ...item, status: 'ready', undoable: false })),
              status: 'running',
            }
          : operation
      }),
    },
  },
  play: async ({ args, canvasElement }) => {
    applyCount = 0
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.selectOptions(canvas.getByTestId('member-work-handover-successor'), 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('member-work-handover-preview'))
    await userEvent.click(await canvas.findByRole('button', { name: '適用' }))
    await userEvent.click(await canvas.findByTestId('bulk-resume'))
    await expect(args.handlers.apply).toHaveBeenCalledTimes(2)
  },
}
