import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { notificationPreferencesControllerFixture, notificationPreferencesFixture } from '../src/notifications/fixtures'
import {
  isCategoryChannelOn,
  resolveNotificationMutes,
  setCategoryChannel,
  setNotificationMuted,
} from '../src/notifications/model/routing'
import { chunkNotificationIds } from '../src/notifications/model/selection'
import { NotificationSettingsPanel } from '../src/notifications/ui/NotificationSettingsPanel'

describe('notification routing model', () => {
  test('keeps only channels turned off and drops a category left with none', () => {
    const off = setCategoryChannel(undefined, 'status', 'slack', false)
    expect(off).toEqual({ status: { slack: false } })
    expect(isCategoryChannelOn(off, 'status', 'slack')).toBe(false)
    expect(isCategoryChannelOn(off, 'status', 'inApp')).toBe(true)
    expect(setCategoryChannel(off, 'status', 'slack', true)).toEqual({})
  })

  test('mutes and unmutes IDs as a sorted, unique list', () => {
    const mutes = resolveNotificationMutes(undefined)
    expect(mutes).toEqual({ projectIds: [], teamIds: [], keepMentions: true, keepApprovals: true })
    const muted = setNotificationMuted(setNotificationMuted(mutes, 'projectIds', 'b', true), 'projectIds', 'a', true)
    expect(muted.projectIds).toEqual(['a', 'b'])
    expect(setNotificationMuted(muted, 'projectIds', 'b', false).projectIds).toEqual(['a'])
    expect(mutes.projectIds).toEqual([])
  })

  test('splits bulk IDs into server-sized chunks in order', () => {
    expect(chunkNotificationIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(chunkNotificationIds([], 50)).toEqual([])
  })
})

describe('notification routing settings', () => {
  test('shows category switches, disabling channels switched off, and lists Teams and Projects to mute', () => {
    const html = renderToStaticMarkup(<NotificationSettingsPanel
      controller={{
        ...notificationPreferencesControllerFixture,
        preferences: {
          ...notificationPreferencesFixture,
          channels: { inApp: true, email: false, push: false },
          categoryChannels: { status: { inApp: false } },
          mutes: { projectIds: ['roadmap', 'gone'], teamIds: [], keepMentions: true, keepApprovals: false },
        },
      }}
      locale="ja"
      muteTargets={[{ id: 'core', name: 'Core', projects: [{ id: 'roadmap', name: 'Roadmap' }] }]}
    />)
    const input = (testId: string) => html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
    expect(input('notification-category-status-inApp')).not.toContain('checked')
    expect(input('notification-category-due-inApp')).toContain('checked')
    expect(input('notification-category-due-email')).toContain('disabled')
    expect(input('notification-mute-project-roadmap')).toContain('checked')
    expect(input('notification-mute-team-core')).not.toContain('checked')
    expect(input('notification-mutes-keepApprovals')).not.toContain('checked')
    expect(html).toContain('Core（Team 全体）')
    expect(html).toContain('gone のミュートを解除')
  })
})
