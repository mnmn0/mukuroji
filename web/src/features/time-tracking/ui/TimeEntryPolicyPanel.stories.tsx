import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DEFAULT_TEAM_TIME_ENTRY_POLICY } from '@mukuroji/contracts'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeEntryPolicyPanel } from './TimeEntryPolicyPanel'

const t = createTranslator('ja')

const meta = {
  title: 'Application/Time Tracking/Entry Policy Panel',
  component: TimeEntryPolicyPanel,
  args: {
    t,
    view: { policy: { ...DEFAULT_TEAM_TIME_ENTRY_POLICY, teamId: 'team-1', revision: 0 }, canEdit: true },
    onSave: fn(async () => undefined),
    onRetry: fn(),
  },
} satisfies Meta<typeof TimeEntryPolicyPanel>

/** Team checks on overlapping time and the daily total, in the time report view. */
export default meta

/** Story variants for the check panel. */
type Story = StoryObj<typeof meta>

/** A manager turns on both checks with a 7.5-hour day. */
export const Manager: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText(t('timeTracking.policy.overlap')), 'reject')
    await userEvent.selectOptions(canvas.getByLabelText(t('timeTracking.policy.dailyLimit')), 'warn')
    const hours = canvas.getByLabelText(t('timeTracking.policy.dailyLimitHours'))
    await userEvent.clear(hours)
    await userEvent.type(hours, '7.5')
    await userEvent.click(canvas.getByRole('button', { name: t('timeTracking.policy.save') }))
    await expect(args.onSave).toHaveBeenCalledWith({ overlap: 'reject', dailyLimit: 'warn', dailyLimitMinutes: 450, expectedRevision: 0 })
    await expect(await canvas.findByText(t('timeTracking.policy.saved'))).toBeInTheDocument()
  },
}

/** A member who does not manage the whole Team sees the checks without changing them. */
export const ReadOnly: Story = {
  args: {
    view: {
      policy: { overlap: 'warn', dailyLimit: 'reject', dailyLimitMinutes: 600, teamId: 'team-1', revision: 2, updatedAt: '2026-11-20T00:00:00.000Z' },
      canEdit: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText(t('timeTracking.policy.overlap'))).toBeDisabled()
    await expect(canvas.queryByRole('button', { name: t('timeTracking.policy.save') })).not.toBeInTheDocument()
  },
}

/** The read failed. */
export const LoadError: Story = {
  args: { hasLoadError: true },
}
