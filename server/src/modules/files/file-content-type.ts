import { findFileTypeByContentType } from '@mukuroji/contracts'

/**
 * RFC 9110 `type/subtype` token pattern without parameters, applied after lowercasing.
 */
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/

/**
 * Raster image media types that browsers render without executing active content.
 * SVG and other script-capable image formats are intentionally excluded.
 */
const INLINE_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/**
 * Video media types the File preview plays through a `<video>` element.
 */
const INLINE_VIDEO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

/**
 * Media types that may be served with an `inline` Content-Disposition from the File bucket.
 */
const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  ...INLINE_IMAGE_CONTENT_TYPES,
  ...INLINE_VIDEO_CONTENT_TYPES,
  'application/pdf',
])

/**
 * Normalizes a caller-supplied File media type to the canonical stored representation.
 *
 * @param value - Non-empty media type text validated by the caller's input boundary.
 * @returns Lowercase `type/subtype` without parameters or surrounding whitespace, or an empty
 *   string when the essence is not a single well-formed media type token pair.
 */
export function normalizeFileContentType(value: string): string {
  const essence = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return MEDIA_TYPE_PATTERN.test(essence) ? essence : ''
}

/**
 * Determines whether a canonical media type may be stored on a File version: the canonical media
 * type of a catalog File type. A Workspace can stop accepting a type later, so stored versions are
 * checked against the whole catalog rather than the Workspace settings.
 *
 * @param contentType - Canonical media type without parameters.
 * @returns Whether a File version may carry the media type.
 */
export function isCatalogFileContentType(contentType: string): boolean {
  return findFileTypeByContentType(contentType) !== undefined
}

/**
 * Determines whether a canonical media type may be opened inline from the File bucket origin.
 *
 * @param contentType - Canonical media type without parameters.
 * @returns Whether an `inline` Content-Disposition is safe for the media type.
 */
export function isInlineSafeFileContentType(contentType: string): boolean {
  return INLINE_SAFE_CONTENT_TYPES.has(contentType)
}

/**
 * Determines whether a canonical media type is an inline-safe raster image.
 *
 * @param contentType - Canonical media type without parameters.
 * @returns Whether the File preview may render the media type as an image.
 */
export function isInlineImageFileContentType(contentType: string): boolean {
  return INLINE_IMAGE_CONTENT_TYPES.has(contentType)
}

/**
 * Determines whether a canonical media type is a video the File preview can play.
 *
 * @param contentType - Canonical media type without parameters.
 * @returns Whether the File preview may render the media type as a video.
 */
export function isInlineVideoFileContentType(contentType: string): boolean {
  return INLINE_VIDEO_CONTENT_TYPES.has(contentType)
}
