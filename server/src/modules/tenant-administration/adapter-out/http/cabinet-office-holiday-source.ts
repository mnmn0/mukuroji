import type { JapanesePublicHolidaySource } from '../../application/japanese-public-holiday-sync'
import { JapanesePublicHolidaySourceError } from '../../domain/japanese-public-holidays'

/** Largest source file accepted; the Cabinet Office CSV is about 20 KB. */
const MAX_SOURCE_BYTES = 512 * 1024

/** How long one fetch may take. */
const FETCH_TIMEOUT_MILLISECONDS = 15_000

/** Options of {@link createCabinetOfficeHolidaySource}. */
export type CabinetOfficeHolidaySourceOptions = {
  /** HTTPS URL of the CSV; plain HTTP is accepted only for a loopback test server. */
  url: string
  /** Fetch implementation; the global `fetch` by default. */
  fetcher?: (url: URL, init: RequestInit) => Promise<Response>
}

/**
 * Creates the source that downloads the Cabinet Office holiday CSV.
 *
 * Redirects are refused and the body is capped, so the job only ever reads the configured file.
 * The CSV is Shift_JIS.
 *
 * @param options - Source URL and fetch implementation.
 * @returns The source.
 */
export function createCabinetOfficeHolidaySource(
  options: CabinetOfficeHolidaySourceOptions,
): JapanesePublicHolidaySource {
  const url = new URL(options.url)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('The national holiday source must be an HTTPS URL.')
  }
  const fetcher = options.fetcher ?? ((target: URL, init: RequestInit) => fetch(target, init))
  return {
    async fetch() {
      const response = await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
      })
      if (!response.ok) {
        throw new Error(`The national holiday source answered ${response.status}.`)
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0')
      if (declaredLength > MAX_SOURCE_BYTES) {
        throw new JapanesePublicHolidaySourceError('The national holiday source is too large.')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_SOURCE_BYTES) {
        throw new JapanesePublicHolidaySourceError('The national holiday source is too large.')
      }
      return bytes
    },
    decode(bytes) {
      return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
    },
  }
}
