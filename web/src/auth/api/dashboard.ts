import { ApiError } from './errors'

/**
 * DynamoDB から取得するダッシュボード集計値です。
 */
export type DashboardSummary = {
  /**
   * 進行中プロジェクト数です。
   */
  projects: number
  /**
   * 未完了タスク数です。
   */
  tasks: number
  /**
   * 要確認タスク数です。
   */
  blocked: number
  /**
   * 集計値を更新した ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 集計値の取得元です。
   */
  source: 'dynamodb'
}

const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

/**
 * アクセストークンを使ってダッシュボード集計値を取得します。
 */
export function getDashboardSummary(accessToken: string, signal?: AbortSignal) {
  return apiFetch<DashboardSummary>('/dashboard/summary', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  })
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const data = await readJson<{ code?: string; message?: string } | T>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'API request failed.'

    const code =
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      typeof data.code === 'string'
        ? data.code
        : undefined

    throw new ApiError(response.status, message, code)
  }

  return data as T
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
