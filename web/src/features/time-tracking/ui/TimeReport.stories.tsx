import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { timeTrackingFixtureMemberNames } from '../fixtures'
import {
  timeReportFixtureBudgetSummary,
  timeReportFixtureManagerSummary,
  timeReportFixtureMemberSummary,
  timeReportFixtureProjects,
  timeReportFixtureRange,
} from '../reportFixtures'
import { TimeBudgetPanel } from './TimeBudgetPanel'
import { TimeReport, type TimeReportProps } from './TimeReport'
import { createTimeTrackingFormatters } from './timeTrackingText'

/**
 * Report and budget panel as the time tracking page stacks them.
 *
 * @param props - Report props, plus whether the budget panel is shown.
 * @returns Report view.
 */
function TimeReportView(props: TimeReportProps & {
  /** Whether the member may see budgets. */
  showBudget: boolean
  /** First month of the Workspace fiscal year offered to the budget editor. */
  fiscalYearStartMonth?: number
}) {
  const { fiscalYearStartMonth, showBudget, ...reportProps } = props
  return (
    <div className="grid min-w-0 gap-6">
      <TimeReport {...reportProps} />
      {showBudget ? (
        <TimeBudgetPanel
          defaultCurrency="JPY"
          fiscalYearStartMonth={fiscalYearStartMonth}
          locale={reportProps.locale}
          onChangeScope={fn()}
          onRetry={fn()}
          onSave={fn(async () => undefined)}
          onUseBudgetPeriod={fn()}
          projects={timeReportFixtureProjects}
          scope={{ scopeType: 'team' }}
          summary={timeReportFixtureBudgetSummary}
          t={reportProps.t}
        />
      ) : null}
    </div>
  )
}

/**
 * Budget panel whose first save fails because another manager changed the budget period.
 *
 * @param props - Translator and locale of the panel.
 * @returns Budget panel that swaps in the newer budget on a conflict.
 */
function BudgetRevisionConflictView(props: Pick<TimeReportProps, 'locale' | 't'>) {
  const [summary, setSummary] = useState(timeReportFixtureBudgetSummary)
  /** Fails the first save and replaces the summary with the newer revision. */
  const save = async () => {
    const budget = summary.budget
    if (budget && budget.revision === timeReportFixtureBudgetSummary.budget?.revision) {
      setSummary({ ...summary, budget: { ...budget, periodFrom: '2026-10-01', periodTo: '2027-03-31', revision: budget.revision + 1 } })
      throw new Error('conflict')
    }
  }
  return (
    <TimeBudgetPanel
      defaultCurrency="JPY"
      fiscalYearStartMonth={4}
      locale={props.locale}
      onChangeScope={fn()}
      onRetry={fn()}
      onSave={save}
      onUseBudgetPeriod={fn()}
      projects={timeReportFixtureProjects}
      scope={{ scopeType: 'team' }}
      summary={summary}
      t={props.t}
    />
  )
}

/** Metadata of the time report stories. */
const meta = {
  title: 'Application/Time Tracking/Report',
  component: TimeReportView,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    locale: 'ja',
    formatters: createTimeTrackingFormatters('ja'),
    range: timeReportFixtureRange,
    groupBy: 'user',
    summary: timeReportFixtureManagerSummary,
    labels: {
      members: timeTrackingFixtureMemberNames,
      projects: Object.fromEntries(timeReportFixtureProjects.map((project) => [project.id, project.name])),
      workItems: {},
    },
    showBudget: true,
    onChangeRange: fn(),
    onChangeGroupBy: fn(),
    onRetry: fn(),
    onDownloadCsv: fn(async () => undefined),
  },
} satisfies Meta<typeof TimeReportView>

export default meta
/** Typed time report story. */
type Story = StoryObj<typeof meta>

/** A Team manager sees costs and the budget next to the actual cost. */
export const Manager: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('columnheader', { name: '実績コスト' })).toBeVisible()
    await expect(canvas.getByRole('heading', { name: '予算と実績' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'CSV をダウンロード' })).toBeEnabled()
  },
}

/** A member without cost access sees hours only, with no cost column and no budget. */
export const Member: Story = {
  args: { summary: timeReportFixtureMemberSummary, showBudget: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole('columnheader', { name: '実績コスト' })).toBeNull()
    await expect(canvas.queryByRole('heading', { name: '予算と実績' })).toBeNull()
  },
}

/**
 * Budget editor in a Workspace whose fiscal year starts in April: picking a fiscal year fills the
 * budget period with its first and last day.
 */
export const FiscalYearBudgetPeriod: Story = {
  args: { fiscalYearStartMonth: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '予算を編集' }))
    const select = canvas.getByTestId('time-budget-fiscal-year-select')
    const fiscalYear = canvas.getAllByRole('option').find((option) => option.textContent?.startsWith('2026年度'))
    await expect(fiscalYear).toBeDefined()
    await userEvent.selectOptions(select, '2026')
    await expect(canvas.getByLabelText('期間の開始日（任意）')).toHaveValue('2026-04-01')
    await expect(canvas.getByLabelText('期間の終了日（任意）')).toHaveValue('2027-03-31')
  },
}

/** A revision conflict while editing loads the other manager's period into the form. */
export const BudgetPeriodAfterRevisionConflict: Story = {
  render: (args) => <BudgetRevisionConflictView locale={args.locale} t={args.t} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '予算を編集' }))
    await userEvent.selectOptions(canvas.getByTestId('time-budget-fiscal-year-select'), '2026')
    await userEvent.click(canvas.getByRole('button', { name: '予算を保存' }))
    await expect(await canvas.findByLabelText('期間の開始日（任意）')).toHaveValue('2026-10-01')
    await expect(canvas.getByLabelText('期間の終了日（任意）')).toHaveValue('2027-03-31')
  },
}

/** Phone width. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
