import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { SearchCountReport } from './SearchCountReport'

const loadedResults = [
  {
    entityType: 'work-item',
    highlights: [],
    id: 'launch-accessibility',
    teamId: 'core-team',
    title: 'Launch accessibility review',
    url: '/work-items/launch-accessibility',
  },
  {
    entityType: 'work-item',
    highlights: [],
    id: 'launch-readiness',
    teamId: 'core-team',
    title: 'Launch readiness',
    url: '/work-items/launch-readiness',
  },
  {
    entityType: 'document',
    highlights: [],
    id: 'launch-notes',
    teamId: 'design-team',
    title: 'Launch notes',
    url: '/documents/launch-notes',
  },
] satisfies WorkspaceSearchResult[]

/** Storybook metadata for the approved bounded Search report result. */
const meta = {
  title: 'Application/Search/Approved Count Report',
  component: SearchCountReport,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <div className="mx-auto max-w-4xl">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    groupBy: 'team',
    hasMore: true,
    results: loadedResults,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof SearchCountReport>

export default meta

/** Story type for the approved Search count report. */
type Story = StoryObj<typeof meta>

/** Cursor-backed report explicitly limits counts to the currently loaded result pages. */
export const PartialGroupedCount: Story = {}

/** Mobile report retains readable count buckets and the bounded-results notice. */
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
}

/** Complete response omits the partial-results notice. */
export const CompleteCount: Story = {
  args: { groupBy: undefined, hasMore: false },
}
