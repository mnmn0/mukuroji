import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS } from '@mukuroji/contracts'
import { createTranslator } from '../../../shared/i18n/i18n'
import { InvestmentAssignmentsPanel } from './InvestmentAssignmentsPanel'

/** Metadata of the investment category assignment stories. */
const meta = {
  title: 'Application/Time Tracking/Investment Assignments Panel',
  component: InvestmentAssignmentsPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    settings: DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS,
    projects: [
      { id: 'atlas', name: 'Atlas' },
      { id: 'refero', name: 'Refero' },
    ],
    workItems: [
      { id: 'wi-login', name: 'ログイン不具合の修正' },
      { id: 'wi-export', name: 'CSV 出力の追加' },
    ],
    view: {
      canEdit: true,
      assignments: { teamId: 'core-team', revision: 3, projects: { atlas: 'new-development' }, workItems: { 'wi-login': 'maintenance' } },
    },
    onRetry: fn(),
    onSave: fn(async () => undefined),
  },
} satisfies Meta<typeof InvestmentAssignmentsPanel>

export default meta
/** Typed assignment story. */
type Story = StoryObj<typeof meta>

/** A manager of the whole Team sets a Project default, adds a task override, and saves. */
export const Saved: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText('Refero 区分'), 'operations')
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'タスク' }), 'wi-export')
    await userEvent.click(canvas.getByRole('button', { name: '区分を追加' }))
    await userEvent.click(canvas.getByRole('button', { name: '区分を保存' }))
    await expect(args.onSave).toHaveBeenCalledWith({
      projects: { atlas: 'new-development', refero: 'operations' },
      workItems: { 'wi-login': 'maintenance', 'wi-export': 'new-development' },
      expectedRevision: 3,
    })
  },
}

/** A Team that has saved no assignments yet. */
export const Empty: Story = {
  args: {
    view: { canEdit: true, assignments: { teamId: 'core-team', revision: 0, projects: {}, workItems: {} } },
  },
}

/** The assignments could not be read. */
export const LoadError: Story = {
  args: { hasLoadError: true, view: undefined },
}

/** Phone width. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
