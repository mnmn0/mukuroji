import { describe, expect, test } from 'bun:test'
import {
  hasWorkItemDetailPanel,
  WORK_ITEM_DETAIL_SURFACE_CAPABILITIES,
} from '@mukuroji/contracts'

describe('Work Item detail surface capabilities', () => {
  test('offers the shared panels on both the Project and Team screens', () => {
    for (const panel of WORK_ITEM_DETAIL_SURFACE_CAPABILITIES.team.panels) {
      expect(hasWorkItemDetailPanel('project', panel)).toBe(true)
    }
    expect(hasWorkItemDetailPanel('team', 'key-actions')).toBe(true)
    expect(hasWorkItemDetailPanel('team', 'external-links')).toBe(true)
    expect(hasWorkItemDetailPanel('team', 'actual-dates')).toBe(true)
  })

  test('keeps Project-owned panels and actual date correction on the Project screen', () => {
    expect(hasWorkItemDetailPanel('project', 'schedule-baseline')).toBe(true)
    expect(hasWorkItemDetailPanel('project', 'customer-impact')).toBe(true)
    expect(hasWorkItemDetailPanel('team', 'schedule-baseline')).toBe(false)
    expect(hasWorkItemDetailPanel('team', 'customer-impact')).toBe(false)
    expect(WORK_ITEM_DETAIL_SURFACE_CAPABILITIES.project.correctsActualDates).toBe(true)
    expect(WORK_ITEM_DETAIL_SURFACE_CAPABILITIES.team.correctsActualDates).toBe(false)
  })
})
