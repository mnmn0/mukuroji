import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import type { ProjectMember } from '../src/projects/api/members'
import {
  canAddSearchFilterId,
  createSearchMemberFilterOptions,
  createSearchProjectFilterOptions,
  createSearchTeamFilterOptions,
  filterSearchFilterOptions,
  includeSelectedSearchFilterOptions,
} from '../src/search/model/filterOptions'
import { SearchFilterPicker } from '../src/search/ui/SearchFilterPicker'
import { createTranslator } from '../src/shared/i18n/i18n'

const teams: ProjectDirectoryTeam[] = [
  {
    id: 'team-platform',
    name: 'Platform',
    projects: [
      { id: 'project-api', name: 'API' },
      { id: 'project-shared', name: 'Shared' },
    ],
  },
  {
    id: 'team-design',
    name: 'Design',
    projects: [{ id: 'project-shared', name: 'Shared' }],
  },
]

/**
 * Builds a Project member record for option tests.
 *
 * @param member - Fields that differ between test members.
 * @returns A complete Project member.
 */
function projectMember(member: Pick<ProjectMember, 'id' | 'email'> & Partial<ProjectMember>): ProjectMember {
  return {
    role: 'member',
    updatedAt: '2026-11-20T00:00:00.000Z',
    workspaceStatus: 'active',
    ...member,
  }
}

describe('Search filter options', () => {
  test('lists Teams by name', () => {
    expect(createSearchTeamFilterOptions(teams)).toEqual([
      { label: 'Design', value: 'team-design' },
      { label: 'Platform', value: 'team-platform' },
    ])
  })

  test('merges a Project listed under several Teams into one option', () => {
    expect(createSearchProjectFilterOptions(teams)).toEqual([
      { description: 'Platform', label: 'API', value: 'project-api' },
      { description: 'Platform, Design', label: 'Shared', value: 'project-shared' },
    ])
  })

  test('deduplicates members across Projects and labels them by name', () => {
    const ada = projectMember({ email: 'ada@example.com', id: 'user-ada', name: 'Ada' })
    const options = createSearchMemberFilterOptions([
      { member: ada, projectId: 'project-api', projectName: 'API' },
      { member: ada, projectId: 'project-shared', projectName: 'Shared' },
      {
        member: projectMember({ email: 'bob@example.com', id: 'user-bob', workspaceStatus: 'deactivated' }),
        projectId: 'project-api',
        projectName: 'API',
      },
    ])

    expect(options).toEqual([
      { description: 'ada@example.com', label: 'Ada', value: 'user-ada' },
      { label: 'bob@example.com', value: 'user-bob' },
    ])
  })

  test('keeps selected IDs that are not listed', () => {
    const options = createSearchTeamFilterOptions(teams)
    expect(includeSelectedSearchFilterOptions(options, ['team-design', 'team-gone', 'team-gone']))
      .toEqual([...options, { label: 'team-gone', value: 'team-gone' }])
  })

  test('narrows options by name, description, or ID ignoring case and width', () => {
    const options = createSearchProjectFilterOptions(teams)
    expect(filterSearchFilterOptions(options, 'ＤＥＳＩＧＮ').map((option) => option.value)).toEqual(['project-shared'])
    expect(filterSearchFilterOptions(options, 'project-api').map((option) => option.value)).toEqual(['project-api'])
    expect(filterSearchFilterOptions(options, '  ')).toEqual(options)
  })
})

describe('SearchFilterPicker', () => {
  test('renders names with checked selections and an unknown selected ID', () => {
    const html = renderToStaticMarkup(
      <SearchFilterPicker
        label="Team"
        onChange={() => undefined}
        options={createSearchTeamFilterOptions(teams)}
        selectedValues={['team-platform', 'team-gone']}
        statusMessage="Loading members"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Platform')
    expect(html).toContain('Design')
    expect(html).toContain('team-gone')
    expect(html).toContain('2 selected')
    expect(html).toContain('Loading members')
    expect(html).toContain('Clear selection')
    expect(html.match(/checked=""/g)).toHaveLength(2)
    expect(html).not.toContain('Retry loading members')
  })

  test('shows a retry action only when one is provided', () => {
    const html = renderToStaticMarkup(
      <SearchFilterPicker
        label="Assignee"
        onChange={() => undefined}
        onRetry={() => undefined}
        options={[]}
        selectedValues={[]}
        statusMessage="Some members could not be loaded"
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Retry loading members')
  })
})

describe('canAddSearchFilterId', () => {
  test('offers an unlisted ID even when it partly matches a listed option', () => {
    const options = createSearchProjectFilterOptions(teams)
    expect(canAddSearchFilterId(options, 'api')).toBe(true)
    expect(canAddSearchFilterId(options, ' project-api ')).toBe(false)
    expect(canAddSearchFilterId(options, '  ')).toBe(false)
  })
})
