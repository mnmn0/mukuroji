import { describe, expect, test } from 'bun:test'
import type { FileAttachment } from '@mukuroji/contracts'
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
  readMarkdownAttachmentFileId,
} from '../src/files/model/markdownAttachments'
import { MarkdownAttachmentReactContext } from '../src/files/ui/markdownAttachmentContext'
import { MarkdownDescriptionField } from '../src/issues/ui/MarkdownDescriptionField'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

describe('markdown attachment model', () => {
  test('accepts raster images and allowed files up to the body limit only', () => {
    expect(findMarkdownAttachmentRejection({ size: 1_000, type: 'image/png' })).toBeUndefined()
    expect(findMarkdownAttachmentRejection({ size: 1_000, type: 'application/pdf' })).toBeUndefined()
    expect(findMarkdownAttachmentRejection({ size: 1_000, type: 'image/svg+xml' })).toBe('unsupportedType')
    expect(findMarkdownAttachmentRejection({ size: 1_000, type: 'text/html' })).toBe('unsupportedType')
    expect(findMarkdownAttachmentRejection({ size: 1_000, type: '' })).toBe('unsupportedType')
    expect(findMarkdownAttachmentRejection({ size: markdownAttachmentMaxSizeBytes + 1, type: 'image/png' })).toBe('tooLarge')
    expect(findMarkdownAttachmentRejection({ size: 0, type: 'image/png' })).toBe('tooLarge')
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
