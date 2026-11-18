import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NOTIFICATION_REMINDER_DAY_FIELDS,
  PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS,
} from '@mukuroji/contracts'
import { NotificationSettingsPanel } from '../src/notifications/ui/NotificationSettingsPanel'
import { TeamReminderSettingsPanel } from '../src/notifications/ui/TeamReminderSettingsPanel'
import { createReminderDaysDraft, readReminderDaysDraft } from '../src/notifications/model/reminderDays'
import { notificationPreferencesControllerFixture, notificationPreferencesFixture } from '../src/notifications/fixtures'
import type { TeamReminderSettingsController } from '../src/notifications/mutations/useTeamReminderSettings'
import { createTranslator } from '../src/shared/i18n/i18n'

/** Returns the rendered input with a test ID. */
function findInput(html: string, testId: string) {
  return html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0]
}

/** Creates a Team reminder controller around loaded settings. */
function createTeamController(canManage: boolean): TeamReminderSettingsController {
  return {
    settings: {
      teamId: 'core',
      days: { overdueEscalationDays: 14 },
      defaults: {
        dueSoonDays: 3,
        overdueReminderIntervalDays: 7,
        overdueEscalationDays: 7,
        staleStartedDays: 7,
        timesheetReminderDays: 7,
      },
      revision: 2,
      canManage,
    },
    isLoading: false,
    hasLoadError: false,
    isSaving: false,
    sessionErrors: [],
    refresh: async () => undefined,
    save: async () => true,
  }
}

describe('reminder day settings', () => {
  test('shows the member\'s own days and leaves escalation to the Team', () => {
    const html = renderToStaticMarkup(<NotificationSettingsPanel locale="ja" controller={{
      ...notificationPreferencesControllerFixture,
      preferences: { ...notificationPreferencesFixture, reminderDays: { dueSoonDays: 5 } },
    }} />)
    expect(html).toContain('リマインドの日数')
    expect(findInput(html, 'notification-reminder-dueSoonDays')).toContain('value="5"')
    expect(findInput(html, 'notification-reminder-staleStartedDays')).toContain('placeholder="Team の設定"')
    expect(findInput(html, 'notification-reminder-overdueEscalationDays')).toBeUndefined()
  })

  test('lets a Team manager edit the Team days and shows the defaults as placeholders', () => {
    const t = createTranslator('en')
    const managerHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(true)} t={t} />)
    expect(findInput(managerHtml, 'team-reminder-overdueEscalationDays')).toContain('value="14"')
    expect(findInput(managerHtml, 'team-reminder-dueSoonDays')).toContain('placeholder="Default 3 days"')
    expect(managerHtml).toContain('team-reminder-settings-save')

    const memberHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(false)} t={t} />)
    expect(memberHtml).toContain('Only Team managers can change these.')
    expect(findInput(memberHtml, 'team-reminder-dueSoonDays')).toContain('disabled')
    expect(memberHtml).not.toContain('team-reminder-settings-save')
  })

  test('turns blank fields into unset days and rejects anything but whole days from 1 to 365', () => {
    expect(createReminderDaysDraft(PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: 2 })).toEqual({ dueSoonDays: '2' })
    expect(readReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: ' 4 ', staleStartedDays: '' })).toEqual({ dueSoonDays: 4 })
    for (const value of ['0', '366', '1.5', '-1', 'abc']) {
      expect(readReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: value })).toBeUndefined()
    }
  })
})
