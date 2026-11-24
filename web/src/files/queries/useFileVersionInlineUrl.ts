import type { FileAttachment, FileVersion } from '@mukuroji/contracts'
import useSWR from 'swr'
import type { FileArtifactsController } from '../mutations/useFileArtifacts'

/**
 * A URL or failure is reused for this long; a remount within it sends no request.
 * The server's URLs last five minutes, so a reused URL is still valid, and a later mount
 * asks for a fresh one. Even a component that remounts on every render sends at most one
 * request per version and minute.
 */
const inlineUrlReuseMilliseconds = 60_000

/**
 * Result of {@link useFileVersionInlineUrl}.
 */
export type FileVersionInlineUrlState = {
  /**
   * Short-lived inline URL, once it has been issued.
   */
  url?: string
  /**
   * Whether the request finished without a URL.
   */
  failed: boolean
  /**
   * Whether the URL is still being requested.
   */
  isLoading: boolean
}

/**
 * Requests one short-lived inline URL for a file version through the Work Item file controller.
 * A failure is not retried automatically, so a broken file shows a placeholder instead of
 * repeating requests.
 *
 * @param controller - File controller of the Work Item, or nothing when files cannot be read.
 * @param file - File to show, or nothing when it should not be shown.
 * @param version - Version to show, or nothing when it should not be shown.
 * @param attempt - Bumped by the caller to request a new URL, after a loaded one stopped working
 *   or when the viewer retries.
 * @returns The URL state.
 */
export function useFileVersionInlineUrl(
  controller: FileArtifactsController | undefined,
  file: FileAttachment | undefined,
  version: FileVersion | undefined,
  attempt: number,
): FileVersionInlineUrlState {
  const scope = controller?.scope
  const scopeKey = scope ? JSON.stringify(scope) : ''
  const key = controller && scope && file && version
    ? ['file-version-inline-url', scopeKey, file.id, version.id, attempt] as const
    : null
  const { data, error, isLoading } = useSWR(
    key,
    async () => {
      if (!controller || !file || !version) return undefined
      const access = await controller.getVersionAccess(file, version, 'inline')
      return access?.url ?? null
    },
    {
      dedupingInterval: inlineUrlReuseMilliseconds,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  )

  return {
    failed: Boolean(error) || data === null,
    isLoading: Boolean(key) && isLoading,
    url: data ?? undefined,
  }
}
