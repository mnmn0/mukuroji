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

  constructor(status: number, message: string, code?: string, fileTypeRejection?: FileTypeRejection) {
    super(message)
    this.status = status
    this.code = code
    this.fileTypeRejection = fileTypeRejection
  }
}
