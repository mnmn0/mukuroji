import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../../../projects/fixtures'
import { createTranslator } from '../../../shared/i18n/i18n'
import { focusConfigurationFixture, focusQueueResponseFixture } from '../fixtures'
import { CollaborationQueue } from './CollaborationQueue'

const meta = {
  title: 'Application/Focus/CollaborationQueue',
  component: CollaborationQueue,
  decorators: [(Story) => <MemoryRouter><div className="mx-auto max-w-5xl bg-[var(--workbench-canvas)] p-5"><Story /></div></MemoryRouter>],
  args: {
    configurations: { 'core-team': focusConfigurationFixture },
    onOpenTask: fn(),
    response: focusQueueResponseFixture,
    teams: projectDirectoryFixtures,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof CollaborationQueue>

/** Metadata for the permission-filtered collaboration queue. */
export default meta
/** Story type for collaboration queue states. */
type Story = StoryObj<typeof meta>

/** Ranked work with stage, search and Team controls. */
export const RankedWork: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Needs attention 2' }))
    await expect(canvas.queryByRole('button', { name: 'Wait for legal approval' })).not.toBeInTheDocument()
    await userEvent.type(canvas.getByRole('searchbox'), 'enterprise')
    await expect(canvas.getByRole('button', { name: 'Answer the enterprise rollout question' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Answer the enterprise rollout question' }))
    await expect(args.onOpenTask).toHaveBeenCalled()
    await userEvent.selectOptions(canvas.getByRole('combobox'), 'design-team')
    await expect(canvas.getByText('No work matches these filters.')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Clear filters' }))
    await expect(canvas.getByRole('button', { name: 'Wait for legal approval' })).toBeVisible()
  },
}

/** Unavailable data never reports successful empty results. */
export const Unavailable: Story = { args: { unavailable: true } }
/** A successfully loaded snapshot with no work. */
export const Empty: Story = { args: { response: { ...focusQueueResponseFixture, sections: [] } } }
/** Japanese queue labels at phone width. */
export const JapaneseMobile: Story = { args: { t: createTranslator('ja') }, globals: { viewport: { value: 'mobile1', isRotated: false } } }
