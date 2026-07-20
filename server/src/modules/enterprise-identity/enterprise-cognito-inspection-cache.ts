/**
 * Cognito inspection cache の保持値です。
 */
type EnterpriseCognitoInspectionCacheEntry<Value> = {
  /** Load 中か、成功して TTL 内にあるかを表す状態です。 */
  state: 'pending' | 'resolved'
  /** Resolved cache entry が失効する epoch milliseconds です。 */
  expiresAt?: number
  /** 同じ key の並行 read で共有する in-flight または解決済み Promise です。 */
  promise: Promise<Value>
}

/**
 * Cognito inspection cache の構成です。
 */
type EnterpriseCognitoInspectionCacheOptions = {
  /** 成功した raw binding を保持する milliseconds です。 */
  successTtlMs?: number
  /** Cache が追跡できる pending / resolved key の最大数です。 */
  maxEntries?: number
  /** Test で差し替え可能な wall clock です。 */
  now?: () => number
}

const defaultSuccessTtlMs = 30_000
const defaultMaxEntries = 32

/**
 * Cognito の raw inspection response を短時間だけ共有する bounded single-flight cache を作成します。
 *
 * @remarks
 * 失敗は保持せず、期限切れ後も stale response を返しません。呼び出し側は取得した raw binding を
 * current enterprise state に対して毎回検証する必要があります。全 entry が pending の状態で
 * 上限へ達した場合、新しい key は cache せず load して hard bound を維持します。
 */
export function createEnterpriseCognitoInspectionCache<Value>(
  options: EnterpriseCognitoInspectionCacheOptions = {},
) {
  const successTtlMs = options.successTtlMs ?? defaultSuccessTtlMs
  const maxEntries = options.maxEntries ?? defaultMaxEntries
  const now = options.now ?? Date.now
  if (!Number.isFinite(successTtlMs) || successTtlMs <= 0) {
    throw new Error('Cognito inspection cache success TTL must be positive.')
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Cognito inspection cache maximum entries must be a positive integer.')
  }

  const entries = new Map<string, EnterpriseCognitoInspectionCacheEntry<Value>>()

  const removeExpiredEntries = (currentTime: number) => {
    for (const [candidateKey, candidate] of entries) {
      if (candidate.state === 'pending') continue
      if ((candidate.expiresAt ?? 0) <= currentTime) {
        entries.delete(candidateKey)
      }
    }
  }

  const clear = () => {
    entries.clear()
  }

  const read = (
    key: string,
    load: () => Promise<Value>,
  ): Promise<Value> => {
    const currentTime = now()
    const cached = entries.get(key)
    if (
      cached?.state === 'pending' ||
      cached?.state === 'resolved' && (cached.expiresAt ?? 0) > currentTime
    ) {
      entries.delete(key)
      entries.set(key, cached)
      return cached.promise
    }
    if (cached) entries.delete(key)

    removeExpiredEntries(currentTime)
    if (entries.size >= maxEntries) {
      const oldestResolvedEntry = [...entries].find(([, candidate]) =>
        candidate.state === 'resolved'
      )
      if (oldestResolvedEntry) {
        entries.delete(oldestResolvedEntry[0])
      } else {
        return Promise.resolve().then(load)
      }
    }

    let entry: EnterpriseCognitoInspectionCacheEntry<Value>
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (entries.get(key) === entry) {
          entry.state = 'resolved'
          entry.expiresAt = now() + successTtlMs
          entries.delete(key)
          entries.set(key, entry)
        }
        return value
      })
      .catch((error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key)
        throw error
      })
    entry = {
      state: 'pending',
      promise,
    }
    entries.set(key, entry)
    return promise
  }

  const refresh = (
    key: string,
    load: () => Promise<Value>,
  ): Promise<Value> => {
    const cached = entries.get(key)
    if (cached?.state === 'pending') return cached.promise
    entries.delete(key)
    return read(key, load)
  }

  return {
    clear,
    read,
    refresh,
  }
}
