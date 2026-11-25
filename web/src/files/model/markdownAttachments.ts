import type { FileAttachment, FileTypeRejection, FileVersion } from '@mukuroji/contracts'

/**
 * URL scheme that Markdown bodies use to point at a file attached to the same Work Item.
 * The reference holds only the file id, so the image or link is resolved through the
 * viewer's own file permissions every time the body is shown.
 */
export const markdownAttachmentScheme = 'attachment'

/**
 * Largest file a description or comment editor accepts by paste or drop.
 * The File API allows much larger uploads; bodies keep a smaller limit so a pasted
 * screenshot cannot start a multi-gigabyte upload by accident.
 */
export const markdownAttachmentMaxSizeBytes = 25 * 1024 * 1024

/**
 * Raster image types shown inline in a Markdown body.
 * The list matches the server's inline-safe images; SVG is excluded because it can run script.
 */
const inlineImageContentTypes: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** File ids are server-generated hex or UUID-like tokens; anything else is not a reference. */
const fileIdPattern = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Why a selected file cannot be attached to a Markdown body before asking the server. The type
 * is checked by the server, which knows the Workspace settings and says which types it accepts.
 */
export type MarkdownAttachmentRejection = 'tooLarge'

/**
 * Checks a pasted or dropped file before an upload session is created.
 *
 * @param file - Browser file from the clipboard, a drop, or the file picker.
 * @returns Why the file is refused, or `undefined` when it may be uploaded.
 */
export function findMarkdownAttachmentRejection(
  file: Pick<File, 'size'>,
): MarkdownAttachmentRejection | undefined {
  if (file.size <= 0 || file.size > markdownAttachmentMaxSizeBytes) return 'tooLarge'
  return undefined
}

/**
 * Messages a Markdown editor shows after uploading a batch of files.
 */
export type MarkdownAttachmentBatchMessages = {
  /** Why the server refused a file of the batch because of its type, if it did. */
  fileTypeRejection?: FileTypeRejection
  /** Message for a file that failed for another reason, which stops the rest of the batch. */
  errorKey?: 'files.error.upload'
}

/**
 * Decides what to report after a batch upload. A type rejection skips only that file, so a later
 * file can still fail; both are reported so the failure is not hidden behind the rejection.
 *
 * @param succeeded - Whether the batch finished without a failure other than a type rejection.
 * @param fileTypeRejection - Last type rejection reported during the batch, if any.
 * @returns The messages to show; empty when every file was uploaded.
 */
export function readMarkdownAttachmentBatchMessages(
  succeeded: boolean,
  fileTypeRejection?: FileTypeRejection,
): MarkdownAttachmentBatchMessages {
  return {
    ...(fileTypeRejection ? { fileTypeRejection } : {}),
    ...(succeeded ? {} : { errorKey: 'files.error.upload' }),
  }
}

/**
 * Builds the Markdown that refers to an uploaded file: an image for inline-safe images,
 * otherwise a link that downloads the file.
 *
 * @param file - Stored file returned by the upload.
 * @param version - Uploaded version, whose media type decides image or link.
 * @returns Markdown text to insert into the body.
 */
export function createMarkdownAttachmentReference(file: FileAttachment, version: FileVersion): string {
  const label = escapeMarkdownLabel(file.name)
  const url = `${markdownAttachmentScheme}:${file.id}`
  return inlineImageContentTypes.has(normalizeContentType(version.contentType))
    ? `![${label}](${url})`
    : `[${label}](${url})`
}

/**
 * Reads the file id from an `attachment:` URL.
 *
 * @param url - URL from a Markdown image or link.
 * @returns The file id, or `undefined` when the URL is not a well-formed attachment reference.
 */
export function readMarkdownAttachmentFileId(url: string | null | undefined): string | undefined {
  const prefix = `${markdownAttachmentScheme}:`
  if (!url?.startsWith(prefix)) return undefined
  const fileId = url.slice(prefix.length)
  return fileIdPattern.test(fileId) ? fileId : undefined
}

/**
 * Decides whether a referenced file may be drawn as an image in the body.
 * Only the current version counts, so a new version that is still being scanned hides the image.
 *
 * @param file - Referenced file as the viewer sees it.
 * @returns The version to draw, or `undefined` when the file is not shown inline.
 */
export function findInlineImageVersion(file: FileAttachment): FileVersion | undefined {
  const version = file.currentVersion
  return !file.deletedAt &&
    file.capabilities.canDownload &&
    version.scanStatus === 'available' &&
    version.previewKind === 'image' &&
    inlineImageContentTypes.has(normalizeContentType(version.contentType))
    ? version
    : undefined
}

/**
 * Escapes the characters that would end or nest a Markdown link label.
 *
 * @param value - File name shown as the alt text or link text.
 * @returns Label text safe to place between `[` and `]`.
 */
function escapeMarkdownLabel(value: string): string {
  const label = value.replace(/[\r\n]+/g, ' ').trim() || 'file'
  return label.replace(/[\\[\]]/g, (character) => `\\${character}`)
}

/**
 * Lowercases a media type and drops its parameters.
 *
 * @param value - Media type from the browser or the server.
 * @returns The `type/subtype` part only.
 */
function normalizeContentType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}
