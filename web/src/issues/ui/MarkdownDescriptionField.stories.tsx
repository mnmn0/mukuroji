import type { Meta, StoryObj } from '@storybook/react-vite'
import heroUrl from '../../assets/hero.png'
import {
  blockedVideoFileFixture,
  fileArtifactsControllerFixture,
  imageFileFixture,
  scanningPdfFileFixture,
} from '../../files/fixtures'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { createTranslator } from '../../shared/i18n/i18n'
import { MarkdownDescriptionField } from './MarkdownDescriptionField'

const storyController: FileArtifactsController = {
  ...fileArtifactsControllerFixture,
  // Each picked, pasted, or dropped file "uploads" as the hero image so the inserted reference renders.
  uploadFiles: async (files, options) => {
    files.forEach(() => options?.onUploaded?.(imageFileFixture, imageFileFixture.currentVersion))
    return true
  },
  getVersionAccess: async () => ({
    expiresAt: '2026-07-12T03:00:00.000Z',
    url: heroUrl,
  }),
}

const description = `## 成果物

- 申込フォームの離脱率を下げる
- \`PT-12\` の調査結果を反映する

| 項目 | 期限 |
| --- | --- |
| デザイン | 7/20 |
| 実装 | 7/31 |

![${imageFileFixture.name}](attachment:${imageFileFixture.id})

[${scanningPdfFileFixture.name}](attachment:${scanningPdfFileFixture.id}) [${blockedVideoFileFixture.name}](attachment:${blockedVideoFileFixture.id})
`

const meta = {
  title: 'Application/Work Items/Markdown Description',
  component: MarkdownDescriptionField,
  decorators: [(Story) => (
    <div className="max-w-2xl p-6">
      <form id="story-editor" />
      <Story />
    </div>
  )],
  args: {
    artifacts: storyController,
    defaultValue: description,
    form: 'story-editor',
    label: '説明',
    name: 'description',
    t: createTranslator('ja'),
  },
} satisfies Meta<typeof MarkdownDescriptionField>

/**
 * MarkdownDescriptionField の Storybook metadata です。
 */
export default meta

/**
 * MarkdownDescriptionField Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 保存済みの説明を Markdown として表示し、scan 済みの画像だけを本文中に出す状態です。
 */
export const Rendered: Story = {}

/**
 * 説明が空で、書く欄と添付 button を最初から出す状態です。
 */
export const EmptyWriting: Story = {
  args: { defaultValue: '' },
}

/**
 * 編集できない閲覧者向けの表示です。
 */
export const ReadOnly: Story = {
  args: { readOnly: true },
}

/**
 * 英語 locale の表示です。
 */
export const English: Story = {
  args: { label: 'Description', t: createTranslator('en') },
}
