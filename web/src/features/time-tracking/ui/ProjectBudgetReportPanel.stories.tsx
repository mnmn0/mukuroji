import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { projectBudgetReportFixture } from '../reportFixtures'
import { ProjectBudgetReportPanel } from './ProjectBudgetReportPanel'

/** Metadata of the Project budget report stories. */
const meta = {
  title: 'Application/Time Tracking/Project Budget Report',
  component: ProjectBudgetReportPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    locale: 'ja',
    range: { from: projectBudgetReportFixture.from, to: projectBudgetReportFixture.to },
    report: projectBudgetReportFixture,
    budgetEditPath: '/teams/core-team/timesheet?view=report',
    renderLink: (path, children) => <a className="workbench-button-secondary inline-flex min-h-9 items-center px-3" href={path}>{children}</a>,
    onChangeRange: fn(),
    onExport: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof ProjectBudgetReportPanel>

export default meta

/** Story type of the Project budget report stories. */
type Story = StoryObj<typeof meta>

/** A Project behind schedule and slightly over cost. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('project-budget-spi')).toHaveTextContent('0.72')
    await expect(canvas.getByTestId('project-budget-cpi')).toHaveTextContent('0.92')
  },
}

/** A yen budget shows the coding agent cost in US dollars beside the actual cost (ADR 0119). */
export const WithAgentCost: Story = {
  args: {
    report: {
      ...projectBudgetReportFixture,
      agentCost: { status: 'separate-currency', estimatedCostMicroUsd: 80_000_000, runCount: 14, truncated: false },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('project-budget-agent-cost-separate')).toHaveTextContent('$80.00')
    await expect(canvas.getByTestId('project-budget-figures')).toHaveTextContent('468,000')
  },
}

/** A USD budget adds the coding agent cost to the actual cost; the read was cut at its limit. */
export const UsdBudgetWithAgentCost: Story = {
  args: {
    report: {
      ...projectBudgetReportFixture,
      agentCost: { status: 'included', estimatedCostMicroUsd: 80_000_000, amountMinor: 8_000, runCount: 14, truncated: true },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('project-budget-figures')).toHaveTextContent('coding agent')
  },
}

/** A Project without a budget or baseline yet. */
export const WithoutBudgetOrBaseline: Story = {
  args: {
    report: {
      ...projectBudgetReportFixture,
      budget: null,
      baseline: null,
      earnedValue: null,
      actualCostByCurrency: {},
      budgetConsumedPercent: undefined,
      effortConsumedPercent: undefined,
      points: projectBudgetReportFixture.points.map((point) => ({
        date: point.date,
        endDate: point.endDate,
        plannedValueMinutes: 0,
        ...(point.actualMinutes === undefined ? {} : { actualMinutes: point.actualMinutes }),
      })),
    },
  },
}

/** English labels. */
export const English: Story = {
  args: { t: createTranslator('en'), locale: 'en' },
}

/** A failed read with a retry. */
export const LoadError: Story = {
  args: { report: undefined, hasLoadError: true },
}
