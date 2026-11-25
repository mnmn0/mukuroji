import type { Meta, StoryObj } from '@storybook/react-vite'
import { projectDeliverablesControllerFixture } from '../fixtures'
import { ProjectDeliverablesPanel } from './ProjectDeliverablesPanel'

const meta = {
  title: 'Application/Files/Project Deliverables Panel',
  component: ProjectDeliverablesPanel,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="workbench-shell max-w-[1080px]">
        <Story />
      </div>
    ),
  ],
  args: {
    controller: projectDeliverablesControllerFixture,
    exportFileName: 'refero-deliverables',
    locale: 'ja',
    onDownloadCsv: () => undefined,
  },
} satisfies Meta<typeof ProjectDeliverablesPanel>

/**
 * ProjectDeliverablesPanel の Storybook metadata です。
 */
export default meta

/**
 * ProjectDeliverablesPanel Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Project と Work Item の成果物が混在する一覧です。
 */
export const Default: Story = {}

/**
 * 未承認だけに絞り込んだ一覧です。
 */
export const Unapproved: Story = {
  args: {
    controller: {
      ...projectDeliverablesControllerFixture,
      deliverables: projectDeliverablesControllerFixture.deliverables
        .filter((deliverable) => deliverable.approvalState !== 'approved'),
      filters: { approval: 'unapproved', unresolvedOnly: false },
      hasMore: false,
    },
  },
}

/**
 * 条件に合う成果物がない一覧です。
 */
export const Empty: Story = {
  args: {
    controller: {
      ...projectDeliverablesControllerFixture,
      deliverables: [],
      hasMore: false,
    },
  },
}

/**
 * 取得に失敗した一覧です。
 */
export const LoadError: Story = {
  args: {
    controller: {
      ...projectDeliverablesControllerFixture,
      deliverables: [],
      hasError: true,
      hasMore: false,
    },
  },
}
