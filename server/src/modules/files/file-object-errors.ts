/**
 * Determines whether an exact immutable S3 object version no longer exists.
 *
 * @param error - Untrusted failure returned by an exact-version S3 read.
 * @returns Whether the object key or immutable version is missing.
 */
export function isMissingFileObjectVersionError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'NoSuchKey' ||
    error.name === 'NoSuchVersion' ||
    error.name === 'NotFound'
  )
}
