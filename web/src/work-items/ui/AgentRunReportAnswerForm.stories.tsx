import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import type { AgentRunReportAnswerResult } from '../mutations/useAnswerAgentRunReport'
import { AgentRunReportAnswerForm } from './AgentRunReportAnswerForm'
import { createAgentRunReportChipsLabels } from './agentRunReportLabels'

/** Answer text of the stories. */
const labels = createAgentRunReportChipsLabels('en').answer

/**
 * Creates a send action that ends the same way for every answer; an empty one fails, as the server refuses it.
 *
 * @param result - How every non-empty answer ends.
 * @returns Spy send action.
 */
function answerWith(result: AgentRunReportAnswerResult) {
  return fn(async (body: string): Promise<AgentRunReportAnswerResult> => (body === '' ? 'failed' : result))
}

/** Metadata of the answer form stories. */
const meta = {
  title: 'Application/Work Items/Agent Run Report Answer Form',
  component: AgentRunReportAnswerForm,
  parameters: {
    layout: 'padded',
  },
  args: {
    labels,
    onAnswer: answerWith('saved'),
  },
} satisfies Meta<typeof AgentRunReportAnswerForm>

export default meta

/** Story type of the answer form. */
type Story = StoryObj<typeof meta>

/** Opens the form, sends a trimmed answer, and closes once it is saved. */
export const Saved: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: labels.open }))
    await userEvent.type(canvas.getByRole('textbox', { name: labels.label }), '  Use the staging bucket.  ')
    await userEvent.click(canvas.getByRole('button', { name: labels.submit }))
    await expect(args.onAnswer).toHaveBeenCalledWith('Use the staging bucket.')
    await waitFor(() => expect(canvas.queryByRole('form', { name: labels.label })).toBeNull())
    await expect(canvas.getByRole('button', { name: labels.open })).toBeVisible()
  },
}

/** Someone answered first; the form keeps the text and says so. */
export const Conflict: Story = {
  args: { onAnswer: answerWith('conflict') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: labels.open }))
    await userEvent.type(canvas.getByRole('textbox', { name: labels.label }), 'Go ahead.')
    await userEvent.click(canvas.getByRole('button', { name: labels.submit }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent(labels.conflict)
    await expect(canvas.getByRole('textbox', { name: labels.label })).toHaveValue('Go ahead.')
  },
}

/** The answer could not be sent; the text stays so it can be sent again. */
export const Failed: Story = {
  args: { onAnswer: answerWith('failed') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: labels.open }))
    await userEvent.type(canvas.getByRole('textbox', { name: labels.label }), 'Go ahead.')
    await userEvent.click(canvas.getByRole('button', { name: labels.submit }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent(labels.failed)
    await expect(canvas.getByRole('button', { name: labels.submit })).toBeEnabled()
  },
}

/** Japanese text, with the form open. */
export const Japanese: Story = {
  args: { labels: createAgentRunReportChipsLabels('ja').answer },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: createAgentRunReportChipsLabels('ja').answer.open }))
  },
}
