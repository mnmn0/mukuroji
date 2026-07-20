import type { Meta, StoryObj } from '@storybook/react-vite'
import { requestSubmissionFixture } from '../fixtures'
import { normalizeRequestSubmission } from '../model/requestForm'
import { RequestQueue } from './RequestQueue'

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
