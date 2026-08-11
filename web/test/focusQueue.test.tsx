import { describe, expect, test } from 'bun:test'
import type { FocusQueueResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  focusConfigurationFixture,
  focusQueueResponseFixture,
} from '../src/features/focus-queue/fixtures'
import {
  createFocusScheduleOperation,
  findDeepLinkedFocusItem,
  getFocusQueueItems,
  getFocusPolicyForEditor,
  getFocusSourcePath,
  resolveFocusQueueNavigationIndex,
  resolveSelectedFocusItem,
  resolveFocusSnoozeUntil,
} from '../src/features/focus-queue/model/focusQueue'
import { FocusQueue } from '../src/features/focus-queue/ui/FocusQueue'
import { readFocusPolicyOverrides } from '../src/features/focus-queue/model/focusPolicyForm'
import { FocusQueueApiError } from '../src/features/focus-queue/api/focusQueue'
import { resolveWorkspaceFocusOverviewState } from '../src/features/focus-queue/queries/useWorkspaceFocusOverview'
import { createTranslator } from '../src/shared/i18n/i18n'

describe('Focus queue', () => {
  test('preserves server order and resolves exact Inbox event correlation', () => {
    const nowItems = getFocusQueueItems(focusQueueResponseFixture, 'now')
    const allItems = focusQueueResponseFixture.sections.flatMap((group) => group.items)

    expect(nowItems.map((item) => item.workItem.id)).toEqual(['WI-194', 'WI-202'])
    expect(allItems.map((item) => item.rank.components.reduce(
      (total, component) => total + component.contribution,
      0,
    ))).toEqual(allItems.map((item) => item.rank.score))
    expect(findDeepLinkedFocusItem(focusQueueResponseFixture, {
      sourceEventId: 'event-WI-202-mention',
      teamId: 'core-team',
      workItemId: 'WI-202',
    })?.id).toBe('focus-WI-202')
    expect(findDeepLinkedFocusItem(focusQueueResponseFixture, {
      sourceEventId: 'event-no-longer-visible',
      teamId: 'core-team',
      workItemId: 'WI-202',
    })).toBeUndefined()
  })

  test('clamps roving keyboard navigation without wrapping server order', () => {
    expect(resolveFocusQueueNavigationIndex(0, 2, 'previous')).toBe(0)
    expect(resolveFocusQueueNavigationIndex(0, 2, 'next')).toBe(1)
    expect(resolveFocusQueueNavigationIndex(1, 2, 'next')).toBe(1)
    expect(resolveFocusQueueNavigationIndex(1, 2, 'first')).toBe(0)
    expect(resolveFocusQueueNavigationIndex(0, 2, 'last')).toBe(1)
    expect(resolveFocusQueueNavigationIndex(0, 0, 'next')).toBe(-1)
  })

  test('keeps a visible URL deep link ahead of an earlier local selection', () => {
    const nowItems = getFocusQueueItems(focusQueueResponseFixture, 'now')
    expect(resolveSelectedFocusItem(
      nowItems,
      'focus-WI-202',
      'focus-WI-194',
    )?.id).toBe('focus-WI-202')
  })

  test('preserves an explicit Team policy selection when no item is selected', () => {
    const firstPolicy = focusQueueResponseFixture.effectivePolicies[0]
    if (!firstPolicy) throw new Error('The Focus fixture requires one effective policy.')
    const response: FocusQueueResponse = {
      ...focusQueueResponseFixture,
      effectivePolicies: [
        firstPolicy,
        { ...firstPolicy, id: 'effective-empty-team', teamId: 'empty-team' },
      ],
      policyCapabilities: {
        ...focusQueueResponseFixture.policyCapabilities,
        editableTeamIds: ['core-team', 'empty-team'],
      },
    }

    expect(getFocusPolicyForEditor(response, undefined, 'empty-team')?.teamId).toBe('empty-team')
  })

  test('hides cached Focus after authorization failures but retains it for transient errors', () => {
    expect(resolveWorkspaceFocusOverviewState(
      focusQueueResponseFixture,
      new FocusQueueApiError(403, 'Forbidden'),
    )).toEqual({ isUnavailable: true, response: undefined })
    expect(resolveWorkspaceFocusOverviewState(
      focusQueueResponseFixture,
      new FocusQueueApiError(503, 'Unavailable'),
    )).toEqual({ isUnavailable: false, response: focusQueueResponseFixture })
  })

  test('creates deterministic snooze times and schedule operations', () => {
    const now = new Date('2026-08-09T01:00:00.000Z')
    const item = getFocusQueueItems(focusQueueResponseFixture, 'now')[0]
    if (!item) throw new Error('The Focus fixture requires one Now item.')

    const nextWeek = new Date(resolveFocusSnoozeUntil('next-week', now))
    expect(nextWeek.getDate()).toBe(new Date(2026, 7, 16, 9).getDate())
    expect(nextWeek.getHours()).toBe(9)
    const lateToday = new Date(2026, 7, 9, 22, 30)
    const laterToday = new Date(resolveFocusSnoozeUntil('later-today', lateToday))
    expect(laterToday.getDate()).toBe(lateToday.getDate())
    expect(laterToday.getTime()).toBeGreaterThan(lateToday.getTime())
    expect(createFocusScheduleOperation(item, '2026-08-20')).toEqual({
      targetDate: '2026-08-20',
      type: 'move',
    })
  })

  test('keeps personal policy replacements sparse across different Team layers', () => {
    const formData = new FormData()
    formData.set('weight-urgent', '42')

    expect(readFocusPolicyOverrides(formData)).toEqual({
      invalidFieldNames: [],
      overrides: { weights: { urgent: 42 } },
    })
    formData.set('dueSoonDays', '366')
    expect(readFocusPolicyOverrides(formData)).toEqual({
      invalidFieldNames: ['dueSoonDays'],
      overrides: { weights: { urgent: 42 } },
    })
  })

  test('falls back from an inaccessible requested signal to another authorized source', () => {
    const item = getFocusQueueItems(focusQueueResponseFixture, 'now')[0]
    const firstSignal = item?.signals[0]
    if (!item || !firstSignal) throw new Error('The Focus fixture requires one signal.')
    const restrictedItem = {
      ...item,
      signals: item.signals.map((signal) => ({
        ...signal,
        permission: { canOpenSource: signal.id !== firstSignal.id },
      })),
    }

    expect(getFocusSourcePath(restrictedItem, firstSignal.source.eventId)).toBe(
      restrictedItem.signals[1]?.source.deepLink,
    )
    expect(getFocusSourcePath({
      ...restrictedItem,
      signals: restrictedItem.signals.map((signal) => ({
        ...signal,
        permission: { canOpenSource: false },
      })),
    })).toBeUndefined()
  })

  test('renders rank reasons, resolution conditions, and selection-only actions', () => {
    const html = renderToStaticMarkup(
      <FocusQueue
        configurationsByTeam={{ 'core-team': focusConfigurationFixture }}
        locale="en"
        onAssignToViewer={async () => undefined}
        onComplete={async () => undefined}
        onOpenItem={() => undefined}
        onOpenSource={() => undefined}
        onSectionChange={() => undefined}
        onSnooze={async () => undefined}
        onStatusChange={async () => undefined}
        onWatchingChange={async () => undefined}
        response={focusQueueResponseFixture}
        section="now"
        t={createTranslator('en')}
      />,
    )

    expect(html.indexOf('Unblock the release approval flow')).toBeLessThan(
      html.indexOf('Answer the enterprise rollout question'),
    )
    expect(html).toContain('Why this is in Focus')
    expect(html).toContain('Complete the predecessor Work Item')
    expect(html).toContain('Score 25')
    expect(html).toMatch(/<button[^>]*class="workbench-button-primary min-h-\[44px\][^>]*>Open</u)
    expect(html).toMatch(/<button[^>]*data-focus-queue-primary="true"[^>]*tabindex="0"/u)
    expect(html).toMatch(/<button[^>]*data-focus-queue-primary="true"[^>]*tabindex="-1"/u)
    expect(html).toMatch(/<input(?=[^>]*name="weight-blocker")(?=[^>]*placeholder="10")[^>]*>/u)
    expect(html).toMatch(/<input(?=[^>]*name="weight-urgent")(?=[^>]*value="8")[^>]*>/u)
    expect(html.match(/aria-controls="focus-item-details-/gu)).toHaveLength(1)
  })

  test('keeps policy controls available when the selected section is empty', () => {
    const emptyNowResponse: FocusQueueResponse = {
      ...focusQueueResponseFixture,
      sections: focusQueueResponseFixture.sections.map((group) => group.section === 'now'
        ? { ...group, items: [] }
        : group),
    }
    const html = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        onOpenItem={() => undefined}
        onSectionChange={() => undefined}
        response={emptyNowResponse}
        section="now"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Focus priority rules')
    expect(html).toContain('Policy scope')
    expect(html).toContain('>Team</option>')
  })

  test('exposes every editable Team policy when the selected section is empty', () => {
    const firstPolicy = focusQueueResponseFixture.effectivePolicies[0]
    if (!firstPolicy) throw new Error('The Focus fixture requires one effective policy.')
    const emptyTeamResponse: FocusQueueResponse = {
      ...focusQueueResponseFixture,
      effectivePolicies: [
        firstPolicy,
        { ...firstPolicy, id: 'effective-empty-team', teamId: 'empty-team' },
      ],
      policyCapabilities: {
        ...focusQueueResponseFixture.policyCapabilities,
        editableTeamIds: ['core-team', 'empty-team'],
      },
      sections: focusQueueResponseFixture.sections.map((group) =>
        group.section === 'now' ? { ...group, items: [] } : group,
      ),
    }
    const html = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        onOpenItem={() => undefined}
        onSectionChange={() => undefined}
        response={emptyTeamResponse}
        section="now"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('aria-label="Team policy"')
    expect(html).toContain('value="empty-team"')
  })

  test('keeps policy failures separate from item mutation failures', () => {
    const html = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        onOpenItem={() => undefined}
        onSectionChange={() => undefined}
        policyError
        response={focusQueueResponseFixture}
        section="now"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Could not update the rules')
    expect(html).not.toContain('The action could not be completed')
  })

  test('distinguishes a refreshed conflict from a generic action failure', () => {
    const t = createTranslator('en')
    const conflict = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        mutationError="conflict"
        onSectionChange={() => undefined}
        response={focusQueueResponseFixture}
        section="now"
        t={t}
      />,
    )
    const failure = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        mutationError="failure"
        onSectionChange={() => undefined}
        response={focusQueueResponseFixture}
        section="now"
        t={t}
      />,
    )

    expect(conflict).toContain('The latest Focus data has been loaded')
    expect(failure).toContain('The action could not be completed')
  })

  test('renders a permission explanation when no action is authorized', () => {
    const firstItem = getFocusQueueItems(focusQueueResponseFixture, 'now')[0]
    if (!firstItem) throw new Error('The Focus fixture requires one Now item.')
    const restrictedResponse: FocusQueueResponse = {
      ...focusQueueResponseFixture,
      sections: focusQueueResponseFixture.sections.map((group) => group.section === 'now'
        ? {
            ...group,
            items: [{
              ...firstItem,
              signals: firstItem.signals.map((signal) => ({
                ...signal,
                permission: { canOpenSource: false },
              })),
              capabilities: {
                assign: false,
                changeStatus: false,
                complete: false,
                openSource: true,
                schedule: false,
                snooze: false,
                watch: false,
              },
            }],
          }
        : group),
    }
    const html = renderToStaticMarkup(
      <FocusQueue
        locale="en"
        onOpenSource={() => undefined}
        onSectionChange={() => undefined}
        response={restrictedResponse}
        section="now"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Your current permissions do not allow this action.')
    expect(html).not.toContain('>Open source<')
  })
})
