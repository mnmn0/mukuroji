import { expect, test } from 'bun:test'
import { CALENDAR_FEED_PROJECT_LIMIT } from '@mukuroji/contracts'
import { InMemoryCalendarFeedStore } from './adapter-out/dynamodb/calendar-feed-store'
import {
  CalendarFeedError,
  createCalendarFeedToken,
  issueCalendarFeedUseCase,
  parseCalendarFeedToken,
  resolveCalendarFeedTokenUseCase,
} from './application/calendar-feed-use-cases'

/** Owner of the test feeds. */
const owner = { workspaceId: 'workspace#1', memberKey: 'demo@example.com' }

test('round-trips a token and rejects altered ones', () => {
  const { token, tokenHash } = createCalendarFeedToken(owner.workspaceId, Buffer.alloc(32, 7))
  expect(parseCalendarFeedToken(`${token}.ics`)).toEqual({ workspaceId: owner.workspaceId, tokenHash })
  expect(parseCalendarFeedToken(token)).toEqual({ workspaceId: owner.workspaceId, tokenHash })
  const [workspacePart, secret] = token.split('.')
  expect(parseCalendarFeedToken(`${workspacePart}.${secret?.slice(1)}`)).toBeUndefined()
  expect(parseCalendarFeedToken(`${workspacePart}=.${secret}`)).toBeUndefined()
  expect(parseCalendarFeedToken(`.${secret}`)).toBeUndefined()
  expect(parseCalendarFeedToken(undefined)).toBeUndefined()
  // A different secret never maps to the same digest.
  expect(createCalendarFeedToken(owner.workspaceId, Buffer.alloc(32, 8)).tokenHash).not.toBe(tokenHash)
})

test('limits the number of Project feeds but still lets an existing one be replaced', async () => {
  const store = new InMemoryCalendarFeedStore()
  const now = '2026-11-24T00:00:00.000Z'
  for (let index = 0; index < CALENDAR_FEED_PROJECT_LIMIT; index += 1) {
    await issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: `p${index}` }, { now })
  }
  const over = issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'extra' }, { now })
  expect(over).rejects.toBeInstanceOf(CalendarFeedError)
  await over.catch(() => undefined)
  const replaced = await issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'p0' }, { now })
  expect(await resolveCalendarFeedTokenUseCase(store, replaced.feedPath.split('/').at(-1)))
    .toMatchObject({ workspaceId: owner.workspaceId, record: { projectId: 'p0' } })
  // The member feed does not count toward the Project limit.
  await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, { now })
})
