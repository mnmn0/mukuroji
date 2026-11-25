import { describe, expect, test } from 'bun:test'
import type { FileAttachment, FileTypeRejection } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  blockedVideoFileFixture,
  fileArtifactsControllerFixture,
  imageFileFixture,
  scanningPdfFileFixture,
} from '../src/files/fixtures'
import {
  createMarkdownAttachmentReference,
  findInlineImageVersion,
  findMarkdownAttachmentRejection,
  markdownAttachmentMaxSizeBytes,
  readMarkdownAttachmentBatchMessages,
  readMarkdownAttachmentFileId,
} from '../src/files/model/markdownAttachments'
import { describeFileTypeRejection } from '../src/files/model/fileTypeRejection'
import type { MarkdownAttachmentUpload } from '../src/files/mutations/useMarkdownAttachmentUpload'
import { MarkdownAttachmentControls } from '../src/files/ui/MarkdownAttachmentControls'
import { MarkdownAttachmentReactContext } from '../src/files/ui/markdownAttachmentContext'
import { MarkdownDescriptionField } from '../src/issues/ui/MarkdownDescriptionField'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

describe('markdown attachment model', () => {
  test('accepts files up to the body limit and leaves the type to the server', () => {
    expect(findMarkdownAttachmentRejection({ size: 1_000 })).toBeUndefined()
    expect(findMarkdownAttachmentRejection({ size: markdownAttachmentMaxSizeBytes + 1 })).toBe('tooLarge')
    expect(findMarkdownAttachmentRejection({ size: 0 })).toBe('tooLarge')
  })

  test('explains a refused type with the types the Workspace accepts', () => {
    expect(describeFileTypeRejection({ reason: 'not-allowed', allowedFileTypes: ['markdown', 'xlsm'] }, t))
      .toBe('This Workspace does not accept this file type. You can attach: .md, .markdown, .xlsm')
    expect(describeFileTypeRejection({ reason: 'dangerous', allowedFileTypes: [] }, t))
      .toBe('Programs, scripts, and other dangerous types cannot be attached. This Workspace accepts no file types.')
  })

  test('reports an upload failure that follows a type rejection in the same batch', () => {
    const rejection: FileTypeRejection = { reason: 'dangerous', allowedFileTypes: ['pdf'] }
    // script.js is refused for its type, then report.pdf fails to upload.
    expect(readMarkdownAttachmentBatchMessages(false, rejection))
      .toEqual({ fileTypeRejection: rejection, errorKey: 'files.error.upload' })
    expect(readMarkdownAttachmentBatchMessages(true, rejection)).toEqual({ fileTypeRejection: rejection })
    expect(readMarkdownAttachmentBatchMessages(false)).toEqual({ errorKey: 'files.error.upload' })
    expect(readMarkdownAttachmentBatchMessages(true)).toEqual({})

    const upload: MarkdownAttachmentUpload = {
      attachFiles: async () => undefined,
      canAttach: true,
      errorKey: 'files.error.upload',
      fileTypeRejection: rejection,
      handleDragOver: () => undefined,
      handleDrop: () => undefined,
      handlePaste: () => undefined,
      isUploading: false,
    }
    const markup = renderToStaticMarkup(<MarkdownAttachmentControls t={t} upload={upload} />)
    expect(markup).toContain('The file could not be uploaded.')
    expect(markup).toContain(describeFileTypeRejection(rejection, t))
    expect(markup.indexOf('The file could not be uploaded.'))
      .toBeLessThan(markup.indexOf(describeFileTypeRejection(rejection, t)))
  })

  test('writes images as image references and other files as links, escaping the label', () => {
    const image = { ...imageFileFixture, name: 'shot [1]\n.png' } satisfies FileAttachment
    expect(createMarkdownAttachmentReference(image, image.currentVersion))
      .toBe('![shot \\[1\\] .png](attachment:file-launch-hero)')
    expect(createMarkdownAttachmentReference(scanningPdfFileFixture, scanningPdfFileFixture.currentVersion))
      .toBe(`[${scanningPdfFileFixture.name}](attachment:${scanningPdfFileFixture.id})`)
  })

  test('reads only well-formed attachment ids', () => {
    expect(readMarkdownAttachmentFileId('attachment:abc_123-x')).toBe('abc_123-x')
    expect(readMarkdownAttachmentFileId('attachment:../secret')).toBeUndefined()
    expect(readMarkdownAttachmentFileId('attachment:')).toBeUndefined()
    expect(readMarkdownAttachmentFileId('https://example.com/attachment:abc')).toBeUndefined()
  })

  test('shows an image only for a readable, clean, current image version', () => {
    expect(findInlineImageVersion(imageFileFixture)?.id).toBe(imageFileFixture.currentVersion.id)
    const pendingVersion = { ...imageFileFixture.currentVersion, id: 'pending', scanStatus: 'scanning' as const }
    expect(findInlineImageVersion({ ...imageFileFixture, currentVersion: pendingVersion })).toBeUndefined()
    expect(findInlineImageVersion({
      ...imageFileFixture,
      capabilities: { ...imageFileFixture.capabilities, canDownload: false },
    })).toBeUndefined()
    expect(findInlineImageVersion({ ...imageFileFixture, deletedAt: '2026-07-13T00:00:00.000Z' })).toBeUndefined()
    const svgVersion = { ...imageFileFixture.currentVersion, contentType: 'image/svg+xml' }
    expect(findInlineImageVersion({ ...imageFileFixture, currentVersion: svgVersion })).toBeUndefined()
  })
})

