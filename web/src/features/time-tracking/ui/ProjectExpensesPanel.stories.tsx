import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { projectExpensesFixture } from '../reportFixtures'
import { ProjectExpensesPanel } from './ProjectExpensesPanel'

/** Metadata of the Project expenses stories. */
const meta = {
  title: 'Application/Time Tracking/Project Expenses',
  component: ProjectExpensesPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    locale: 'ja',
    defaultCurrency: 'JPY',
    today: '2026-11-26',
    expenses: projectExpensesFixture,
    viewerMemberId: 'aoi@example.com',
    onDecide: fn(async () => undefined),
    onDelete: fn(async () => undefined),
    onRetry: fn(),
    onSubmit: fn(async () => undefined),
  },
} satisfies Meta<typeof ProjectExpensesPanel>

export default meta

/** Story type of the Project expenses stories. */
type Story = StoryObj<typeof meta>

/** Approved, waiting, and rejected expenses, one of them the viewer's own. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByTestId('project-expense')).toHaveLength(3)
    await expect(canvas.getByText('ほかの Project マネージャーの承認待ち')).toBeInTheDocument()
  },
}

/** No expense yet. */
export const Empty: Story = {
  args: { expenses: [] },
}

/** English labels. */
export const English: Story = {
  args: { t: createTranslator('en'), locale: 'en' },
}

/** A failed read with a retry. */
export const LoadError: Story = {
  args: { expenses: undefined, hasLoadError: true },
}
