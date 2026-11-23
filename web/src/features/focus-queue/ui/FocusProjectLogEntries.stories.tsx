import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { focusProjectLogEntriesFixture } from '../fixtures'
import { FocusProjectLogEntries } from './FocusProjectLogEntries'

const meta = {
  title: 'Application/Focus/FocusProjectLogEntries',
  component: FocusProjectLogEntries,
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl bg-[var(--workbench-canvas)] p-5"><Story /></div></MemoryRouter>],
  args: {
    entries: focusProjectLogEntriesFixture,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof FocusProjectLogEntries>

/** Metadata for the risks, issues, and change requests the viewer owns in Focus. */
export default meta
/** Story type for the owned Project log entries. */
type Story = StoryObj<typeof meta>

/** Overdue risk and issue, a pending change request, a long title, and a Project without a title. */
export const OverdueAndPending: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'Your risks, issues, and change requests' })).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Move the launch by one week' })).toHaveAttribute(
      'href',
      '/projects/brand-refresh/issues?teamId=design-team&tab=permissions',
    )
    await expect(canvas.getAllByText('Review overdue')).toHaveLength(2)
    await expect(canvas.getByText('Decision pending')).toBeVisible()
  },
}

/** Japanese labels at phone width. */
export const JapaneseMobile: Story = {
  args: { t: createTranslator('ja') },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** Nothing the viewer owns needs attention, so the panel renders nothing. */
export const NothingToReview: Story = { args: { entries: [] } }
