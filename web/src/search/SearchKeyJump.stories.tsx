import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../shared/i18n/i18n'
import { SearchKeyJump } from './SearchKeyJump'

const meta = {
  title: 'Application/Search/Key Jump',
  component: SearchKeyJump,
  args: {
    keyword: 'PT-12',
    t: createTranslator('ja'),
  },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
} satisfies Meta<typeof SearchKeyJump>

/** Link that opens a Work Item when the search keyword is exactly its key. */
export default meta

/** Story variants for keywords that are and are not keys. */
type Story = StoryObj<typeof meta>

/** A keyword that is exactly a key offers to open that Work Item. */
export const ExactKey: Story = {
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'PT-12 を開く' })
    await expect(link).toHaveAttribute('href', '/browse/PT-12')
  },
}

/** Lower case and surrounding spaces are read as the same key. */
export const LowerCaseKey: Story = {
  args: { keyword: '  pt-12 ' },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'PT-12 を開く' })
    await expect(link).toHaveAttribute('href', '/browse/PT-12')
  },
}

/** A keyword that is not one key shows nothing. */
export const NotAKey: Story = {
  args: { keyword: 'PT-12 login bug' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('link')).toBeNull()
  },
}

/** English label. */
export const English: Story = {
  args: { t: createTranslator('en') },
}
