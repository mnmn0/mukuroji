import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import type {
  AiAssistanceGeneration,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import type { AiAssistanceController } from '../../features/ai-assistance/mutations/useAiAssistanceController'
import { aiTriageGenerationFixture } from '../../features/ai-assistance/fixtures'
import { requestSubmissionFixture } from '../fixtures'
import { normalizeRequestSubmission } from '../model/requestForm'
import { RequestQueue, type RequestQueueProps } from './RequestQueue'

const normalizedSubmission = normalizeRequestSubmission(requestSubmissionFixture)

/**
 * Request queue の Storybook metadata です。
 */
const meta = {
  title: 'Application/Requests/Intake Queue',
  component: RequestQueue,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    hasMore: true,
    locale: 'ja',
    onAction: async () => undefined,
    onLoadMore: () => undefined,
    onOpenAttachment: async () => undefined,
    onSelectSubmission: () => undefined,
    selectedSubmission: normalizedSubmission,
    submissions: [normalizedSubmission],
  },
} satisfies Meta<typeof RequestQueue>

/**
 * Request queue の Storybook metadata です。
 */
export default meta

/**
 * Request queue story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Duplicate candidate、attachment、thread、action を含む triage 状態です。
 */
export const Default: Story = {}

const onAiConversionAction = fn(async () => undefined)
const onRequestAiGenerate = fn(async (input: GenerateAiAssistanceRequest) => {
  void input
  return aiTriageGenerationFixture
})

/** Request queue flow where AI adoption only prefills the existing conversion form. */
export const AiDraftAdoption: Story = {
  args: {
    locale: 'en',
    onAction: onAiConversionAction,
  },
  render: (args) => <AiRequestQueueStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onAiConversionAction.mockClear()
    onRequestAiGenerate.mockClear()

    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await expect(onRequestAiGenerate).toHaveBeenCalledWith({
      locale: 'en',
      source: {
        expectedRevision: normalizedSubmission.revision,
        formId: normalizedSubmission.formId,
        submissionId: normalizedSubmission.id,
        type: 'request-submission',
      },
      task: 'triage',
    })
    await expect(canvas.getByText('Unblock customer Workspace provisioning')).toBeVisible()
    await expect(onAiConversionAction).not.toHaveBeenCalled()

    await userEvent.click(canvas.getByRole('button', { name: 'Use in conversion form' }))
    await expect(canvas.getByRole('textbox', { name: 'Work Item title override' })).toHaveValue(
      'Unblock customer Workspace provisioning',
    )
    await expect(onAiConversionAction).not.toHaveBeenCalled()

    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }))
    await expect(onAiConversionAction).toHaveBeenCalledWith(
      normalizedSubmission.id,
      expect.objectContaining({
        action: 'convert',
        expectedRevision: normalizedSubmission.revision,
        title: 'Unblock customer Workspace provisioning',
      }),
    )
  },
}

/** Phone-width evidence review with full-width 44px actions and stacked panes. */
export const AiDraftMobile: Story = {
  args: {
    locale: 'en',
    onAction: onAiConversionAction,
  },
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
  render: (args) => <AiRequestQueueStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await expect(canvas.getByText('Unblock customer Workspace provisioning')).toBeVisible()
  },
}

const onStaleDecision = fn(async () => undefined)

/** A source revision change blocks adoption before a decision or conversion mutation. */
export const StaleAiDraft: Story = {
  args: {
    locale: 'en',
    onAction: onAiConversionAction,
  },
  render: (args) => <StaleAiRequestQueueStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onAiConversionAction.mockClear()
    onStaleDecision.mockClear()

    await userEvent.click(canvas.getByRole('button', { name: 'Generate draft' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Simulate source update' }))

    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'A source changed. Review the latest state before generating again.',
    )
    await expect(canvas.queryByText('Unblock customer Workspace provisioning')).not.toBeInTheDocument()
    await expect(canvas.queryByRole('button', { name: 'Use in conversion form' })).not.toBeInTheDocument()
    await expect(onStaleDecision).not.toHaveBeenCalled()
    await expect(onAiConversionAction).not.toHaveBeenCalled()
    await expect(canvas.queryByRole('textbox', { name: 'Work Item title override' })).not.toBeInTheDocument()
  },
}

/** Props used by the stateful AI adoption story harness. */
type AiRequestQueueStoryProps = RequestQueueProps

/** Supplies a deterministic AI controller without issuing network requests in Storybook. */
function AiRequestQueueStory(props: AiRequestQueueStoryProps) {
  const [generation, setGeneration] = useState<AiAssistanceGeneration>()
  const controller: AiAssistanceController = {
    cancelGeneration: () => undefined,
    decide: async (outcome) => {
      if (!generation) return undefined
      const decidedGeneration: AiAssistanceGeneration = {
        ...generation,
        decision: { decidedAt: '2026-08-25T01:16:00.000Z', outcome },
        revision: generation.revision + 1,
      }
      setGeneration(decidedGeneration)
      return decidedGeneration
    },
    feedbackRating: undefined,
    generate: async (input) => {
      const generated = await onRequestAiGenerate(input)
      setGeneration(generated)
      return generated
    },
    generation,
    isDecisionPending: false,
    isFeedbackPending: false,
    isGenerating: false,
    reset: () => setGeneration(undefined),
    sendFeedback: async () => undefined,
  }

  return <RequestQueue {...props} aiAssistanceController={controller} />
}

/** Keeps a generation mounted while the selected source revision advances. */
function StaleAiRequestQueueStory(props: AiRequestQueueStoryProps) {
  const [generation, setGeneration] = useState<AiAssistanceGeneration>()
  const [sourceRevision, setSourceRevision] = useState(normalizedSubmission.revision)
  const controller: AiAssistanceController = {
    cancelGeneration: () => undefined,
    decide: async () => {
      await onStaleDecision()
      return undefined
    },
    generate: async () => {
      setGeneration(aiTriageGenerationFixture)
      return aiTriageGenerationFixture
    },
    generation,
    isDecisionPending: false,
    isFeedbackPending: false,
    isGenerating: false,
    reset: () => setGeneration(undefined),
    sendFeedback: async () => undefined,
  }
  const selectedSubmission = { ...normalizedSubmission, revision: sourceRevision }

  return (
    <div className="grid gap-3">
      <button
        className="workbench-button-secondary min-h-11 w-fit px-4"
        onClick={() => setSourceRevision((current) => current + 1)}
        type="button"
      >
        Simulate source update
      </button>
      <RequestQueue
        {...props}
        aiAssistanceController={controller}
        selectedSubmission={selectedSubmission}
        submissions={[selectedSubmission]}
      />
    </div>
  )
}
