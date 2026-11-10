/** Notification API/store の安定した error です。 */
export class NotificationError extends Error {
  /** HTTP status code です。 */
  readonly status: number
  /** Client が分岐に使う error code です。 */
  readonly code: string

  /**
   * Creates a notification error.
   *
   * @param status - HTTP status code.
   * @param code - Stable code clients branch on.
   * @param message - Message safe to return to clients.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
