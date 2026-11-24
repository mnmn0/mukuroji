import type { Meta, StoryObj } from '@storybook/react-vite'
import { SWRConfig } from 'swr'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { customerFixture } from '../../customers/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { projectStatusReportFixture, projectStatusShareFixtures } from '../fixtures'
import { ProjectStatusReportDialog } from './ProjectStatusReportDialog'

/**
 * Replaces `fetch` for one story with answers to the share list, the customers, and the PDF.
 *
 * @param answer - Builds the response of each request from its path and query.
 * @returns A function that restores the original `fetch`.
 */
function installStoryFetch(answer: (path: string, query: URLSearchParams) => Response) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    return answer(url.pathname, url.searchParams)
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

/** A failed customer read is shown with a retry instead of an empty recipient list. */
export const RecipientsFailed: Story = {
  beforeEach: () => installStoryFetch((path) => path.endsWith('/status-shares')
    ? Response.json({ shares: projectStatusShareFixtures })
    : Response.json({ code: 'Unavailable', message: 'Unavailable.' }, { status: 503 })),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByTestId('project-status-share-recipients-retry')).toBeEnabled()
  },
}

/** Customer shown on the second page of share recipients. */
const secondPageCustomer = { ...customerFixture, id: 'customer-second-page', name: '後半の顧客' }

/**
 * More customers than one page, for a member who may not search by name: the search is refused,
 * so the form hides it and reads the next page on request.
 */
export const ManyCustomers: Story = {
  beforeEach: () => installStoryFetch((path, query) => {
    if (path.endsWith('/status-shares')) return Response.json({ shares: projectStatusShareFixtures })
    if (path.endsWith('/customers')) {
      if (query.has('search')) {
        return Response.json({ code: 'CustomerSearchRestricted', message: 'Restricted.' }, { status: 403 })
      }
      return query.get('cursor') === 'next-page'
        ? Response.json({ customers: [secondPageCustomer] })
        : Response.json({ customers: [customerFixture], nextCursor: 'next-page' })
    }
    return Response.json({ code: 'Forbidden', message: 'Forbidden.' }, { status: 403 })
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByTestId('project-status-share-customer-search'), 'x')
    await waitFor(() => expect(canvas.queryByTestId('project-status-share-customer-search')).toBeNull())
    await userEvent.click(await canvas.findByTestId('project-status-share-customer-more'))
    await waitFor(() => expect(canvas.getByTestId('project-status-share-customer')).toHaveTextContent(secondPageCustomer.name))
    await expect(canvas.getByTestId('project-status-share-customer')).toHaveTextContent(customerFixture.name)
    await waitFor(() => expect(canvas.queryByTestId('project-status-share-customer-more')).toBeNull())
  },
}

/** The report waits for the overview data. */
export const Loading: Story = {
  args: { report: undefined },
}

/** A read the report needs failed, so export and sharing wait for a retry. */
export const LoadFailed: Story = {
  args: { report: undefined, hasReportError: true, onRetryReport: () => undefined },
}

/** A failed PDF export shows an error and leaves the other formats available. */
export const ExportFailed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-status-report-export-pdf'))
    await expect(await canvas.findByText(createTranslator('ja')('projects.statusReport.error.export'))).toBeVisible()
  },
}
