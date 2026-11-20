import type { TeamFactoryAnalyticsResponse } from '@mukuroji/contracts'

/** Period lengths in days the Factory analytics summary offers, shortest first. */
export const FACTORY_ANALYTICS_PERIOD_DAYS = [7, 30, 90] as const

/** One period length the Factory analytics summary offers. */
export type FactoryAnalyticsPeriodDays = (typeof FACTORY_ANALYTICS_PERIOD_DAYS)[number]

/** Period length the summary shows first. */
export const DEFAULT_FACTORY_ANALYTICS_PERIOD_DAYS: FactoryAnalyticsPeriodDays = 30

/** Milliseconds in one day. */
const millisecondsPerDay = 86_400_000

/**
 * Builds the period that ends now and reaches back a number of days.
 *
 * @param days - Period length in days.
 * @param now - End of the period.
 * @returns UTC ISO 8601 bounds of the period.
 */
export function createFactoryAnalyticsPeriod(days: FactoryAnalyticsPeriodDays, now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * millisecondsPerDay).toISOString(), to: now.toISOString() }
}

/**
 * Reads a period length from untrusted input such as a select value.
 *
 * @param value - Raw value.
 * @returns The period length, or undefined when the summary does not offer it.
 */
export function readFactoryAnalyticsPeriodDays(value: string): FactoryAnalyticsPeriodDays | undefined {
  return FACTORY_ANALYTICS_PERIOD_DAYS.find((days) => String(days) === value)
}

/**
 * Checks whether the server left runs out of the analytics because it reached a read bound.
 *
 * @param analytics - Factory analytics.
 * @returns True when any read bound was reached.
 */
export function isFactoryAnalyticsIncomplete(analytics: TeamFactoryAnalyticsResponse): boolean {
  return analytics.finishedRunsHasMore || analytics.workItemsHasMore || analytics.historyHasMore
}
