import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeRateCardPanel } from './TimeRateCardPanel'

/** Metadata of the rate card stories. */
const meta = {
  title: 'Application/Time Tracking/Rate Card Panel',
  component: TimeRateCardPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    jobRoles: [
      { id: 'role-engineer', name: 'エンジニア' },
      { id: 'role-designer', name: 'デザイナー' },
    ],
    members: [
      { id: 'member-aoi', name: '青井 葵' },
      { id: 'member-ren', name: '佐藤 蓮' },
    ],
    rateCard: {
      schemaVersion: 1,
      workspaceId: 'workspace-demo',
      teamId: 'core-team',
      currency: 'JPY',
      memberRates: [
        { userId: 'member-aoi', jobRoleId: 'role-engineer' },
        { userId: 'member-ren', hourlyRateMinor: 9_000, jobRoleId: 'role-designer' },
      ],
      jobRoleRates: [
        { jobRoleId: 'role-engineer', hourlyRateMinor: 6_000 },
        { jobRoleId: 'role-designer', hourlyRateMinor: 5_500 },
      ],
      revision: 2,
    },
    onRetry: fn(),
    onSave: fn(async () => undefined),
  },
} satisfies Meta<typeof TimeRateCardPanel>

export default meta
/** Typed rate card story. */
type Story = StoryObj<typeof meta>

/** A manager of the whole Team edits a rate and saves the whole card. */
export const Saved: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const rate = canvas.getByLabelText('エンジニア 時間単価')
    await userEvent.clear(rate)
    await userEvent.type(rate, '6500')
    await userEvent.click(canvas.getByRole('button', { name: '単価表を保存' }))
    await expect(args.onSave).toHaveBeenCalledWith({
      currency: 'JPY',
      memberRates: [
        { userId: 'member-aoi', jobRoleId: 'role-engineer' },
        { userId: 'member-ren', hourlyRateMinor: 9_000, jobRoleId: 'role-designer' },
      ],
      jobRoleRates: [
        { jobRoleId: 'role-engineer', hourlyRateMinor: 6_500 },
        { jobRoleId: 'role-designer', hourlyRateMinor: 5_500 },
      ],
      expectedRevision: 2,
    })
  },
}

/** A Team without job roles or a saved card. */
export const Empty: Story = {
  args: {
    jobRoles: [],
    rateCard: {
      schemaVersion: 1,
      workspaceId: 'workspace-demo',
      teamId: 'core-team',
      currency: 'JPY',
      memberRates: [],
      jobRoleRates: [],
      revision: 0,
    },
  },
}

/** The card could not be read. */
export const LoadError: Story = {
  args: {
    hasLoadError: true,
    rateCard: undefined,
  },
}
