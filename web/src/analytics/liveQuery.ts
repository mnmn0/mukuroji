import type {
  AnalyticsQueryInput,
  AnalyticsSnapshot,
} from '@mukuroji/contracts'
import { queryAnalytics } from './api'

/**
 * Live analytics query を直列化し、後続 request の開始時に前 request を中断する runner を生成します。
 *
 * @param request - 実際に snapshot を取得する request 関数です。
 * @returns Query 実行と明示的な中断を提供する runner です。
 */
export function createAnalyticsLiveQueryRunner(
  request: (
    accessToken: string,
    input: AnalyticsQueryInput,
    signal: AbortSignal,
  ) => Promise<AnalyticsSnapshot> = queryAnalytics,
) {
  let activeController: AbortController | undefined

  return {
    abort() {
      activeController?.abort()
      activeController = undefined
    },
    async run(
      accessToken: string,
      serializedQuery: string,
    ) {
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller

      try {
        return await request(
          accessToken,
          JSON.parse(serializedQuery) as AnalyticsQueryInput,
          controller.signal,
        )
      } finally {
        if (activeController === controller) {
          activeController = undefined
        }
      }
    },
  }
}
