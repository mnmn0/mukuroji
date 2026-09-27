import type { AiAssistanceTask } from '@mukuroji/contracts'

/** Observed operation phases, without inferred provider progress. */
export type AiActivityPhase =
  | 'generating' | 'review' | 'deciding' | 'approved' | 'rejected'
  | 'cancelled' | 'closed' | 'expired' | 'unavailable' | 'failed'

/** Human-oriented lanes used by the activity board. */
export type AiActivityStatus = 'running' | 'review' | 'paused' | 'completed' | 'failed'

/** One timestamped observation about an operation. */
export type AiActivityEvent = {
  /** Actual observed phase. */
  phase: AiActivityPhase
  /** Time at which the browser observed this phase. */
  at: number
}

/** Session-local metadata; generated text and prompts are deliberately excluded. */
export type AiActivity = {
  /** Browser-local operation identifier. */
  id: string
  /** Existing AI workflow that owns the operation. */
  task: AiAssistanceTask
  /** Optional already-visible source label. */
  label?: string
  /** Same-origin route from which the operation was started. */
  origin: string
  /** Latest observed phase. */
  phase: AiActivityPhase
  /** Retention deadline for review availability. */
  expiresAt?: number
  /** Whether source metadata was removed after disclosure became unavailable. */
  sourceUnavailable?: boolean
  /** Bounded chronological observations. */
  events: readonly AiActivityEvent[]
}

/** Immutable metadata supplied when starting a session operation. */
export type AiActivityStart = Pick<AiActivity, 'task' | 'label' | 'origin'>

/** Reactive, memory-only activity store scoped to one authentication session. */
export type AiActivityStore = {
  /** Returns the stable snapshot consumed by React. */
  getSnapshot: () => readonly AiActivity[]
  /** Subscribes to committed metadata changes. */
  subscribe: (listener: () => void) => () => void
  /** Records a real explicit generation request. */
  start: (input: AiActivityStart) => string
  /** Records a phase of the matching operation. */
  update: (id: string | undefined, phase: AiActivityPhase, expiresAt?: number) => void
  /** Removes source metadata while preserving any validated human decision. */
  clearSource: (id: string | undefined, recordedDecision?: 'approved' | 'rejected') => void
  /** Closes unfinished local work when its owning assistant goes away. */
  close: (id: string | undefined) => void
  /** Removes only terminal history, preserving work that still needs review. */
  clearHistory: () => void
}

/**
 * Maps observations to lanes without implying that an approved draft was saved.
 * @param activity - Latest observed operation metadata.
 * @param now - Browser time used to expire pending reviews.
 * @returns The effective phase after applying retention.
 */
export function getAiActivityPhase(activity: AiActivity, now: number): AiActivityPhase {
  return activity.expiresAt !== undefined && activity.expiresAt <= now &&
    activity.phase === 'review'
    ? 'expired'
    : activity.phase
}

/**
 * Resolves the board lane for one observed phase.
 * @param phase - Current effective operation phase.
 * @returns A named human-facing lane.
 */
export function getAiActivityStatus(phase: AiActivityPhase): AiActivityStatus {
  if (phase === 'generating' || phase === 'deciding') return 'running'
  if (phase === 'review') return 'review'
  if (phase === 'approved' || phase === 'rejected') return 'completed'
  if (phase === 'failed' || phase === 'unavailable') return 'failed'
  return 'paused'
}

/**
 * Creates bounded session metadata independent of generated draft content.
 * @param now - Clock used by observations and retention checks.
 * @returns An isolated store with stable subscription methods.
 */
export function createAiActivityStore(now: () => number = Date.now): AiActivityStore {
  let activities: readonly AiActivity[] = []
  let nextId = 0
  const listeners = new Set<() => void>()
  /** Publishes a new immutable snapshot. */
  const publish = (next: readonly AiActivity[]) => {
    activities = next
    listeners.forEach((listener) => listener())
  }
  /** Records a phase only when the matching activity still exists. */
  const update = (id: string | undefined, phase: AiActivityPhase, expiresAt?: number, redactSource = false): void => {
    if (!id || !activities.some((activity) => activity.id === id)) return
    publish(activities.map((activity) => activity.id !== id ? activity : {
      ...activity,
      ...(phase === 'unavailable' || redactSource ? { label: undefined, origin: '', sourceUnavailable: true } : {}),
      expiresAt: expiresAt ?? activity.expiresAt,
      phase,
      events: activity.phase === phase
        ? activity.events
        : [...activity.events.slice(-7), { phase, at: now() }],
    }))
  }
  return {
    getSnapshot: () => activities,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: (input) => {
      const id = `ai-activity-${++nextId}`
      // Keep all live operations and at most 30 historical entries.
      let historicalCount = 0
      const retained = activities.filter((activity) => {
        const status = getAiActivityStatus(getAiActivityPhase(activity, now()))
        return status === 'running' || status === 'review' || ++historicalCount <= 29
      })
      publish([{ ...input, id, phase: 'generating', events: [{ phase: 'generating', at: now() }] }, ...retained])
      return id
    },
    update,
    clearSource: (id, recordedDecision) => {
      const activity = activities.find((entry) => entry.id === id)
      const previousDecision = activity?.phase === 'approved' || activity?.phase === 'rejected' ? activity.phase : undefined
      update(id, recordedDecision ?? previousDecision ?? 'unavailable', undefined, true)
    },
    close: (id) => {
      const activity = activities.find((entry) => entry.id === id)
      if (!activity) return
      const status = getAiActivityStatus(getAiActivityPhase(activity, now()))
      if (status === 'running' || status === 'review') update(id, 'closed')
    },
    clearHistory: () => publish(activities.filter((activity) => {
      const status = getAiActivityStatus(getAiActivityPhase(activity, now()))
      return status === 'running' || status === 'review'
    })),
  }
}
