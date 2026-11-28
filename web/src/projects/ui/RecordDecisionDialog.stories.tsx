import type { Meta, StoryObj } from '@storybook/react-vite'
import { SWRConfig, unstable_serialize } from 'swr'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectMember } from '../api/members'
import { toProjectDecisionFormValues } from '../model/projectDecisionForm'
import { RecordDecisionDialog } from './RecordDecisionDialog'

/** Session token used only to key the member fixture. */
const storyToken = 'story-token'

/** Project members who may be named as deciders. */
const members: ProjectMember[] = [
  { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子', workspaceStatus: 'active', role: 'member', updatedAt: '2026-11-20T00:00:00.000Z' },
  { id: 'tanaka@example.com', email: 'tanaka@example.com', name: '田中 太郎', workspaceStatus: 'active', role: 'viewer', updatedAt: '2026-11-20T00:00:00.000Z' },
]

/** Projects the decision may be recorded in. */
const projects = [
  { teamId: 'core-team', id: 'atlas', name: 'Atlas' },
  { teamId: 'core-team', id: 'borealis', name: 'Borealis' },
]

/** Member query results by SWR key, so the stories never call the API. */
const fallback = Object.fromEntries(projects.map((project) => [
  unstable_serialize(['project-members', storyToken, project.id, project.teamId]),
  members,
]))

const meta = {
  title: 'Projects/RecordDecisionDialog',
  component: RecordDecisionDialog,
  decorators: [
    (Story) => (
      <SWRConfig value={{ provider: () => new Map(), fallback, shouldRetryOnError: false, revalidateOnMount: false }}>
        <Story />
      </SWRConfig>
    ),
  ],
  parameters: { layout: 'fullscreen' },
  args: {
    accessToken: storyToken,
    origin: 'document',
    prefill: {
      title: '認証基盤は Cognito を使う',
      sources: [{ url: 'https://example.com/documents/auth', label: '認証方式の検討' }],
    },
    projects,
    save: async () => undefined,
    t: createTranslator('ja'),
    onClose: () => undefined,
    onRecorded: () => undefined,
  },
} satisfies Meta<typeof RecordDecisionDialog>

/** Record decision dialog Storybook metadata. */
export default meta

/** Story type for record decision dialog examples. */
type Story = StoryObj<typeof meta>

/** Opened from a Document; the Project still has to be chosen. */
export const ChooseProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('record-decision-dialog')).toBeVisible()
    await expect(canvas.getByTestId('record-decision-form-title')).toHaveValue('認証基盤は Cognito を使う')
    // The required content is filled first, so the submission reaches the Project check.
    await userEvent.type(canvas.getByTestId('record-decision-form-content'), 'Cognito のユーザープールに寄せる。')
    await userEvent.click(canvas.getByRole('button', { name: '保存' }))
    await expect(canvas.getByText('記録する Project を選んでください。')).toBeVisible()
  },
}

/** Opened from a Work Item whose Project cannot change. */
export const LockedProject: Story = {
  args: { defaultProject: projects[0], lockProject: true, origin: 'work-item' },
}

/** A failed save shows its error and keeps the form for a retry. */
export const SaveFailure: Story = {
  args: {
    defaultProject: projects[0],
    save: async () => {
      throw new Error('network')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByTestId('record-decision-form-content'), 'Cognito のユーザープールに寄せる。')
    await userEvent.click(canvas.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(canvas.getByRole('alert')).toBeVisible())
    await expect(canvas.getByTestId('record-decision-form-content')).toHaveValue('Cognito のユーザープールに寄せる。')
  },
}

/** Reopened after a failed save, with the form that was sent. */
export const ReopenedAfterFailure: Story = {
  args: {
    unsentDraft: {
      projectKey: JSON.stringify(['core-team', 'atlas']),
      values: toProjectDecisionFormValues(undefined, { title: '前回送った決定' }),
    },
  },
}

/** English labels. */
export const English: Story = {
  args: { t: createTranslator('en') },
}
