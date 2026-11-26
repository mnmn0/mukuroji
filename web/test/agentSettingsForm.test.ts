import {
  AGENT_SETTINGS_ARTIFACT_REPOSITORIES_MAX,
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES,
  AGENT_SETTINGS_MAX_PROJECT_BRIEFS,
} from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import {
  agentSettingsConfigurationFixture,
  agentSettingsFixture,
} from '../src/features/agent-settings/fixtures'
import {
  createAgentSettingsDraft,
  createUpdateAgentSettingsRequest,
  isAgentSettingsDraftChanged,
  listAgentAcceptanceCriteriaFieldOptions,
  listAgentProjectBriefTargets,
  listAgentReadyStatusOptions,
  measureUtf8Bytes,
  toggleAgentReadyStatus,
  listAgentResumableStatusOptions,
  validateAgentSettingsDraft,
} from '../src/features/agent-settings/model/agentSettingsForm'

const draft = createAgentSettingsDraft(agentSettingsFixture)

describe('Agent settings draft', () => {
  test('round-trips loaded settings into an unchanged request', () => {
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, draft)).toBeFalse()
    expect(createUpdateAgentSettingsRequest(draft, agentSettingsFixture.revision)).toEqual({
      expectedRevision: 4,
      leaseMinutes: 45,
      allowTakeoverAfterLeaseExpiry: true,
      artifactRepositories: [],
      readyStatusIds: ['ready'],
      resumableStatusIds: ['active'],
      requireAcceptanceCriteria: true,
      acceptanceCriteriaFieldId: 'definition-of-done',
      brief: agentSettingsFixture.brief,
      projectBriefs: agentSettingsFixture.projectBriefs,
      fileFailedRunsToTriage: true,
      fileStalledRunsToTriage: false,
      acceptNewRuns: true,
    })
  })

  test('omits cleared values so the full replacement removes them', () => {
    const cleared = {
      ...draft,
      acceptanceCriteriaFieldId: '',
      brief: '  \n',
      projectBriefs: { 'project-api': '', 'project-console': 'Use the design system.' },
    }
    expect(createUpdateAgentSettingsRequest(cleared, 4)).toEqual({
      expectedRevision: 4,
      leaseMinutes: 45,
      allowTakeoverAfterLeaseExpiry: true,
      artifactRepositories: [],
      readyStatusIds: ['ready'],
      resumableStatusIds: ['active'],
      requireAcceptanceCriteria: true,
      projectBriefs: { 'project-console': 'Use the design system.' },
      fileFailedRunsToTriage: true,
      fileStalledRunsToTriage: false,
      acceptNewRuns: true,
    })
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, cleared)).toBeTrue()
    // Turning new runs off is a change the save sends.
    const stopped = { ...draft, acceptNewRuns: false }
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, stopped)).toBeTrue()
    expect(createUpdateAgentSettingsRequest(stopped, 4)).toMatchObject({ acceptNewRuns: false })
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, { ...draft, fileStalledRunsToTriage: true })).toBeTrue()
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, { ...draft, resumableStatusIds: [] })).toBeTrue()
  })

  test('lists started statuses as resumable and keeps a saved status that is no longer started', () => {
    expect(listAgentResumableStatusOptions(agentSettingsConfigurationFixture, ['ready'])).toEqual([
      { id: 'active', name: 'In progress', workflowName: 'Delivery', missing: false },
      { id: 'mitigating', name: 'Mitigating', workflowName: 'Incidents', missing: false },
      { id: 'ready', name: 'ready', missing: true },
    ])
    expect(validateAgentSettingsDraft({ ...draft, resumableStatusIds: Array.from({ length: 51 }, (_, index) => `s${index}`) }))
      .toMatchObject({ tooManyResumableStatuses: true, valid: false })
  })

  test('treats a reordered selection and a blank brief edit as unchanged', () => {
    const settings = { ...agentSettingsFixture, readyStatusIds: ['ready', 'triage'] }
    const reordered = { ...createAgentSettingsDraft(settings), readyStatusIds: ['triage', 'ready'] }
    expect(isAgentSettingsDraftChanged(settings, reordered)).toBeFalse()
    const blankProject = { ...createAgentSettingsDraft(settings), projectBriefs: { ...settings.projectBriefs, 'project-console': ' ' } }
    expect(isAgentSettingsDraftChanged(settings, blankProject)).toBeFalse()
  })

  test('validates the lease range', () => {
    for (const leaseMinutes of ['5', '240', ' 30 ']) {
      expect(validateAgentSettingsDraft({ ...draft, leaseMinutes }).leaseMinutesValid).toBeTrue()
    }
    for (const leaseMinutes of ['', '4', '241', '30.5', '-5', '1e2']) {
      expect(validateAgentSettingsDraft({ ...draft, leaseMinutes }).leaseMinutesValid).toBeFalse()
      expect(createUpdateAgentSettingsRequest({ ...draft, leaseMinutes }, 4)).toBeUndefined()
    }
  })

  test('measures briefs in UTF-8 bytes and blocks oversized briefs', () => {
    expect(measureUtf8Bytes('ab')).toBe(2)
    expect(measureUtf8Bytes('日本')).toBe(6)
    const japaneseBrief = '日'.repeat(Math.floor(AGENT_SETTINGS_BRIEF_MAX_BYTES / 3) + 1)
    const tooLarge = validateAgentSettingsDraft({ ...draft, brief: japaneseBrief })
    expect(tooLarge.briefOverLimit).toBeTrue()
    expect(tooLarge.valid).toBeFalse()
    const projectTooLarge = validateAgentSettingsDraft({
      ...draft,
      projectBriefs: { 'project-api': 'x'.repeat(AGENT_SETTINGS_BRIEF_MAX_BYTES + 1) },
    })
    expect(projectTooLarge.overLimitProjectIds).toEqual(['project-api'])
    expect(projectTooLarge.valid).toBeFalse()
  })

  test('blocks too many Project briefs and an oversized total', () => {
    const projectBriefs = Object.fromEntries(
      Array.from({ length: AGENT_SETTINGS_MAX_PROJECT_BRIEFS + 1 }, (_, index) => [`project-${index}`, 'brief']),
    )
    const tooMany = validateAgentSettingsDraft({ ...draft, projectBriefs })
    expect(tooMany.tooManyProjectBriefs).toBeTrue()
    expect(tooMany.projectBriefCount).toBe(AGENT_SETTINGS_MAX_PROJECT_BRIEFS + 1)

    const count = Math.ceil(AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES / AGENT_SETTINGS_BRIEF_MAX_BYTES)
    const largeBriefs = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`project-${index}`, 'x'.repeat(AGENT_SETTINGS_BRIEF_MAX_BYTES)]),
    )
    const total = validateAgentSettingsDraft({ ...draft, brief: 'more', projectBriefs: largeBriefs })
    expect(total.totalOverLimit).toBeTrue()
    expect(total.valid).toBeFalse()
  })

  test('toggles ready statuses without reordering the others', () => {
    expect(toggleAgentReadyStatus(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c'])
    expect(toggleAgentReadyStatus(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c'])
    expect(toggleAgentReadyStatus(['a'], 'a', true)).toEqual(['a'])
  })
})

describe('Agent settings options', () => {
  test('lists backlog and unstarted statuses of every workflow and keeps unknown saved IDs', () => {
    expect(listAgentReadyStatusOptions(agentSettingsConfigurationFixture, ['ready', 'active', 'gone'])).toEqual([
      { id: 'backlog', name: 'Backlog', workflowName: 'Delivery', missing: false },
      { id: 'ready', name: 'Ready', workflowName: 'Delivery', missing: false },
      { id: 'triage', name: 'Triage', workflowName: 'Incidents', missing: false },
      { id: 'active', name: 'active', missing: true },
      { id: 'gone', name: 'gone', missing: true },
    ])
    expect(listAgentReadyStatusOptions(undefined, ['ready'])).toEqual([{ id: 'ready', name: 'ready', missing: true }])
  })

  test('lists text and list custom fields and keeps an unknown saved field', () => {
    expect(listAgentAcceptanceCriteriaFieldOptions(agentSettingsConfigurationFixture, '')).toEqual([
      { id: 'definition-of-done', name: 'Definition of done', missing: false },
      { id: 'checks', name: 'Required checks', missing: false },
    ])
    expect(listAgentAcceptanceCriteriaFieldOptions(agentSettingsConfigurationFixture, 'story-points').at(-1))
      .toEqual({ id: 'story-points', name: 'story-points', missing: true })
  })

  test('lists Team Projects followed by Projects that only have a saved brief', () => {
    expect(listAgentProjectBriefTargets(
      [{ id: 'project-api', name: 'Public API' }, { id: 'project-api', name: 'Duplicate' }],
      { 'project-api': 'a', 'project-legacy': 'b' },
    )).toEqual([
      { projectId: 'project-api', name: 'Public API' },
      { projectId: 'project-legacy' },
    ])
  })

  test('reads the repository list one path per line, and rejects other text or too many', () => {
    const listed = { ...draft, artifactRepositories: ' Org/Repo \n\norg/repo, group/sub/app\n' }
    expect(validateAgentSettingsDraft(listed)).toMatchObject({ valid: true, invalidArtifactRepositories: [] })
    expect(createUpdateAgentSettingsRequest(listed, 4)?.artifactRepositories).toEqual(['org/repo', 'group/sub/app'])
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, listed)).toBeTrue()
    expect(isAgentSettingsDraftChanged(agentSettingsFixture, { ...draft, artifactRepositories: ' \n' })).toBeFalse()

    expect(validateAgentSettingsDraft({ ...draft, artifactRepositories: 'https://github.com/org/repo\nrepo' }))
      .toMatchObject({ valid: false, invalidArtifactRepositories: ['https://github.com/org/repo', 'repo'] })
    const many = Array.from({ length: AGENT_SETTINGS_ARTIFACT_REPOSITORIES_MAX + 1 }, (_, index) => `org/repo-${index}`).join('\n')
    expect(validateAgentSettingsDraft({ ...draft, artifactRepositories: many }))
      .toMatchObject({ valid: false, tooManyArtifactRepositories: true })
  })
})
