import type { Meta, StoryObj } from '@storybook/react-vite'
import heroUrl from '../../assets/hero.png'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import { FilePreviewDialog } from './FilePreviewDialog'
import {
  blockedVideoFileFixture,
  fileAnnotationFixtures,
  fileArtifactsControllerFixture,
  imageFileFixture,
  scanningPdfFileFixture,
} from '../fixtures'

const previewController = {
  ...fileArtifactsControllerFixture,
  getAnnotations: async () => fileAnnotationFixtures,
  getVersionAccess: async () => ({
    expiresAt: '2026-07-12T03:00:00.000Z',
    url: heroUrl,
  }),
}

const meta = {
  title: 'Application/Files/Preview Dialog',
  component: FilePreviewDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    controller: previewController,
    file: imageFileFixture,
    locale: 'ja',
    members: collaborationWorkspaceMemberFixtures,
    onClose: () => undefined,
  },
} satisfies Meta<typeof FilePreviewDialog>

/**
 * FilePreviewDialog の Storybook metadata です。
 */
export default meta

/**
 * FilePreviewDialog Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Image version と位置 annotation を表示する状態です。
 */
export const ImageWithAnnotations: Story = {}

/**
 * PDF の scan 完了を待っている preview 状態です。
 */
export const PdfScanning: Story = {
  args: { file: scanningPdfFileFixture },
}

/**
 * Virus scan で block された video preview 状態です。
 */
export const VideoBlocked: Story = {
  args: { file: blockedVideoFileFixture },
}

/**
 * 英語 locale の preview dialog です。
 */
export const English: Story = {
  args: { locale: 'en' },
}
