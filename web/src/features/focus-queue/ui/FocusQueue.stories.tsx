import type { FocusQueueResponse } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  focusConfigurationFixture,
  focusQueueResponseFixture,
} from '../fixtures'
import { FocusQueue } from './FocusQueue'

const openItem = fn()
const snoozeItem = fn(async () => undefined)

const emptyFocusResponse: FocusQueueResponse = {
  ...focusQueueResponseFixture,
  sections: focusQueueResponseFixture.sections.map((group) => ({
    ...group,
    items: [],
  })),
}

/** Storybook metadata for the researched single-column Focus queue. */
const meta = {
  args: {
    configurationsByTeam: { 'core-team': focusConfigurationFixture },
    locale: 'en',
    onAssignToViewer: async () => undefined,
    onComplete: async () => undefined,
    onOpenItem: openItem,
    onOpenSource: () => undefined,
    onRetry: () => undefined,
    onSectionChange: () => undefined,
    onSnooze: snoozeItem,
    onStatusChange: async () => undefined,
    onWatchingChange: async () => undefined,
    response: focusQueueResponseFixture,
    section: 'now',
    t: createTranslator('en'),
  },
  component: FocusQueue,
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-5xl"><Story /></div>
      </main>
    ),
  ],
  parameters: { layout: 'fullscreen' },
  title: 'Application/Focus/Queue',
} satisfies Meta<typeof FocusQueue>

export default meta

/** Story type derived from the Focus queue metadata. */
type Story = StoryObj<typeof meta>

/** Dense server-ranked Now section with selected evidence and inline actions. */
export const Now: Story = {}

/** Waiting section with a visible non-actionable reason. */
export const Waiting: Story = {
  args: { section: 'waiting' },
}

/** Initial queue skeleton preserving the eventual row rhythm. */
export const Loading: Story = {
  args: { isLoading: true, response: undefined },
}

/** Retryable query failure contained within the Focus surface. */
export const ErrorState: Story = {
  args: { hasError: true, response: undefined },
}

/** Section-specific empty result after permission filtering and signal resolution. */
export const Empty: Story = {
  args: { response: emptyFocusResponse },
}

/** Mobile queue keeps every contextual action at least 44px tall. */
export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

/** J/K, arrows, Home/End, and Enter follow stable server order. */
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const firstRow = canvas.getByRole('button', {
      name: /Unblock the release approval flow/u,
    })
    const secondRow = canvas.getByRole('button', {
      name: /Answer the enterprise rollout question/u,
    })

    firstRow.focus()
    await userEvent.keyboard('j')
    await expect(secondRow).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await expect(firstRow).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect(secondRow).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect(openItem).toHaveBeenCalled()
  },
}

/** Snooze uses a preset, explicit confirmation, and the route-owned mutation callback. */
export const SnoozeFlow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Snooze' }))
    await userEvent.selectOptions(canvas.getByLabelText('Show again'), 'next-week')
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm' }))
    await expect(snoozeItem).toHaveBeenCalled()
  },
}
