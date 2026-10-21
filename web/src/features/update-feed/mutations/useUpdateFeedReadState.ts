import type { UpdateFeedEntry } from '@mukuroji/contracts'
import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { setUpdateFeedReadState } from '../api/updateFeed'

/** Saves explicit personal state; refreshes after success or conflict without optimistic disclosure.
 * @param token - Session bearer token.
 * @param refresh - Reloads the current authorized view.
 * @param guard - Shared authenticated-request error boundary.
 * @returns Serialized toggle action, successful-write revision, pending state, and latest failure.
 */
export function useUpdateFeedReadState(token: string | undefined, refresh: () => Promise<unknown>, guard: <T>(request: Promise<T>) => Promise<T>) {
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<unknown>()
  const busy = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  /** Serializes a user's choices and reloads authoritative state after any outcome. */
  const toggle = async (entry: UpdateFeedEntry) => {
    const latest = entry.latestUpdate
    const state = entry.readState
    if (!token || !latest || !state || busy.current) return
    busy.current = true
    setPending(true)
    setError(undefined)
    try {
      await setUpdateFeedReadState(token, { target: entry.target, version: latest.version, expectedRevision: state.revision, read: !state.read })
      if (active.current) setRevision((value) => value + 1)
    } catch (failure) {
      if (active.current) {
        await guard(Promise.reject(failure)).catch(() => undefined)
        setError(failure)
      }
    } finally {
      if (active.current) {
        await mutate((key) => Array.isArray(key) && key[0] === 'update-feed' && key[1] === token, undefined, { revalidate: true }).catch(() => undefined)
        await refresh().catch(() => undefined)
      }
      busy.current = false
      if (active.current) setPending(false)
    }
  }
  return { toggle, pending, error, revision }
}
