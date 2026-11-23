import type { Meta, StoryObj } from '@storybook/react-vite'
import { SWRConfig } from 'swr'
import { expect, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { projectStatusReportFixture, projectStatusShareFixtures } from '../fixtures'
import { ProjectStatusReportDialog } from './ProjectStatusReportDialog'

/**
 * Replaces `fetch` for one story with answers to the share list, the customers, and the PDF.
 *
 * @param answer - Builds the response of each request from its path.
 * @returns A function that restores the original `fetch`.
 */
function installStoryFetch(answer: (path: string) => Response) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return answer(new URL(url, window.location.origin).pathname)
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

/**
 * Answers the share list with the fixtures, the customers with 403, and the PDF with an error.
 *
 * @param path - Request path.
 * @returns The response.
 */
function memberAnswer(path: string) {
  if (path.endsWith('/status-shares')) return Response.json({ shares: projectStatusShareFixtures })
  if (path.endsWith('/status-report/pdf')) return Response.json({ code: 'StorageFailure', message: 'Failed.' }, { status: 502 })
  return Response.json({ code: 'Forbidden', message: 'Forbidden.' }, { status: 403 })
}

/** Status report dialog opened from the Project overview. */
const meta = {
  title: 'Application/Projects/Status Report/Dialog',
  component: ProjectStatusReportDialog,
  args: {
    accessToken: 'storybook-token',
    teamId: 'core-team',
    projectId: 'refero',
    report: projectStatusReportFixture,
    t: createTranslator('ja'),
    onClose: () => undefined,
  },
  decorators: [
    (Story) => (
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <Story />
      </SWRConfig>
    ),
  ],
  parameters: { layout: 'fullscreen' },
  beforeEach: () => installStoryFetch(memberAnswer),
} satisfies Meta<typeof ProjectStatusReportDialog>

export default meta

/** Stories of the report dialog. */
type Story = StoryObj<typeof meta>

/** A Project member sees the exports, the preview, and the share links. */
export const Member: Story = {
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByTestId('project-status-share-list')
    await expect(list).toHaveTextContent('顧客A 定例')
    await expect(list).toHaveTextContent('失効')
  },
}

/** The dialog on a phone stacks the share form under the preview. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** A viewer can export but cannot manage share links. */
export const Viewer: Story = {
  beforeEach: () => installStoryFetch(() => Response.json({ code: 'Forbidden', message: 'Forbidden.' }, { status: 403 })),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByTestId('project-status-share-forbidden')).toBeVisible()
  },
}

/** A failed share list offers a retry. */
export const ShareListFailed: Story = {
  beforeEach: () => installStoryFetch(() => Response.json({ code: 'Unavailable', message: 'Unavailable.' }, { status: 503 })),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByTestId('project-status-share-retry')).toBeEnabled()
  },
}

/** The report waits for the overview data. */
export const Loading: Story = {
  args: { report: undefined },
}

/** A failed PDF export shows an error and leaves the other formats available. */
export const ExportFailed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-status-report-export-pdf'))
    await expect(await canvas.findByText(createTranslator('ja')('projects.statusReport.error.export'))).toBeVisible()
  },
}
