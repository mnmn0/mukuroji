import { describe, expect, test } from 'bun:test'
import { WORKSPACE_BULK_INVITATION_MAX_ROWS } from '@mukuroji/contracts'
import type { WorkspaceInvitation, WorkspaceMember } from '../src/workspace/api/access'
import {
  createBulkInvitationRetryCsv,
  planBulkInvitation,
  type BulkInvitationContext,
} from '../src/workspace/model/bulkInvitation'
import {
  createWorkspaceMemberCsv,
  emptyWorkspaceMemberFilter,
  filterWorkspaceMembers,
} from '../src/workspace/model/memberDirectory'
import { sendBulkWorkspaceInvitations } from '../src/workspace/mutations/bulkWorkspaceInvitations'

/**
 * Builds a Workspace member for the tests.
 *
 * @param overrides - Fields that differ from the default member.
 * @returns The member.
 */
function member(overrides: Partial<WorkspaceMember> & { email: string }): WorkspaceMember {
  return {
    createdAt: '2026-11-01T00:00:00.000Z',
    id: overrides.email,
    memberKey: overrides.email,
    role: 'member',
    status: 'active',
    updatedAt: '2026-11-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

/**
 * Builds an invitation for the tests.
 *
 * @param email - Invited address.
 * @param status - Invitation status.
 * @returns The invitation.
 */
function invitation(email: string, status: WorkspaceInvitation['status']): WorkspaceInvitation {
  return {
    createdAt: '2026-11-01T00:00:00.000Z',
    deliveryStatus: 'sent',
    email,
    expiresAt: '2026-11-08T00:00:00.000Z',
    id: email,
    identityOwnership: 'workspace-created',
    role: 'member',
    status,
    updatedAt: '2026-11-01T00:00:00.000Z',
    version: 1,
  }
}

const context: BulkInvitationContext = {
  allowedRoles: ['member', 'guest'],
  defaultRole: 'member',
  invitations: [invitation('pending@example.com', 'pending'), invitation('revoked@example.com', 'revoked')],
  members: [member({ email: 'Member@Example.com' })],
}

describe('planBulkInvitation', () => {
  test('reads one address per line and normalizes them', () => {
    const plan = planBulkInvitation('  Sato@Example.com \n\nsuzuki@example.co.jp\r\n', context)

    expect(plan.truncated).toBe(false)
    expect(plan.rows).toEqual([
      { email: 'sato@example.com', line: 1, name: undefined, role: 'member' },
      { email: 'suzuki@example.co.jp', line: 3, name: undefined, role: 'member' },
    ])
  })

  test('splits a line that lists several addresses', () => {
    const plan = planBulkInvitation('a@example.com, b@example.com; \nc@example.com\td@example.com', context)

    expect(plan.rows.map((row) => row.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
      'd@example.com',
    ])
    expect(plan.rows.every((row) => row.issue === undefined)).toBe(true)
  })

  test('reads a CSV with a Japanese header in any column order, with quoted cells', () => {
    const csv = '\uFEFFロール,名前,メールアドレス\r\nguest,"佐藤, 花子",sato@example.com\r\nゲスト,"鈴木 ""Ken""",suzuki@example.com\r\n'
    const plan = planBulkInvitation(csv, context)

    expect(plan.rows).toEqual([
      { email: 'sato@example.com', line: 2, name: '佐藤, 花子', role: 'guest', roleInput: 'guest' },
      { email: 'suzuki@example.com', line: 3, name: '鈴木 "Ken"', role: 'guest', roleInput: 'ゲスト' },
    ])
  })

  test('reads positional columns without a header', () => {
    const plan = planBulkInvitation('tanaka@example.com,田中 一郎,guest', context)

    expect(plan.rows).toEqual([{ email: 'tanaka@example.com', line: 1, name: '田中 一郎', role: 'guest', roleInput: 'guest' }])
  })

  test('marks every kind of row that cannot be sent', () => {
    const csv = [
      'email,name,role',
      'not-an-address,,',
      'nodot@example,,',
      `long@example.com,${'x'.repeat(129)},`,
      'role@example.com,,leader',
      'admin@example.com,,admin',
      'ok@example.com,,',
      'OK@example.com,,',
      'member@example.com,,',
      'pending@example.com,,',
      'revoked@example.com,,',
    ].join('\n')
    const plan = planBulkInvitation(csv, context)

    expect(plan.rows.map((row) => [row.line, row.issue])).toEqual([
      [2, 'invalid-email'],
      [3, 'invalid-email'],
      [4, 'name-too-long'],
      [5, 'invalid-role'],
      [6, 'role-not-allowed'],
      [7, undefined],
      [8, 'duplicate'],
      [9, 'already-member'],
      [10, 'already-invited'],
      [11, 'reinvite-required'],
    ])
  })

  test('keeps line numbers right after a quoted cell with a line break', () => {
    const plan = planBulkInvitation('a@example.com,"two\nlines"\nb@example.com', context)

    expect(plan.rows.map((row) => [row.line, row.email, row.issue])).toEqual([
      [1, 'a@example.com', 'name-too-long'],
      [3, 'b@example.com', undefined],
    ])
  })

  test('puts rows back without moving cells or making an unknown role valid', () => {
    const plan = planBulkInvitation(
      'email,name,role\nperson@example.com,"Jane;owner",guest\nrole@example.com,"Ken ""K""",leader\nplain@example.com,,\n\'\'+quoted@example.com,\'-Kei,',
      context,
    )
    const retry = createBulkInvitationRetryCsv(plan.rows)
    const again = planBulkInvitation(retry, context)

    expect(again.rows.map((row) => [row.email, row.name, row.role, row.roleInput, row.issue])).toEqual([
      ['person@example.com', 'Jane;owner', 'guest', 'guest', undefined],
      ['role@example.com', 'Ken "K"', 'member', 'leader', 'invalid-role'],
      ['plain@example.com', undefined, 'member', undefined, undefined],
      ["'+quoted@example.com", '-Kei', 'member', undefined, undefined],
    ])
  })

  test('reads at most the bulk limit and says it left rows out', () => {
    const lines = Array.from({ length: WORKSPACE_BULK_INVITATION_MAX_ROWS + 5 }, (_, index) => `u${index}@example.com`)
    const plan = planBulkInvitation(lines.join('\n'), context)

    expect(plan.rows).toHaveLength(WORKSPACE_BULK_INVITATION_MAX_ROWS)
    expect(plan.truncated).toBe(true)
    expect(plan.overflowRows.map((row) => row.email)).toEqual(lines.slice(WORKSPACE_BULK_INVITATION_MAX_ROWS))
  })

  test('handles 100 rows in one check', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `user${index}@example.com,User ${index}`)
    const plan = planBulkInvitation(['email,name', ...lines].join('\n'), context)

    expect(plan.rows.filter((row) => !row.issue)).toHaveLength(100)
  })
})

