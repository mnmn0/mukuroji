import useSWR from 'swr'
import type { Locale } from '../../shared/i18n/i18n'
import {
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../api'

/** Project directory query が利用する取得関数です。 */
export type ProjectDirectoryLoader = (
  accessToken: string,
  locale: Locale,
) => Promise<ProjectDirectoryTeam[]>

/** Project directory query の入力です。 */
export type UseProjectDirectoryOptions = {
  /** Project directory API の access token です。 */
  accessToken?: string
  /** Query を実行できる認証・権限状態かどうかです。 */
  enabled: boolean
  /** Project directory の表示 locale です。 */
  locale: Locale
  /** Storybook やテストで差し替える取得関数です。 */
  loadProjectDirectory?: ProjectDirectoryLoader
  /** 既存画面の取得間隔を維持する deduplication 時間です。 */
  dedupingInterval?: number
}

const defaultDedupingInterval = 10_000

/**
 * 認証状態に応じて Team / Project directory を取得します。
 *
 * SWR key、条件付き取得、retry方針をこのquery境界で所有します。
 *
 * @param options - 認証情報、locale、取得可否です。
 * @returns Project directory のSWR状態と現在のkeyです。
 */
export function useProjectDirectory({
  accessToken,
  enabled,
  locale,
  loadProjectDirectory = getProjectDirectory,
  dedupingInterval = defaultDedupingInterval,
}: UseProjectDirectoryOptions) {
  const key = accessToken && enabled
    ? (['project-directory', accessToken, locale] as const)
    : null
  const query = useSWR(
    key,
    ([, token, currentLocale]) => loadProjectDirectory(token, currentLocale),
    {
      dedupingInterval,
      shouldRetryOnError: false,
    },
  )

  return {
    ...query,
    key,
  }
}
