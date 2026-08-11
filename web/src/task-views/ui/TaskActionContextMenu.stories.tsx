import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTaskSurfaceActionRegistry } from '../mutations/useTaskSurfaceActions'
import {
  TaskActionContextMenu,
  type TaskActionContextMenuProps,
} from './TaskActionContextMenu'

const labels = {
  archive: 'アーカイブ',
  assign: '担当者を変更',
  create: 'タスクを作成',
  edit: '編集',
  move: '移動',
  open: '開く',
  relation: '関連を編集',
  schedule: '日程を編集',
  watch: 'ウォッチ',
}

const disabledReasons = {
  selectionRequired: 'タスクを1件選択してください。',
  singleSelectionRequired: 'タスクを1件だけ選択してください。',
  unavailable: 'この画面では利用できません。',
}

const registry = createTaskSurfaceActionRegistry({
  disabledReasons,
  handlers: {
    edit: (context) => ({
      actionId: context.actionId,
      items: [],
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      status: 'succeeded',
    }),
    open: (context) => ({
      actionId: context.actionId,
      items: [],
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      status: 'succeeded',
    }),
  },
  permissions: {
    edit: () => ({ allowed: false, reason: 'このタスクを編集する権限がありません。' }),
  },
})

const context: Omit<
  WorkItemActionContext,
  'actionId' | 'keyboardShortcut' | 'trigger'
> = {
  schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
  scope: { kind: 'project', projectId: 'refero', teamId: 'design' },
  selection: {
    focusedTarget: {
      expectedRevision: 4,
      teamId: 'design',
      workItemId: 'context-menu',
    },
    mode: 'none',
    targets: [],
  },
  surface: 'project',
  viewId: 'delivery-review',
}

/** Interactive task-card harness that verifies dismissal and focus restoration. */
function TaskActionContextMenuStory(props: TaskActionContextMenuProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null)
  return (
    <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[640px]:p-3">
      <article className="workbench-panel max-w-md p-4">
        <p className="workbench-eyebrow">Design</p>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-[var(--workbench-text)]">
              コンテキストメニューを確認する
            </h1>
            <p className="mt-1 text-sm text-[var(--workbench-muted)]">
              権限のない操作も理由とともに表示します。
            </p>
          </div>
          <button
            aria-label="タスク操作を開く"
            className="workbench-button-secondary grid h-10 w-10 place-items-center"
            onClick={() => setIsOpen(true)}
            ref={setTriggerElement}
            type="button"
          >
            …
          </button>
        </div>
      </article>
      {isOpen ? (
        <TaskActionContextMenu
          {...props}
          onClose={() => {
            setIsOpen(false)
            props.onClose()
          }}
          onExecute={props.onExecute}
          returnFocusElement={triggerElement}
        />
      ) : null}
    </main>
  )
}

const meta = {
  title: 'Application/Task views/Action context menu',
  component: TaskActionContextMenu,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    anchorPoint: { x: 420, y: 112 },
    context,
    labels,
    menuLabel: 'タスク操作',
    onClose: fn(),
    onExecute: fn(),
    registry,
  },
  render: (args) => <TaskActionContextMenuStory {...args} />,
} satisfies Meta<typeof TaskActionContextMenu>

/** Storybook metadata for the shared task action context menu. */
export default meta

/** Story type for the shared task action context menu. */
type Story = StoryObj<typeof meta>

/** Compact desktop popover with permission and availability reasons. */
export const Desktop: Story = {
  play: async ({ args, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const menu = await body.findByRole('menu', { name: 'タスク操作' })
    const openAction = body.getByRole('menuitem', { name: /^開く/ })
    const editAction = body.getByRole('menuitem', { name: /^編集/ })

    await expect(menu).toHaveAttribute('data-testid', 'task-action-context-menu')
    await expect(openAction).toHaveFocus()
    await expect(editAction).toHaveAttribute('aria-disabled', 'true')
    await expect(body.getByText('このタスクを編集する権限がありません。')).toBeVisible()
    await userEvent.click(openAction)
    await expect(args.onExecute).toHaveBeenCalledWith('open')
    await expect(args.onClose).toHaveBeenCalled()
    await expect(body.getByRole('button', { name: 'タスク操作を開く' })).toHaveFocus()
  },
}

/** Touch-sized bottom sheet at the supported mobile viewport. */
export const Mobile: Story = {
  globals: {
    viewport: {
      value: 'mobile1',
      isRotated: false,
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const backdrop = await body.findByTestId('task-action-context-menu-backdrop')
    const openAction = body.getByRole('menuitem', { name: /^開く/ })

    await expect(backdrop).toHaveAttribute('data-layout', 'sheet')
    await expect(openAction).toHaveClass('min-h-[52px]')
    await expect(canvasElement.ownerDocument.body.style.overflow).toBe('hidden')
    await userEvent.keyboard('{Escape}')
    await expect(body.queryByRole('menu', { name: 'タスク操作' })).not.toBeInTheDocument()
    await expect(canvasElement.ownerDocument.body.style.overflow).toBe('')
  },
}
