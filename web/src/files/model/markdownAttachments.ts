import type { FileAttachment, FileVersion } from '@mukuroji/contracts'

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

/**
 * Types the File API accepts, mirrored so the editor can refuse a file before uploading it.
 * The server checks the same list again when the upload session is created.
 */
const attachableContentTypes: ReadonlySet<string> = new Set([
  ...inlineImageContentTypes,
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

/** File ids are server-generated hex or UUID-like tokens; anything else is not a reference. */
const fileIdPattern = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Why a selected file cannot be attached to a Markdown body.
 */
export type MarkdownAttachmentRejection = 'unsupportedType' | 'tooLarge'

/**
 * Checks a pasted or dropped file before an upload session is created.
 *
 * @param file - Browser file from the clipboard, a drop, or the file picker.
 * @returns Why the file is refused, or `undefined` when it may be uploaded.
 */
export function findMarkdownAttachmentRejection(
  file: Pick<File, 'size' | 'type'>,
): MarkdownAttachmentRejection | undefined {
  if (!attachableContentTypes.has(normalizeContentType(file.type))) return 'unsupportedType'
  if (file.size <= 0 || file.size > markdownAttachmentMaxSizeBytes) return 'tooLarge'
  return undefined
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
