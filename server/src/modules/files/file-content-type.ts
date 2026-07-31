/**
 * Normalizes a caller-supplied File media type to the canonical stored representation.
 *
 * @param value - Non-empty media type text validated by the caller's input boundary.
 * @returns Lowercase media type without parameters or surrounding whitespace.
 */
export function normalizeFileContentType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}

/**
 * Determines whether a canonical media type is accepted by File upload and integrity checks.
 *
 * @param contentType - Canonical media type without parameters.
 * @returns Whether the File writer permits the media type.
 */
export function isAllowedFileContentType(contentType: string): boolean {
  return contentType.startsWith('image/') ||
    contentType === 'application/pdf' ||
    contentType === 'video/mp4' ||
    contentType === 'video/webm' ||
    contentType === 'video/quicktime' ||
    contentType === 'text/plain' ||
    contentType === 'text/csv' ||
    contentType === 'application/json' ||
    contentType === 'application/zip' ||
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