describe('SafeCommentBody attachments', () => {
  test('keeps headings, lists, tables, and code, and never renders external images', () => {
    const html = renderToStaticMarkup(
      <SafeCommentBody bodyMarkdown={`## Scope

- one
- two

| a | b |
| - | - |
| 1 | 2 |

\`\`\`ts
const x = 1
\`\`\`

![pixel](https://example.com/pixel.png)`} />,
    )
    expect(html).toContain('<h2>Scope</h2>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<table>')
    expect(html).toContain('const x = 1')
    expect(html).not.toContain('<img')
  })

  test('shows placeholders, not images, for scanning, blocked, unreadable, or unknown files', () => {
    const scanningImage = {
      ...imageFileFixture,
      id: 'file-scanning-image',
      currentVersion: { ...imageFileFixture.currentVersion, id: 'v-scan', scanStatus: 'scanning' as const },
    } satisfies FileAttachment
    const blockedImage = {
      ...imageFileFixture,
      id: 'file-blocked-image',
      currentVersion: { ...imageFileFixture.currentVersion, id: 'v-block', scanStatus: 'blocked' as const },
    } satisfies FileAttachment
    const hiddenImage = {
      ...imageFileFixture,
      id: 'file-hidden-image',
      capabilities: { ...imageFileFixture.capabilities, canDownload: false },
    } satisfies FileAttachment
    const controller = {
      ...fileArtifactsControllerFixture,
      files: [scanningImage, blockedImage, hiddenImage],
    }
    const html = renderToStaticMarkup(
      <SafeCommentBody
        attachments={{ controller, t }}
        bodyMarkdown={[
          '![a](attachment:file-scanning-image)',
          '![b](attachment:file-blocked-image)',
          '![c](attachment:file-hidden-image)',
          '![d](attachment:file-from-another-item)',
        ].join('\n\n')}
      />,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain(t('files.scan.processing'))
    expect(html).toContain(t('files.scan.blocked'))
    expect(html.split(t('files.markdown.unavailable')).length - 1).toBeGreaterThanOrEqual(2)
  })

  test('waits for a short-lived URL before drawing a clean image and shows file links as buttons', () => {
    const html = renderToStaticMarkup(
      <SafeCommentBody
        attachments={{ controller: fileArtifactsControllerFixture, t }}
        bodyMarkdown={`![hero](attachment:${imageFileFixture.id})

[spec](attachment:${scanningPdfFileFixture.id}) [video](attachment:${blockedVideoFileFixture.id})`}
      />,
    )
    // The URL is fetched after mount, so the server render shows the loading placeholder.
    expect(html).not.toContain('<img')
    expect(html).toContain(t('files.preview.loading'))
    expect(html).toContain(`data-testid="markdown-attachment-link-${scanningPdfFileFixture.id}"`)
    expect(html).not.toContain('href="attachment:')
    expect(html).toContain('disabled=""')
  })
})

describe('attachment context and read-only descriptions', () => {
  const availablePdf = {
    ...scanningPdfFileFixture,
    currentVersion: { ...scanningPdfFileFixture.currentVersion, scanStatus: 'available' as const },
  } satisfies FileAttachment
  const controller = { ...fileArtifactsControllerFixture, files: [availablePdf] }

  test('keeps attachment downloads usable for a viewer who cannot edit the description', () => {
    const html = renderToStaticMarkup(
      <MarkdownDescriptionField
          artifacts={controller}
          defaultValue={`[spec](attachment:${availablePdf.id})`}
          disabled
          form="editor"
          label="Description"
          name="description"
          readOnly
          t={t}
        />,
    )
    const button = html.match(new RegExp(`<button[^>]*data-testid="markdown-attachment-link-${availablePdf.id}"[^>]*>`))?.[0]
    expect(button).toBeDefined()
    expect(button).not.toContain('disabled=""')
    expect(html).toContain('<textarea')
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
  })

  test('resolves attachments from the surrounding Work Item context', () => {
    const html = renderToStaticMarkup(
      <MarkdownAttachmentReactContext.Provider value={{ controller, t }}>
        <SafeCommentBody bodyMarkdown={`[spec](attachment:${availablePdf.id})`} />
      </MarkdownAttachmentReactContext.Provider>,
    )
    const button = html.match(/<button[^>]*markdown-attachment-link[^>]*>/)?.[0]
    expect(button).toBeDefined()
    expect(button).not.toContain('disabled=""')
  })
})
