import { afterEach, describe, expect, test } from 'bun:test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { updateDirectoryTeamProfile } from '../src/projects/api/directoryAdministration'
import {
  listTeamProfileProjects,
  summarizeTeamProfileMembers,
} from '../src/projects/model/teamProfile'
import { TeamProfilePanel } from '../src/projects/ui/TeamProfilePanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const team: DirectoryAdministrationTeam = {
  id: 'core',
  nameJa: 'コア',
  nameEn: 'Core',
  description: '基盤を担当するチーム',
  leaderMemberKey: 'sato',
  projects: [
    { id: 'alpha', nameJa: 'アルファ', nameEn: 'Alpha', tone: 'blue' },
    { id: 'old', nameJa: '旧', nameEn: 'Old', tone: 'blue', archivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'beta', nameJa: 'ベータ', nameEn: 'Beta', tone: 'green' },
  ],
}

/**
 * Builds one Project member row.
 *
 * @param projectId - Project the member belongs to.
 * @param projectName - Project display name.
 * @param id - Member key.
 * @param role - Project role.
 * @param name - Optional display name.
 * @returns The member row.
 */
function entry(
  projectId: string,
  projectName: string,
  id: string,
  role: 'manager' | 'member' | 'viewer',
  name?: string,
) {
  return {
    projectId,
    projectName,
    member: { id, email: `${id}@example.com`, role, ...(name ? { name } : {}) },
  }
}

describe('Team profile model', () => {
  test('lists only active Projects, named in the locale', () => {
    expect(listTeamProfileProjects(team, 'en')).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ])
  })

  test('gathers one row per member with their Projects in Team order', () => {
    const projects = listTeamProfileProjects(team, 'ja')
    const members = summarizeTeamProfileMembers([
      entry('beta', 'ベータ', 'sato', 'viewer', '佐藤'),
      entry('alpha', 'アルファ', 'tanaka', 'member'),
      entry('alpha', 'アルファ', 'sato', 'manager', '佐藤'),
    ], projects)

    expect(members).toEqual([
      {
        id: 'tanaka',
        label: 'tanaka@example.com',
        email: 'tanaka@example.com',
        projects: [{ projectId: 'alpha', projectName: 'アルファ', role: 'member' }],
      },
      {
        id: 'sato',
        label: '佐藤',
        email: 'sato@example.com',
        projects: [
          { projectId: 'alpha', projectName: 'アルファ', role: 'manager' },
          { projectId: 'beta', projectName: 'ベータ', role: 'viewer' },
        ],
      },
    ].sort((left, right) => left.label.localeCompare(right.label)))
  })
})

describe('TeamProfilePanel', () => {
  test('shows the stored profile, the members, and the add form', () => {
    const t = createTranslator('ja')
    const markup = renderToStaticMarkup(
      <TeamProfilePanel
        locale="ja"
        members={summarizeTeamProfileMembers(
          [entry('alpha', 'アルファ', 'sato', 'manager', '佐藤')],
          listTeamProfileProjects(team, 'ja'),
        )}
        membersLoading={false}
        membersPartial
        pending={false}
        projectCount={2}
        t={t}
        team={team}
        teams={[team]}
        workspaceMembers={[{ memberKey: 'sato', label: '佐藤' }, { memberKey: 'tanaka', label: '田中' }]}
        workspaceMembersStatus="ready"
        onAddMember={async () => undefined}
        onRetryMembers={() => undefined}
        onRetryWorkspaceMembers={() => undefined}
        onSaveProfile={async () => true}
        onSelectTeam={() => undefined}
      />,
    )

    expect(markup).toContain('基盤を担当するチーム')
    expect(markup).toContain('<option value="sato" selected="">佐藤</option>')
    expect(markup).toContain('アルファ（manager）')
    expect(markup).toContain(t('projects.teamProfile.membersPartial'))
    expect(markup).toContain('data-testid="team-profile-members-partial"')
    expect(markup).toContain(t('projects.teamProfile.addMember'))
  })

  test('keeps a leader who left the Workspace visible and hides the add form without Projects', () => {
    const t = createTranslator('en')
    const markup = renderToStaticMarkup(
      <TeamProfilePanel
        locale="en"
        members={[]}
        membersLoading={false}
        membersPartial={false}
        pending={false}
        projectCount={0}
        t={t}
        team={{ ...team, leaderMemberKey: 'left' }}
        teams={[team]}
        workspaceMembers={[]}
        workspaceMembersStatus="ready"
        onAddMember={async () => undefined}
        onRetryMembers={() => undefined}
        onRetryWorkspaceMembers={() => undefined}
        onSaveProfile={async () => true}
        onSelectTeam={() => undefined}
      />,
    )

    expect(markup).toContain('<option value="left" selected="">left</option>')
    expect(markup).toContain('>Core</option>')
    expect(markup).toContain(t('projects.teamProfile.noProjects'))
    expect(markup).not.toContain('data-testid="team-profile-add-member"')
  })

  test('says the Workspace members failed to load and offers a retry instead of an empty list', () => {
    const t = createTranslator('ja')
    const markup = renderToStaticMarkup(
      <TeamProfilePanel
        locale="ja"
        members={[]}
        membersLoading={false}
        membersPartial={false}
        pending={false}
        projectCount={2}
        t={t}
        team={team}
        teams={[team]}
        workspaceMembers={[]}
        workspaceMembersStatus="error"
        onAddMember={async () => undefined}
        onRetryMembers={() => undefined}
        onRetryWorkspaceMembers={() => undefined}
        onSaveProfile={async () => true}
        onSelectTeam={() => undefined}
      />,
    )

    expect(markup).toContain('data-testid="team-profile-workspace-members-error"')
    expect(markup).toContain(t('projects.teamProfile.workspaceMembersError'))
    expect(markup).toContain(t('projects.administration.retry'))
    // Leader and member choices stay disabled until the list loads.
    expect(markup.match(/<select[^>]*disabled=""/g)).toHaveLength(2)
  })
})

describe('Team profile API', () => {
  const originalFetch = globalThis.fetch
  const mutationContext = { correlationId: 'correlation-1', idempotencyKey: 'idempotency-1' }
  const input = { description: '説明 ', leaderMemberKey: null, expectedProfileRevision: 2 }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Replaces fetch with a fake that answers with one JSON body.
   *
   * @param body - Response body.
   */
  function answerWith(body: unknown) {
    const fakeFetch: typeof fetch = async () => Response.json(body)
    globalThis.fetch = fakeFetch
  }

  test('returns the stored profile and the revision the server reports', async () => {
    answerWith({ teamId: 'core', description: '説明', profileRevision: 2 })
    await expect(updateDirectoryTeamProfile('token', 'core', input, mutationContext))
      .resolves.toEqual({ teamId: 'core', description: '説明', profileRevision: 2 })
  })

  test('refuses a response without a stored revision', async () => {
    answerWith({ teamId: 'core', description: '説明' })
    await expect(updateDirectoryTeamProfile('token', 'core', input, mutationContext))
      .rejects.toMatchObject({ status: 502 })
  })
})
