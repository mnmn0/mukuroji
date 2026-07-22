import type { AutomationTemplateApplication } from '@mukuroji/contracts'

/** Template application receipt 再取得処理の callbacks と表示 state です。 */
export type AutomationTemplateApplicationRefreshOptions = {
  /** 再取得する application ID です。 */
  applicationId: string
  /** 再取得失敗時に表示する localized message です。 */
  errorMessage: string
  /** Receipt 再取得 callback です。 */
  onRefresh: (applicationId: string) => Promise<AutomationTemplateApplication>
  /** 再取得した receipt を表示 state へ反映する callback です。 */
  onSuccess: (application: AutomationTemplateApplication) => void
  /** 再取得 error の表示 state を更新する callback です。 */
  onErrorChange: (errorMessage: string | undefined) => void
  /** Receipt 再取得中 state を更新する callback です。 */
  onRefreshingChange: (isRefreshing: boolean) => void
}

/** Template application receipt を再取得し、成功・失敗・完了 state を反映します。 */
export async function refreshAutomationTemplateApplication({
  applicationId,
  errorMessage,
  onErrorChange,
  onRefresh,
  onRefreshingChange,
  onSuccess,
}: AutomationTemplateApplicationRefreshOptions): Promise<void> {
  onRefreshingChange(true)
  onErrorChange(undefined)
  try {
    onSuccess(await onRefresh(applicationId))
  } catch {
    onErrorChange(errorMessage)
  } finally {
    onRefreshingChange(false)
  }
}
