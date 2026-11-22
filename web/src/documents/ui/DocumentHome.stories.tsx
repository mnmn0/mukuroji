import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { documentSummaryFixtures } from '../fixtures'
import type { MarkdownFolderImportFailure } from '../model/markdownFolderImport'
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
    onImportMarkdown: fn(async () => undefined),
    onImportMarkdownFolder: fn(
      async (): Promise<MarkdownFolderImportFailure | undefined> => undefined,
    ),
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
 * Pasted Markdown becomes a page in the chosen Project.
 */
export const MarkdownImport: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText('取り込み先 Project'), 'refero')
    await userEvent.type(canvas.getByLabelText('Markdown'), '# 設計書')
    await userEvent.click(canvas.getByRole('button', { name: 'ページを作成' }))
    await expect(args.onImportMarkdown).toHaveBeenCalledWith({
      fallbackTitle: '取り込んだページ',
      projectId: 'refero',
      source: '# 設計書',
    })
  },
}

/**
 * Builds a file as a folder picker reports it, with its path inside the
 * chosen folder.
 *
 * @param path - Path inside the chosen folder, starting with the folder name.
 * @param text - File contents.
 * @returns The file with `webkitRelativePath` set.
 */
function folderFile(path: string, text: string): File {
  const file = new File([text], path.split('/').at(-1) ?? path, { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

/**
 * A chosen folder's Markdown files are imported with their paths; other files
 * are skipped.
 */
export const MarkdownFolderImport: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.upload(canvas.getByLabelText('フォルダごと取り込む'), [
      folderFile('docs/README.md', '# Docs\n\n[Setup](guide/setup.md)'),
      folderFile('docs/guide/setup.md', '# Setup'),
      folderFile('docs/logo.png', 'png'),
    ])
    await expect(
      await canvas.findByText('docs の Markdown 2 件を読み込みました。'),
    ).toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: 'フォルダを取り込む' }))
    await expect(args.onImportMarkdownFolder).toHaveBeenCalledWith({
      files: [
        { path: 'docs/README.md', source: '# Docs\n\n[Setup](guide/setup.md)' },
        { path: 'docs/guide/setup.md', source: '# Setup' },
      ],
    })
  },
}

/**
 * A file that cannot become a page is named in the error, and nothing is
 * created.
 */
export const MarkdownFolderImportError: Story = {
  args: {
    onImportMarkdownFolder: fn(
      async (): Promise<MarkdownFolderImportFailure | undefined> => ({
        code: 'empty',
        path: 'docs/empty.md',
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.upload(canvas.getByLabelText('フォルダごと取り込む'), [
      folderFile('docs/empty.md', ' '),
    ])
    await userEvent.click(
      await canvas.findByRole('button', { name: 'フォルダを取り込む' }),
    )
    await expect(
      await canvas.findByText('docs/empty.md: Markdown が空です。'),
    ).toBeInTheDocument()
  },
}

/**
 * While an import is running, both import buttons show the pending label and
 * are disabled.
 */
export const MarkdownImporting: Story = {
  args: {
    isImportingMarkdown: true,
  },
}

/**
 * Members who cannot create Documents do not see the bundled templates.
 */
export const ReadOnly: Story = {
  args: {
    onCreateDocument: undefined,
    onCreateFromBuiltInTemplate: undefined,
    onImportMarkdown: undefined,
    onImportMarkdownFolder: undefined,
    onInstantiateTemplate: undefined,
  },
}
