import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, userEvent, within } from 'storybook/test'
import { projectStatusReportFixture } from '../fixtures'
import { SharedProjectStatusReportScreen } from './SharedProjectStatusReportScreen'

/** Read-only page a share link opens for people outside the Workspace. */
const meta = {
  title: 'Application/Projects/Status Report/Public Share',
  component: SharedProjectStatusReportScreen,
  args: {
    locale: 'ja',
    published: { report: projectStatusReportFixture, expiresAt: '2026-12-07T03:00:00.000Z' },
    onDownloadPdf: async () => undefined,
  },
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <MemoryRouter>
      <SharedProjectStatusReportScreen {...args} />
    </MemoryRouter>
  ),
} satisfies Meta<typeof SharedProjectStatusReportScreen>

export default meta

/** Stories of the public report page. */
type Story = StoryObj<typeof meta>

/** Report with every section. */
export const Page: Story = {}

/** Header controls wrap on a phone. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** The report is loading. */
export const Loading: Story = {
  args: { isLoading: true, published: undefined },
}

/** A revoked, expired, or unknown link shows the same message. */
export const Unavailable: Story = {
  args: { isUnavailable: true, published: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('shared-project-status-unavailable')).toBeVisible()
  },
}

/** A failed PDF download says so and points to printing. */
export const DownloadFailed: Story = {
  args: {
    onDownloadPdf: async () => {
      throw new Error('PDF unavailable')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'PDF をダウンロード' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('印刷から PDF に保存してください')
  },
}
