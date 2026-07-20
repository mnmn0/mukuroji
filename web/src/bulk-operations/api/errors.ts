

/** Bulk operation API が返す安定した HTTP error です。 */
export class BulkOperationsApiError extends Error {
  /** HTTP status code です。 */
  readonly status: number

  /** Server が返した安定 error code です。 */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
