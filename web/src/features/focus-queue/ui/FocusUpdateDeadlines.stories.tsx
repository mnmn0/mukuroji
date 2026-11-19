import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { focusUpdateDeadlinesFixture } from '../fixtures'
import { FocusUpdateDeadlines } from './FocusUpdateDeadlines'

const meta = {
  title: 'Application/Focus/FocusUpdateDeadlines',
  component: FocusUpdateDeadlines,
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl bg-[var(--workbench-canvas)] p-5"><Story /></div></MemoryRouter>],
  args: {
    deadlines: focusUpdateDeadlinesFixture,
    locale: 'en',
    t: createTranslator('en'),
  },
} satisfies Meta<typeof FocusUpdateDeadlines>

/** Metadata for the health update deadlines shown above the Focus queue. */
export default meta
/** Story type for health update deadline states. */
type Story = StoryObj<typeof meta>

/** Overdue and due-soon deadlines, a long title, and a Project without a resolved title. */
export const OverdueAndDueSoon: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'Health updates due' })).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Refero' })).toHaveAttribute(
      'href',
      '/planning/portfolio?targetType=project&teamId=core-team&projectId=refero',
    )
    await expect(canvas.getByRole('link', { name: 'Project health update' })).toBeVisible()
  },
}

/** Japanese labels at phone width. */
export const JapaneseMobile: Story = {
  args: { locale: 'ja', t: createTranslator('ja') },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** Nothing is due, so the panel renders nothing. */
export const NothingDue: Story = { args: { deadlines: [] } }
