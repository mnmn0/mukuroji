import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { MentionableMember } from '../lib/memberMentions'
import { MemberMentionTextarea, type MemberMentionDraft } from './MemberMentionTextarea'

/** Sample mention candidates, including two members with the same name. */
const sampleMembers: MentionableMember[] = [
  { memberKey: 'taro@example.com', email: 'taro@example.com', name: '山田 太郎', status: 'active' },
  { memberKey: 'hanako@example.com', email: 'hanako@example.com', name: '佐藤 花子', status: 'active' },
  { memberKey: 'kai-1@example.com', email: 'kai-1@example.com', name: 'Kai', status: 'active' },
  { memberKey: 'kai-2@example.com', email: 'kai-2@example.com', name: 'Kai', status: 'active' },
]

/**
 * Renders the textarea with local draft state and shows the picked member keys below it.
 *
 * @returns The sample composer.
 */
function MentionComposerSample() {
  const [draft, setDraft] = useState<MemberMentionDraft>({ body: '', mentionMemberKeys: [] })
  return (
    <div className="grid max-w-md gap-2 p-6">
      <MemberMentionTextarea
        ariaLabel="コメント"
        className="workbench-input min-h-24 w-full p-3 text-sm"
        draft={draft}
        members={sampleMembers}
        placeholder="@ で名前からメンション…"
        suggestionsLabel="メンションの候補"
        onDraftChange={setDraft}
      />
      <p className="text-xs text-[var(--workbench-muted)]" data-testid="picked-members">
        {draft.mentionMemberKeys.join(', ')}
      </p>
    </div>
  )
}

const meta = {
  title: 'Design System/Member Mention Textarea',
  component: MentionComposerSample,
} satisfies Meta<typeof MentionComposerSample>

export default meta

/** Story object of this component's stories. */
type Story = StoryObj<typeof meta>

/** Typing `@` and part of a name offers members; Enter inserts the name token. */
export const PickByName: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByRole('combobox', { name: 'コメント' })
    await userEvent.type(textarea, '確認お願いします @山田')
    await expect(canvas.getByRole('listbox', { name: 'メンションの候補' })).toBeVisible()
    await userEvent.keyboard('{Enter}')
    await expect(textarea).toHaveValue('確認お願いします @山田 太郎 ')
    await expect(canvas.getByTestId('picked-members')).toHaveTextContent('taro@example.com')
  },
}

/** Moving the caret out of the typed `@query` closes the list, so Enter types a newline again. */
export const CaretLeavesMention: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByRole('combobox', { name: 'コメント' })
    await userEvent.type(textarea, '@山田')
    await expect(canvas.getByRole('listbox', { name: 'メンションの候補' })).toBeVisible()
    await userEvent.keyboard('{Home}')
    await expect(canvas.queryByRole('listbox', { name: 'メンションの候補' })).toBeNull()
    await userEvent.keyboard('{Enter}')
    await expect(textarea).toHaveValue('\n@山田')
    await expect(canvas.getByTestId('picked-members')).toHaveTextContent('')
  },
}

/** Clicking after a picked token keeps the list closed, so Enter types a newline. */
export const CaretAfterPickedToken: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByRole('combobox', { name: 'コメント' })
    await userEvent.type(textarea, '@山田')
    await userEvent.keyboard('{Enter}')
    await expect(textarea).toHaveValue('@山田 太郎 ')
    await userEvent.click(textarea)
    await expect(canvas.queryByRole('listbox', { name: 'メンションの候補' })).toBeNull()
    await userEvent.keyboard('{Enter}')
    await expect(textarea).toHaveValue('@山田 太郎 \n')
  },
}

/** Escape closes the list without reaching a surrounding panel that also listens for Escape. */
export const EscapeStaysInComposer: Story = {
  render: () => {
    /** Panel that records an Escape that escaped the composer. */
    function EscapePanel() {
      const [closedCount, setClosedCount] = useState(0)
      return (
        <div onKeyDown={(event) => { if (event.key === 'Escape') setClosedCount((count) => count + 1) }}>
          <MentionComposerSample />
          <p data-testid="panel-escapes">{closedCount}</p>
        </div>
      )
    }
    return <EscapePanel />
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByRole('combobox', { name: 'コメント' })
    await userEvent.type(textarea, '@山田')
    await userEvent.keyboard('{Escape}')
    await expect(canvas.queryByRole('listbox', { name: 'メンションの候補' })).toBeNull()
    await expect(canvas.getByTestId('panel-escapes')).toHaveTextContent('0')
    await userEvent.keyboard('{Escape}')
    await expect(canvas.getByTestId('panel-escapes')).toHaveTextContent('1')
  },
}

/** Members with the same name are inserted with their email so the token stays unique. */
export const DuplicateNames: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByRole('combobox', { name: 'コメント' })
    await userEvent.type(textarea, '@Kai')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect(textarea).toHaveValue('@Kai (kai-2@example.com) ')
  },
}
