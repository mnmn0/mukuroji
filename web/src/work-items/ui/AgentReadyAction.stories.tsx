import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { teamWorkItemConfigurationFixture } from '../fixtures'
import { AgentReadyAction } from './AgentReadyAction'

const task = {
  ...referoTaskFixtures[0],
  workflowStatusId: 'backlog',
  statusCategory: 'backlog' as const,
  acceptanceCriteria: [{ id: 'c1', text: '狭い画面で操作できる', satisfied: false }],
  relationIds: [],
}

const meta = {
  title: 'Application/Work Items/AgentReadyAction',
  component: AgentReadyAction,
  args: {
    activeRun: { status: 'loaded', value: false },
    configuration: teamWorkItemConfigurationFixture,
    onMoveToStatus: async () => undefined,
    settings: { status: 'loaded', value: { readyStatusIds: ['ready'], requireAcceptanceCriteria: true } },
    t: createTranslator('ja'),
    task,
  },
  decorators: [
    (Story) => <div className="mx-auto w-full max-w-xl bg-surface px-5 py-4"><Story /></div>,
  ],
} satisfies Meta<typeof AgentReadyAction>

export default meta

type Story = StoryObj<typeof meta>

/** A backlog task that one action moves to the Ready status. */
export const CanMove: Story = {}

/** A started task without acceptance criteria while an agent run holds it. */
export const Blocked: Story = {
  args: {
    activeRun: { status: 'loaded', value: true },
    task: { ...task, workflowStatusId: 'active', statusCategory: 'started', acceptanceCriteria: [] },
  },
}

/** A Ready task that still has a blocker. */
export const AlreadyReadyWithBlocker: Story = {
  args: {
    task: { ...task, workflowStatusId: 'ready', statusCategory: 'unstarted', relationIds: ['blockedBy:other'] },
  },
}
