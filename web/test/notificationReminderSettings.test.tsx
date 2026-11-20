import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NOTIFICATION_REMINDER_DAY_FIELDS,
  PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS,
  type NotificationReminderDayField,
} from '@mukuroji/contracts'
import { NotificationSettingsPanel } from '../src/notifications/ui/NotificationSettingsPanel'
import { TeamReminderSettingsPanel } from '../src/notifications/ui/TeamReminderSettingsPanel'
import { createReminderDaysDraft, readReminderDaysDraft } from '../src/notifications/model/reminderDays'
import {
  finishTeamReminderSave,
  listTeamReminderSaveErrors,
  readTeamReminderSave,
  startTeamReminderSave,
} from '../src/notifications/model/teamReminderSaveState'
import { notificationPreferencesControllerFixture, notificationPreferencesFixture } from '../src/notifications/fixtures'
import type { TeamReminderSettingsController } from '../src/notifications/mutations/useTeamReminderSettings'
import { createTranslator } from '../src/shared/i18n/i18n'

/**
 * Returns the input whose accessible name is a field label, so a lost label association fails.
 *
 * Each field renders its input inside the `<label>` that holds the visible name.
 *
 * @param html - Rendered markup.
 * @param locale - Locale the markup was rendered in.
 * @param field - Reminder day field.
 * @returns The input tag, or undefined when no label with that name holds an input.
 */
function findInput(html: string, locale: 'ja' | 'en', field: NotificationReminderDayField) {
  const name = createTranslator(locale)(`workspace.reminders.field.${field}`)
  for (const [, content = ''] of html.matchAll(/<label[^>]*>(.*?)<\/label>/g)) {
    // The label's first child holds the visible name; compare it as text instead of stripping tags.
    const labelText = content.match(/^<span[^>]*>([^<]*)<\/span>/)?.[1]
    if (labelText === name) return content.match(/<input[^>]*>/)?.[0]
  }
  return undefined
}

/**
 * Creates a Team reminder controller around loaded settings.
 *
 * @param canManage - Whether the caller manages the Team.
 * @param isSaving - Whether a save is running.
 * @returns Controller fixture.
 */
function createTeamController(
  canManage: boolean,
  isSaving = false,
  saveResult?: TeamReminderSettingsController['saveResult'],
): TeamReminderSettingsController {
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
    isUnavailable: false,
    isSaving,
    ...(saveResult ? { saveResult } : {}),
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
    expect(findInput(html, 'ja', 'dueSoonDays')).toContain('value="5"')
    expect(findInput(html, 'ja', 'staleStartedDays')).toContain('placeholder="Team の設定"')
    expect(findInput(html, 'ja', 'overdueEscalationDays')).toBeUndefined()
  })

  test('lets a Team manager edit the Team days and shows the defaults as placeholders', () => {
    const t = createTranslator('en')
    const managerHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(true)} t={t} />)
    expect(findInput(managerHtml, 'en', 'overdueEscalationDays')).toContain('value="14"')
    expect(findInput(managerHtml, 'en', 'dueSoonDays')).toContain('placeholder="Default 3 days"')
    expect(managerHtml).toContain('team-reminder-settings-save')

    const memberHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(false)} t={t} />)
    expect(memberHtml).toContain('Only Team managers can change these.')
    expect(findInput(memberHtml, 'en', 'dueSoonDays')).toContain('disabled=""')
    expect(memberHtml).not.toContain('team-reminder-settings-save')

    // Saving remounts the form with the saved revision, so the fields are locked meanwhile.
    const savingHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(true, true)} t={t} />)
    expect(findInput(savingHtml, 'en', 'dueSoonDays')).toContain('disabled=""')
    expect(findInput(managerHtml, 'en', 'dueSoonDays')).not.toContain('disabled=""')
    // A failed save ends the saving state, so the manager can edit and retry.
    const failedHtml = renderToStaticMarkup(<TeamReminderSettingsPanel controller={createTeamController(true, false, 'error')} t={t} />)
    expect(findInput(failedHtml, 'en', 'dueSoonDays')).not.toContain('disabled=""')
  })

  test('keeps each Team\'s save state with that Team when the page moves to another Team', () => {
    const expired = Object.assign(new Error('Session expired'), { status: 401 })
    // Team A starts saving, then the page moves to Team B.
    let states = startTeamReminderSave({}, 'team-a')
    expect(readTeamReminderSave(states, 'team-a')).toEqual({ isSaving: true })
    expect(readTeamReminderSave(states, 'team-b')).toEqual({ isSaving: false })

    // Team B saves on its own while A is still running.
    states = startTeamReminderSave(states, 'team-b')
    states = finishTeamReminderSave(states, 'team-b', 'saved')
    expect(readTeamReminderSave(states, 'team-b')).toEqual({ isSaving: false, result: 'saved' })
    expect(readTeamReminderSave(states, 'team-a').isSaving).toBe(true)

    // A's late failure stays with A, but an expired session still reaches the shell from B's page.
    states = finishTeamReminderSave(states, 'team-a', 'error', expired)
    expect(readTeamReminderSave(states, 'team-b')).toEqual({ isSaving: false, result: 'saved' })
    expect(readTeamReminderSave(states, 'team-a')).toEqual({ isSaving: false, result: 'error', error: expired })
    expect(listTeamReminderSaveErrors(states)).toEqual([expired])

    // Retrying A clears its previous outcome and error.
    states = startTeamReminderSave(states, 'team-a')
    expect(readTeamReminderSave(states, 'team-a')).toEqual({ isSaving: true })
    expect(listTeamReminderSaveErrors(states)).toEqual([])
    expect(readTeamReminderSave(states, undefined)).toEqual({ isSaving: false })
  })

  test('turns blank fields into unset days and rejects anything but whole days from 1 to 365', () => {
    expect(createReminderDaysDraft(PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: 2 })).toEqual({ dueSoonDays: '2' })
    expect(readReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: ' 4 ', staleStartedDays: '' })).toEqual({ dueSoonDays: 4 })
    for (const value of ['0', '366', '1.5', '-1', 'abc']) {
      expect(readReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, { dueSoonDays: value })).toBeUndefined()
    }
  })
})
