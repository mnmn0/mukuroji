import type { FileTypeRejection } from '@mukuroji/contracts'


/**
 * file API エラーです。
 */
export class FilesApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /**
   * `415 FileTypeNotAllowed` の拒否理由と Workspace が受け付ける形式です。
   */
  readonly fileTypeRejection?: FileTypeRejection

  /**
   * Creates an error for a failed file API response.
   *
   * @param status - HTTP status code of the response.
   * @param message - Human-readable error message.
   * @param code - Stable error code returned by the API, when present.
   * @param fileTypeRejection - Why a `415 FileTypeNotAllowed` refused the file and which types the
   *   Workspace accepts, when present.
   */
  constructor(status: number, message: string, code?: string, fileTypeRejection?: FileTypeRejection) {
    super(message)
    this.status = status
    this.code = code
    this.fileTypeRejection = fileTypeRejection
  }
}
