import type { AgentRunArtifactStatus } from '@mukuroji/contracts'
import type { AgentRunArtifactStatusStore } from '../dynamodb/agent-run-artifact-status-store'

/** In-memory artifact status store for tests and local composition without DynamoDB. */
export class InMemoryAgentRunArtifactStatusStore implements AgentRunArtifactStatusStore {
  /** Statuses by Work Item key and URL. */
  readonly statuses = new Map<string, Map<string, AgentRunArtifactStatus>>()
  /** Last refresh claim time by Work Item key. */
  readonly #refreshedAt = new Map<string, number>()

  /** @inheritdoc */
  async getStatuses(directoryId: string, teamId: string, workItemId: string, urls: readonly string[]): Promise<AgentRunArtifactStatus[]> {
    const saved = this.statuses.get(workItemKey(directoryId, teamId, workItemId))
    return [...new Set(urls)].flatMap((url) => {
      const status = saved?.get(url)
      return status === undefined ? [] : [structuredClone(status)]
    })
  }

  /** @inheritdoc */
  async saveStatuses(directoryId: string, teamId: string, workItemId: string, statuses: readonly AgentRunArtifactStatus[]): Promise<void> {
    const key = workItemKey(directoryId, teamId, workItemId)
    const saved = this.statuses.get(key) ?? new Map<string, AgentRunArtifactStatus>()
    for (const status of statuses) {
      const current = saved.get(status.url)
      if (current === undefined || current.checkedAt < status.checkedAt) saved.set(status.url, structuredClone(status))
    }
    this.statuses.set(key, saved)
  }

  /** @inheritdoc */
  async claimRefresh(directoryId: string, teamId: string, workItemId: string, now: Date, minimumIntervalMs: number): Promise<boolean> {
    const key = workItemKey(directoryId, teamId, workItemId)
    const last = this.#refreshedAt.get(key)
    if (last !== undefined && last > now.getTime() - minimumIntervalMs) return false
    this.#refreshedAt.set(key, now.getTime())
    return true
  }
}

/**
 * Builds the map key of one Work Item.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns Map key.
 */
function workItemKey(directoryId: string, teamId: string, workItemId: string): string {
  return `${directoryId}|${teamId}|${workItemId}`
}
