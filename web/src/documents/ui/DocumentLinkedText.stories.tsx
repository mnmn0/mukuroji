import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { DocumentLinkedText } from './DocumentLinkedText'

/**
 * Storybook metadata for stored text with links to other pages.
 */
const meta = {
  title: 'Application/Documents/Linked text',
  component: DocumentLinkedText,
  args: {
    text: 'See [Setup](/documents/doc-setup) before [the site](https://example.com).',
  },
} satisfies Meta<typeof DocumentLinkedText>

/**
 * Storybook metadata for stored text with links to other pages.
 */
export default meta

/**
 * Linked text story type.
 */
type Story = StoryObj<typeof meta>

/**
 * A paragraph whose page link opens the page; other links stay as text.
 */
export const Paragraph: Story = {
  render: (args) => (
    <p className="m-0 whitespace-pre-wrap text-[1rem] font-medium leading-8 text-[var(--workbench-text)]">
      <DocumentLinkedText {...args} />
    </p>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = canvas.getByRole('link', { name: 'Setup' })
    await expect(link).toHaveAttribute('href', '/documents/doc-setup')
    link.focus()
    await expect(link).toHaveFocus()
    await expect(canvas.queryByRole('link', { name: 'the site' })).toBeNull()
  },
}

/**
 * Page links inside table cells and checklist items, as a folder import
 * writes them.
 */
export const TableAndChecklist: Story = {
  render: () => (
    <div className="grid gap-4">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="border px-3 py-2">Page</th>
            <th className="border px-3 py-2">Link</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border px-3 py-2">Guide</td>
            <td className="border px-3 py-2">
              <DocumentLinkedText text="[Guide](/documents/doc-guide)" />
            </td>
          </tr>
        </tbody>
      </table>
      <ul className="m-0 grid list-none gap-2 p-0 text-sm">
        <li className="flex gap-3">
          <span aria-hidden="true">☐</span>
          <span>
            <DocumentLinkedText text="Read [Usage](/documents/doc-usage)" />
          </span>
        </li>
      </ul>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: 'Guide' })).toHaveAttribute(
      'href',
      '/documents/doc-guide',
    )
    await expect(canvas.getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'href',
      '/documents/doc-usage',
    )
  },
}
