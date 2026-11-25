import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { focusUpdateReviewsFixture } from '../fixtures'
import { FocusUpdateReviews } from './FocusUpdateReviews'

const meta = {
  title: 'Application/Focus/FocusUpdateReviews',
  component: FocusUpdateReviews,
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl bg-[var(--workbench-canvas)] p-5"><Story /></div></MemoryRouter>],
  args: {
    reviews: focusUpdateReviewsFixture,
    locale: 'en',
    t: createTranslator('en'),
  },
} satisfies Meta<typeof FocusUpdateReviews>

/** Metadata for the health updates waiting for the viewer's acknowledgement. */
export default meta
/** Story type for pending review states. */
type Story = StoryObj<typeof meta>

/** A Team update with a long summary and a Project update without a resolved title. */
export const PendingReviews: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'Health updates to review' })).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Core team' })).toHaveAttribute(
      'href',
      '/planning/portfolio?targetType=team&teamId=core-team',
    )
    await expect(canvas.getByRole('link', { name: 'Project health update' })).toBeVisible()
  },
}

/** Japanese labels at phone width. */
export const JapaneseMobile: Story = {
  args: { locale: 'ja', t: createTranslator('ja') },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** Nothing waits for review, so the panel renders nothing. */
export const NothingToReview: Story = { args: { reviews: [] } }
