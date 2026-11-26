import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemWebLinksPanel } from './WorkItemWebLinksPanel'

const t = createTranslator('en')

const meta = {
  title: 'Application/Work Items/Web Links',
  component: WorkItemWebLinksPanel,
  parameters: { layout: 'padded' },
  args: {
    canManage: true,
    t,
    links: [
      {
        id: '0'.repeat(31) + '1',
        url: 'https://github.com/example/mukuroji/pull/826',
        title: 'Pull request #826',
        createdByMemberId: 'member-1',
        createdAt: '2026-11-26T00:00:00.000Z',
      },
      {
        id: '0'.repeat(31) + '2',
        url: 'https://www.figma.com/file/example/design',
        createdByMemberId: 'member-1',
        createdAt: '2026-11-26T01:00:00.000Z',
      },
    ],
    onAdd: fn(async () => undefined),
    onRemove: fn(async () => undefined),
    onRetry: fn(),
  },
} satisfies Meta<typeof WorkItemWebLinksPanel>

export default meta

/** Story type of the web link panel. */
type Story = StoryObj<typeof meta>

/** Shows titled and untitled links and adds one with a normalized URL. */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: 'Pull request #826' })).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    await userEvent.click(canvas.getByRole('button', { name: 'Add link' }))
    await userEvent.type(canvas.getByRole('textbox', { name: 'URL' }), 'https://example.com/notes')
    await userEvent.click(canvas.getByRole('button', { name: 'Save link' }))
    await expect(args.onAdd).toHaveBeenCalledWith({ url: 'https://example.com/notes' })
  },
}

/** A Work Item without links. */
export const Empty: Story = {
  args: { links: [] },
}

/** A viewer sees the links without the add and remove buttons. */
export const ReadOnly: Story = {
  args: { canManage: false, onAdd: undefined, onRemove: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Read only')).toBeVisible()
    await expect(canvas.queryByRole('button', { name: 'Add link' })).toBeNull()
  },
}

/** The first read failed. */
export const LoadError: Story = {
  args: { links: [], hasLoadError: true },
}

/** A later read failed: the last links stay and the panel offers a retry. */
export const RefreshError: Story = {
  args: { hasRefreshError: true },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Links could not be refreshed. The list may be out of date.')).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Pull request #826' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Reload links' }))
    await expect(args.onRetry).toHaveBeenCalled()
  },
}
