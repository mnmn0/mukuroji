import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { WorkItemContributorsEditor } from './WorkItemContributorsEditor'

/** Storybook metadata for the Work Item contributor editor. */
const meta = {
  title: 'Application/Work Items/Contributors Editor',
  component: WorkItemContributorsEditor,
  args: {
    locale: 'ja',
    ownerUserId: 'sato@example.com',
    jobRoles: [
      { id: 'designer', name: 'デザイナー' },
      { id: 'qa', name: 'QA' },
      { id: 'legacy-writer', name: 'ライター', archived: true },
    ],
    memberOptions: [
      { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤' },
      { id: 'suzuki@example.com', email: 'suzuki@example.com', name: '鈴木' },
    ],
    assignments: [
      {
        assignmentId: 'a'.repeat(32),
        memberUserId: 'suzuki@example.com',
        jobRoleId: 'designer',
        plannedEffortMinutes: 360,
        status: 'in-progress',
      },
      { assignmentId: 'b'.repeat(32), jobRoleId: 'qa', plannedEffortMinutes: 120, status: 'planned' },
    ],
    onSave: async () => undefined,
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
} satisfies Meta<typeof WorkItemContributorsEditor>

export default meta

/** Story type for the contributor editor. */
type Story = StoryObj<typeof meta>

/** A member contributor and a role-only planned contributor. */
export const Default: Story = {}

/** No contributors yet on an editable Work Item. */
export const Empty: Story = {
  args: { assignments: [] },
}

/** Read-only Work Items show contributors without edit controls. */
export const ReadOnly: Story = {
  args: { onSave: undefined },
}

/** Editing reports a row that has neither a member nor a job role. */
export const ValidationError: Story = {
  args: { assignments: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Contributor を編集' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Contributor を追加' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Contributor を保存' }))
    await expect(canvas.getByRole('alert')).toHaveTextContent('メンバーかジョブロールのどちらかを選んでください。')
  },
}
