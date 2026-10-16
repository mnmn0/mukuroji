import type { Meta, StoryObj } from '@storybook/react-vite'
import { createDefaultUnscheduledWorkItemSchedule } from '@mukuroji/contracts'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { referoTaskFixtures } from '../fixtures'
import { TaskHandoffPanel, type TaskHandoffPanelProps } from './TaskHandoffPanel'

const task = {
  ...referoTaskFixtures[0],
  workflowStatusId: 'active',
  description: '目的: モバイルでもタスクを迷わず確認できること。\n完了条件: キーボード操作と狭い画面での表示を検証し、差分と結果を共有する。',
}

const meta = {
  title: 'Application/Tasks/TaskHandoffPanel',
  component: TaskHandoffPanel,
  args: {
    configuration: teamWorkItemConfigurationFixture,
    includeDescription: true,
    task,
    t: createTranslator('ja'),
  },
  decorators: [
    (Story) => <div className="mx-auto w-full max-w-xl bg-white px-5 py-4"><Story /></div>,
  ],
} satisfies Meta<typeof TaskHandoffPanel>

export default meta
/** Interactive handoff scenarios for Storybook validation. */
type Story = StoryObj<typeof meta>

/** Shows the saved preview and supports manual copying without clipboard permission. */
export const SavedBrief: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
    const preview = canvas.getByRole('textbox', { name: '引き継ぎ内容' })
    if (!(preview instanceof HTMLTextAreaElement)) throw new Error('Expected a handoff preview textarea')
    await expect(preview.value).toContain('Team ID: core-team')
    await userEvent.click(canvas.getByRole('button', { name: '全文を選択' }))
    await expect(preview).toHaveFocus()
    if (preview instanceof HTMLTextAreaElement) {
      await expect(preview.selectionStart).toBe(0)
      await expect(preview.selectionEnd).toBe(preview.value.length)
    }
  },
}

/** Presents an English brief with an omitted description and no deadline. */
export const EnglishWithoutDescription: Story = {
  args: {
    includeDescription: false,
    task: { ...task, dueDate: '', schedule: createDefaultUnscheduledWorkItemSchedule(), assignedProjectId: undefined },
    t: createTranslator('en'),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText('Hand off to an agent'))
  },
}

/** Keeps the visible preview usable when the browser denies clipboard writes. */
export const ClipboardDenied: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('Clipboard denied') } },
    })
    try {
      await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
      await userEvent.click(canvas.getByRole('button', { name: '引き継ぎ内容をコピー' }))
      await expect(canvas.getByRole('alert')).toHaveTextContent('コピーできませんでした。')
      await expect(canvas.getByRole('textbox', { name: '引き継ぎ内容' })).toHaveFocus()
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  },
}

/** Simulates an external task revision while keeping the panel mounted. */
function RevisionHarness(props: TaskHandoffPanelProps) {
  const [revision, setRevision] = useState(props.task.revision)
  return (
    <>
      <button className="workbench-button-secondary mb-4 min-h-[44px] px-3" onClick={() => setRevision((value) => value + 1)} type="button">Load newer revision</button>
      <TaskHandoffPanel {...props} task={{ ...props.task, revision }} />
    </>
  )
}

/** Clears a successful clipboard message when a newer saved revision arrives. */
export const RevisionChanged: Story = {
  render: (args) => <RevisionHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } })
    try {
      await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
      await userEvent.click(canvas.getByRole('button', { name: '引き継ぎ内容をコピー' }))
      await expect(canvas.getByRole('status')).toHaveTextContent('コピーしました')
      await userEvent.click(canvas.getByRole('button', { name: 'Load newer revision' }))
      await expect(canvas.queryByRole('status')).toBeNull()
      await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
      const preview = canvas.getByRole('textbox', { name: '引き継ぎ内容' })
      if (!(preview instanceof HTMLTextAreaElement)) throw new Error('Expected a handoff preview textarea')
      await expect(preview.value).toContain('取得済み revision: 2')
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  },
}

/** Ignores completion of an old clipboard request after the selected snapshot changes. */
export const PendingCopyRevisionChanged: Story = {
  render: (args) => <RevisionHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let finishCopy: (() => void) | undefined
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => new Promise<void>((resolve) => { finishCopy = resolve }) },
    })
    try {
      await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
      await userEvent.click(canvas.getByRole('button', { name: '引き継ぎ内容をコピー' }))
      await expect(canvas.getByRole('button', { name: 'コピー中…' })).toBeDisabled()
      await userEvent.click(canvas.getByRole('button', { name: 'Load newer revision' }))
      finishCopy?.()
      await userEvent.click(canvas.getByText('エージェントへ引き継ぐ'))
      await expect(canvas.queryByRole('status')).toBeNull()
      await expect(canvas.getByRole('button', { name: '引き継ぎ内容をコピー' })).toBeEnabled()
      const preview = canvas.getByRole('textbox', { name: '引き継ぎ内容' })
      if (!(preview instanceof HTMLTextAreaElement)) throw new Error('Expected a handoff preview textarea')
      await expect(preview.value).toContain('取得済み revision: 2')
    } finally {
      finishCopy?.()
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  },
}
