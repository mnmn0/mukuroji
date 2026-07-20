import { describe, expect, test } from 'bun:test'
import type { AnalyticsSnapshotListResponse } from '@mukuroji/contracts'
import { analyticsSnapshotRecordFixture } from '../src/analytics/fixtures'
import { resolveAnalyticsSnapshotAutoPagination } from '../src/analytics/model/snapshotPagination'

const targetSnapshot = {
  ...analyticsSnapshotRecordFixture,
  id: 'snapshot-on-second-page',
}

describe('Analytics snapshot auto pagination', () => {
  test('loads a second page for a shared snapshot and stops after finding it', () => {
    const firstPage = {
      inspectedCount: 50,
      nextCursor: 'page-2',
      snapshots: [],
    } satisfies AnalyticsSnapshotListResponse
    const secondPage = {
      inspectedCount: 1,
      snapshots: [targetSnapshot],
    } satisfies AnalyticsSnapshotListResponse

    expect(resolveAnalyticsSnapshotAutoPagination(
      [firstPage],
      targetSnapshot.id,
      1,
    )).toBe('load-next-page')
    expect(resolveAnalyticsSnapshotAutoPagination(
      [firstPage],
      targetSnapshot.id,
      2,
    )).toBe('idle')
    expect(resolveAnalyticsSnapshotAutoPagination(
      [firstPage, secondPage],
      targetSnapshot.id,
      2,
    )).toBe('idle')
  })

  test('stops when the API repeats a cursor instead of looping', () => {
    const firstPage = {
      inspectedCount: 50,
      nextCursor: 'repeated',
      snapshots: [],
    } satisfies AnalyticsSnapshotListResponse
    const secondPage = {
      inspectedCount: 50,
      nextCursor: 'repeated',
      snapshots: [],
    } satisfies AnalyticsSnapshotListResponse

    expect(resolveAnalyticsSnapshotAutoPagination(
      [firstPage, secondPage],
      targetSnapshot.id,
      2,
    )).toBe('cursor-repeated')
  })

  test('stops automatic loading after ten pages so manual loading can continue', () => {
    const pages = Array.from({ length: 10 }, (_, index) => ({
      inspectedCount: 50,
      nextCursor: `page-${index + 2}`,
      snapshots: [],
    })) satisfies AnalyticsSnapshotListResponse[]

    expect(resolveAnalyticsSnapshotAutoPagination(
      pages,
      targetSnapshot.id,
      pages.length,
    )).toBe('page-limit-reached')
  })
})
