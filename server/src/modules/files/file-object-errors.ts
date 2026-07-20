/**
 * Immutable S3 object version が既に存在しない error かどうかを判定します。
 */
export function isMissingFileObjectVersionError(error: unknown) {
  return error instanceof Error && (
    error.name === 'NoSuchKey' || error.name === 'NoSuchVersion'
  )
}
