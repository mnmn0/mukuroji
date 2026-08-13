import { describe, expect, test } from 'bun:test'
import type { WorkspaceMember } from '../src/workspace/api'
import {
  formatIssueMentionLabel,
  resolveIssueMentionMemberKeys,
} from '../src/issues/model/commentMentions'

const members = [
  {
    id: 'ann@example.com',
    memberKey: 'ann@example.com',
    email: 'ann@example.com',
    name: 'Ann',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
  {
    id: 'anna@example.com',
    memberKey: 'anna@example.com',
    email: 'anna@example.com',
    name: 'Anna',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
  {
    id: 'alex-one@example.com',
    memberKey: 'alex-one@example.com',
    email: 'alex-one@example.com',
    name: 'Alex',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
  {
    id: 'alex-two@example.com',
    memberKey: 'alex-two@example.com',
    email: 'alex-two@example.com',
    name: 'Alex',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
] satisfies WorkspaceMember[]

describe('issue mention tokens', () => {
  test('does not treat a longer member name as a shorter mention', () => {
    expect(
      resolveIssueMentionMemberKeys(
        '@Anna will verify this.',
        ['ann@example.com', 'anna@example.com'],
        members,
      ),
    ).toEqual(['anna@example.com'])
  })

  test('uses the same duplicate-name discriminator for insertion and parsing', () => {
    const firstAlex = members.find(
      (member) => member.memberKey === 'alex-one@example.com',
    )
    if (!firstAlex) throw new Error('Missing duplicate-name fixture.')
    const label = formatIssueMentionLabel(firstAlex, members)

    expect(label).toBe('Alex (alex-one@example.com)')
    expect(
      resolveIssueMentionMemberKeys(
        `Please ask @${label}.`,
        ['alex-one@example.com', 'alex-two@example.com'],
        members,
      ),
    ).toEqual(['alex-one@example.com'])
  })
})
