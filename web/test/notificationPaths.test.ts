import { describe, expect, test } from 'bun:test'
import {
  resolveNotificationPath,
} from '../src/notifications/model/paths'
import { isSafeApplicationPath } from '../src/shared/routing/applicationPath'

describe('notification deep links', () => {
  test('prefers a structured Team Triage target over a generic deep link', () => {
    expect(resolveNotificationPath({
      deepLink: '/inbox',
      eventType: 'triage.assigned',
      id: 'notification-triage-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      reasons: ['assigned'],
      state: 'unread',
      teamId: 'design/team',
      triageEntryId: 'entry/42',
    })).toBe('/teams/design%2Fteam/triage?entryId=entry%2F42')
  })

  test('uses structured team, project, Work Item, and comment scope', () => {
    expect(resolveNotificationPath({
      commentId: 'comment/1',
      eventType: 'comment.mentioned',
      id: 'notification-1',
      issueId: 'issue/1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      projectId: 'shared launch',
      reasons: ['mention'],
      rootCommentId: 'root/1',
      state: 'unread',
      teamId: 'design/team',
    })).toBe(
      '/projects/shared%20launch/issues?teamId=design%2Fteam&issueId=issue%2F1&commentId=comment%2F1&rootCommentId=root%2F1',
    )
  })

  test('normalizes the legacy projected REST-looking team path', () => {
    expect(resolveNotificationPath({
      commentId: 'comment-1',
      deepLink: '/teams/core-team/issues/issue-1',
      eventType: 'comment.created',
      id: 'notification-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      reasons: ['watcher'],
      state: 'unread',
    })).toBe('/teams/core-team/issues?issueId=issue-1&commentId=comment-1')
  })

  test('rejects external and protocol-relative deep links', () => {
    expect(isSafeApplicationPath('/focus?workItemId=work-item-1')).toBe(true)
    expect(isSafeApplicationPath('https://example.com/steal-session')).toBe(false)
    expect(isSafeApplicationPath('//example.com/steal-session')).toBe(false)
    expect(isSafeApplicationPath('/focus\\attacker.example')).toBe(false)
    expect(isSafeApplicationPath('/\n/attacker.example')).toBe(false)
    expect(isSafeApplicationPath('/\t/attacker.example')).toBe(false)
    expect(resolveNotificationPath({
      deepLink: '//example.com/steal-session',
      eventType: 'automation.failed',
      id: 'notification-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      reasons: ['watcher'],
      state: 'unread',
    })).toBeUndefined()
  })
})
