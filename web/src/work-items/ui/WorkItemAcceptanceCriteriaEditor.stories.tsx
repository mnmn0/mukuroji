import type { WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { Locale } from '../../shared/i18n/i18n'
import { WorkItemAcceptanceCriteriaEditor } from './WorkItemAcceptanceCriteriaEditor'
import type { AcceptanceCriteriaDraft } from './useAcceptanceCriteriaDraft'

/** Props of the story wrapper that owns the draft like a Work Item detail pane does. */
type AcceptanceCriteriaEditorStoryProps = {
  /** Display locale. */
  locale: Locale
  /** Stored criteria. */
  criteria: readonly WorkItemAcceptanceCriterion[] | undefined
  /** Shows criteria without edit controls. */
  readOnly?: boolean
  /** Draft the story starts from. */
  initialDraft?: AcceptanceCriteriaDraft
}

/**
 * Renders the editor inside an editor form with a draft held above it.
 *
 * @param props - Stored criteria and the starting draft.
 * @returns The editor and its owning form.
 */
function AcceptanceCriteriaEditorStory({ criteria, initialDraft, locale, readOnly }: AcceptanceCriteriaEditorStoryProps) {
  const [draft, setDraft] = useState<AcceptanceCriteriaDraft>(initialDraft ?? { nextRowNumber: 1 })
  return (
    <>
      <form id="story-work-item-editor" />
      <WorkItemAcceptanceCriteriaEditor
        criteria={criteria}
        draftState={{ draft, setDraft }}
        formId="story-work-item-editor"
        locale={locale}
        readOnly={readOnly}
      />
    </>
  )
}

/** Stored criteria shown in most stories. */
const storedCriteria: WorkItemAcceptanceCriterion[] = [
  { id: 'a'.repeat(32), text: 'bun run server:test が成功する', satisfied: true },
  { id: 'b'.repeat(32), text: 'Storybook に新しい画面の Story がある', satisfied: false },
  { id: 'c'.repeat(32), text: 'docs/public-api.md に新しい field を記載する', satisfied: false },
]

/** Storybook metadata for the Work Item acceptance criteria editor. */
const meta = {
  title: 'Application/Work Items/Acceptance Criteria Editor',
  component: AcceptanceCriteriaEditorStory,
  args: {
    locale: 'ja',
    criteria: storedCriteria,
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <section className="workbench-panel mx-auto max-w-xl p-5">
          <Story />
        </section>
      </main>
    ),
  ],
} satisfies Meta<typeof AcceptanceCriteriaEditorStory>

export default meta

/** Story type for the acceptance criteria editor. */
type Story = StoryObj<typeof meta>

/** Met and unmet criteria with a progress summary. */
export const Default: Story = {}

/** No criteria yet on an editable Work Item. */
export const Empty: Story = {
  args: { criteria: [] },
}

/** Read-only Work Items show criteria without edit controls. */
export const ReadOnly: Story = {
  args: { readOnly: true },
}

/** English labels. */
export const English: Story = {
  args: { locale: 'en' },
}

/** Editing opens one row per criterion and can add, reorder, and remove rows. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '受け入れ条件を編集' }))
    await expect(canvas.getAllByTestId('work-item-acceptance-criterion-row')).toHaveLength(3)
    await userEvent.click(canvas.getByRole('button', { name: '条件を追加' }))
    await expect(canvas.getAllByTestId('work-item-acceptance-criterion-row')).toHaveLength(4)
    await userEvent.click(canvas.getByRole('button', { name: '下へ: 条件 1' }))
    await expect(canvas.getAllByRole('textbox')[1]).toHaveValue('bun run server:test が成功する')
    await userEvent.click(canvas.getByRole('button', { name: '削除: 条件 4' }))
    await expect(canvas.getAllByTestId('work-item-acceptance-criterion-row')).toHaveLength(3)
  },
}

/** A submit of the owning form reports a row without text. */
export const SubmitError: Story = {
  args: {
    criteria: [],
    initialDraft: {
      nextRowNumber: 2,
      rows: [{ key: 'new-1', text: '', satisfied: false }],
      submitError: { error: 'missing-text', rowKey: 'new-1' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert')).toHaveTextContent('条件の文言を入力してください。')
  },
}
