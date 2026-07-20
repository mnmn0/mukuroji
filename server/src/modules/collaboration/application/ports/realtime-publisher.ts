/** Collaboration application が realtime invalidation を配送する port です。 */
export interface CollaborationRealtimePublisher {
  /** 指定 scope の購読者へ invalidation payload を配送します。 */
  publish(
    scopeKey: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>
}
