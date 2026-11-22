import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, within } from 'storybook/test'
import type { DocumentBlock } from '@mukuroji/contracts'
import { documentRecordFixture } from '../fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { DocumentEditor } from './DocumentEditor'

const t = createTranslator('ja')

/** Members offered as checklist item owners in these stories. */
const assignees = [
  { id: 'sato@example.com', label: '佐藤 一郎' },
  { id: 'yamada@example.com', label: '山田 花子' },
]

/** Meeting-notes action items with an owner, a deadline, and an overdue item. */
const actionItemsBlock: DocumentBlock = {
  id: 'checklist-action-items',
  items: [
    {
      assigneeMemberKey: 'yamada@example.com',
      checked: false,
      dueDate: '2099-12-01',
      id: 'item-estimate',
      text: '見積もりを送る',
    },
    {
      assigneeMemberKey: 'sato@example.com',
      checked: false,
      dueDate: '2000-01-01',
      id: 'item-review',
      text: 'レビュー日程を決める',
    },
    { checked: true, id: 'item-done', text: '議事録を共有する' },
  ],
  type: 'checklist',
}

/**
 * Renders the editor with local state so owner and deadline changes show up.
 *
 * @param props - Whether the viewer can edit.
 * @returns The editor with the action items block.
 */
function ActionItemsEditor({ editable }: { editable: boolean }) {
  const [blocks, setBlocks] = useState<DocumentBlock[]>([actionItemsBlock])
  if (documentRecordFixture.kind !== 'page') return null
  return (
    <DocumentEditor
      checklistWorkItems={{ assignees, onCreate: () => undefined, relations: [] }}
      document={{ ...documentRecordFixture, blocks, relations: [] }}
      editable={editable}
      saveStatus="idle"
      t={t}
      onDeleteBlock={() => undefined}
      onMoveBlock={() => undefined}
      onUpsertBlock={(block) =>
        setBlocks((current) =>
          current.map((candidate) => (candidate.id === block.id ? block : candidate)))
      }
    />
  )
}

const meta = {
  title: 'Application/Documents/Document Editor',
  component: ActionItemsEditor,
  args: { editable: true },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ActionItemsEditor>

export default meta

type Story = StoryObj<typeof meta>

/** Owners and deadlines are edited under each action item. */
export const ActionItemOwners: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('チェック項目 1 の担当者')).toHaveValue('yamada@example.com')
    await expect(canvas.getByLabelText('チェック項目 2 の期限')).toHaveValue('2000-01-01')
    await expect(canvas.getByText('期限切れ')).toBeVisible()
  },
}

/** Read-only viewers see the owner name and deadline as text. */
export const ActionItemOwnersReadOnly: Story = {
  args: { editable: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('担当: 山田 花子')).toBeVisible()
    await expect(canvas.getByText('期限: 2000-01-01（期限切れ）')).toBeVisible()
  },
}

/** The owner and deadline fields wrap under the item on a phone. */
export const ActionItemOwnersMobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
