import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { documentSummaryFixtures } from '../fixtures'
import { DocumentHome } from './DocumentHome'

/**
 * Documents home の Storybook metadata です。
 */
const meta = {
  title: 'Application/Documents/Home',
  component: DocumentHome,
  args: {
    documents: documentSummaryFixtures,
    onCreateDocument: fn(),
    onCreateFromBuiltInTemplate: fn(),
    onInstantiateTemplate: fn(),
    onSelectDocument: fn(),
    t: createTranslator('ja'),
    teams: projectDirectoryFixtures,
  },
} satisfies Meta<typeof DocumentHome>

/**
 * Documents home の Storybook metadata です。
 */
export default meta

/**
 * Documents home stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Bundled meeting notes, design doc, and retrospective templates with the
 * Project and participants substituted into the new page.
 */
export const BundledTemplates: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText('Project'), 'refero')
    await userEvent.type(canvas.getByLabelText('参加者'), '山田、佐藤')
    await userEvent.click(canvas.getByRole('button', { name: /議事録/ }))
    await expect(args.onCreateFromBuiltInTemplate).toHaveBeenCalledWith(
      'meeting-notes',
      {
        participants: ['山田', '佐藤'],
        projectId: 'refero',
        projectName: 'Refero',
      },
    )
  },
}

/**
 * Members who cannot create Documents do not see the bundled templates.
 */
export const ReadOnly: Story = {
  args: {
    onCreateDocument: undefined,
    onCreateFromBuiltInTemplate: undefined,
    onInstantiateTemplate: undefined,
  },
}
