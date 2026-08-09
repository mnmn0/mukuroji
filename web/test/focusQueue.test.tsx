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
  getFocusSourcePath,
  resolveFocusQueueNavigationIndex,
  resolveFocusSnoozeUntil,
} from '../src/features/focus-queue/model/focusQueue'
import { FocusQueue } from '../src/features/focus-queue/ui/FocusQueue'
import { readFocusPolicyOverrides } from '../src/features/focus-queue/model/focusPolicyForm'
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

  test('creates deterministic snooze times and schedule operations', () => {
    const now = new Date('2026-08-09T01:00:00.000Z')
    const item = getFocusQueueItems(focusQueueResponseFixture, 'now')[0]
    if (!item) throw new Error('The Focus fixture requires one Now item.')

    expect(resolveFocusSnoozeUntil('next-week', now)).toBe('2026-08-16T01:00:00.000Z')
    expect(createFocusScheduleOperation(item, '2026-08-20')).toEqual({
      targetDate: '2026-08-20',
      type: 'move',
    })
  })

  test('keeps personal policy replacements sparse across different Team layers', () => {
    const formData = new FormData()
    formData.set('weight-urgent', '42')

    expect(readFocusPolicyOverrides(formData)).toEqual({
      weights: { urgent: 42 },
    })
    formData.set('dueSoonDays', '366')
    expect(readFocusPolicyOverrides(formData)).toBeUndefined()
  })

  test('opens only a signal source authorized by the server snapshot', () => {
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
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('placeholder="10"')
    expect(html).toContain('value="8"')
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
    expect(html).not.toContain('Your current permissions do not allow this action.')
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
