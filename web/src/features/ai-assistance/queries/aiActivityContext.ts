import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AiActivity, AiActivityStore } from '../model/aiActivity'

/** Workspace-owned session context shared by assistants and activity views. */
export type AiActivityContextValue = {
  /** Session-isolated metadata store. */
  store: AiActivityStore
  /** Current route captured at the explicit generation action. */
  origin: string
  /** Opens the board without unmounting the active assistant. */
  openBoard: () => void
}

/** Optional context keeps standalone assistants usable outside the workspace. */
export const AiActivityContext = createContext<AiActivityContextValue | undefined>(undefined)

const emptyActivities: readonly AiActivity[] = []
/** Supplies the stable empty snapshot for standalone views. */
const getEmptySnapshot = () => emptyActivities
/** Supplies an inert subscription outside an authenticated workspace. */
const subscribeEmpty = () => () => undefined

/**
 * Reads session activity without starting an AI request.
 * @returns The optional workspace controls and live metadata snapshot.
 */
export function useAiActivity() {
  const context = useContext(AiActivityContext)
  const activities = useSyncExternalStore(
    context?.store.subscribe ?? subscribeEmpty,
    context?.store.getSnapshot ?? getEmptySnapshot,
    getEmptySnapshot,
  )
  return { context, activities }
}