describe('sendBulkWorkspaceInvitations', () => {
  test('sends every invitation even when some fail, a few at a time', async () => {
    let running = 0
    let peak = 0
    const reported: number[] = []
    const inputs = Array.from({ length: 10 }, (_, index) => ({ email: `u${index}@example.com`, role: 'member' as const }))

    const outcomes = await sendBulkWorkspaceInvitations(
      inputs,
      async (input) => {
        running += 1
        peak = Math.max(peak, running)
        await Promise.resolve()
        running -= 1
        if (input.email === 'u3@example.com') throw new Error('rejected')
      },
      (index) => reported.push(index),
    )

    expect(peak).toBeLessThanOrEqual(3)
    expect(reported.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'sent', 'sent', 'sent', 'failed', 'sent', 'sent', 'sent', 'sent', 'sent', 'sent',
    ])
  })
})

describe('filterWorkspaceMembers', () => {
  const members = [
    member({ email: 'sato@example.com', name: '佐藤 花子' }),
    member({ email: 'suzuki@example.com', name: 'Ken Suzuki', role: 'admin' }),
    member({ email: 'old@example.com', status: 'deactivated' }),
  ]

  test('matches names ignoring spaces, case and full-width letters', () => {
    expect(filterWorkspaceMembers(members, { ...emptyWorkspaceMemberFilter, query: '佐藤花子' })
      .map((entry) => entry.email)).toEqual(['sato@example.com'])
    expect(filterWorkspaceMembers(members, { ...emptyWorkspaceMemberFilter, query: 'ｓｕｚｕｋｉ' })
      .map((entry) => entry.email)).toEqual(['suzuki@example.com'])
    expect(filterWorkspaceMembers(members, { ...emptyWorkspaceMemberFilter, query: 'OLD@' })
      .map((entry) => entry.email)).toEqual(['old@example.com'])
  })

  test('filters by status and role', () => {
    expect(filterWorkspaceMembers(members, { ...emptyWorkspaceMemberFilter, status: 'deactivated' })
      .map((entry) => entry.email)).toEqual(['old@example.com'])
    expect(filterWorkspaceMembers(members, { ...emptyWorkspaceMemberFilter, role: 'admin' })
      .map((entry) => entry.email)).toEqual(['suzuki@example.com'])
    expect(filterWorkspaceMembers(members, emptyWorkspaceMemberFilter)).toHaveLength(3)
  })
})

describe('createWorkspaceMemberCsv', () => {
  test('quotes cells and keeps spreadsheet formulas from running', () => {
    const csv = createWorkspaceMemberCsv(
      [member({ email: 'sato@example.com', name: '=HYPERLINK("x")' })],
      {
        createdAt: 'joined at',
        deactivatedAt: 'deactivated at',
        email: 'email',
        name: 'name',
        role: 'role',
        status: 'status',
      },
    )

    expect(csv).toBe(
      '"email","name","role","status","joined at","deactivated at"\r\n' +
      '"sato@example.com","\'=HYPERLINK(""x"")","member","active","2026-11-01T00:00:00.000Z",""\r\n',
    )
  })

  test('reads escaped cells back with their original values', () => {
    const csv = createWorkspaceMemberCsv([
      member({ email: '+person@example.com', name: '-Jane' }),
      member({ email: "'+quoted@example.com", name: "'Kei" }),
    ], {
      createdAt: 'joined at',
      deactivatedAt: 'deactivated at',
      email: 'email',
      name: 'name',
      role: 'role',
      status: 'status',
    })

    const members = [member({ email: '+person@example.com' }), member({ email: "'+quoted@example.com" })]
    expect(planBulkInvitation(csv, { ...context, members }).rows).toEqual([
      { email: '+person@example.com', issue: 'already-member', line: 2, name: '-Jane', role: 'member', roleInput: 'member' },
      { email: "'+quoted@example.com", issue: 'already-member', line: 3, name: "'Kei", role: 'member', roleInput: 'member' },
    ])
  })

  test('can be read back by the bulk invitation', () => {
    const csv = createWorkspaceMemberCsv([member({ email: 'sato@example.com', name: '佐藤 花子', role: 'guest' })], {
      createdAt: '参加日時',
      deactivatedAt: '利用停止日時',
      email: 'メールアドレス',
      name: '表示名',
      role: 'ロール',
      status: '利用状態',
    })

    expect(planBulkInvitation(csv, { ...context, members: [] }).rows).toEqual([
      { email: 'sato@example.com', line: 2, name: '佐藤 花子', role: 'guest', roleInput: 'guest' },
    ])
  })
})
