import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import type { AiAssistanceController } from '../src/features/ai-assistance/mutations/useAiAssistanceController'
import { aiTriageGenerationFixture } from '../src/features/ai-assistance/fixtures'
import { requestSubmissionFixture } from '../src/requests/fixtures'
import { normalizeRequestSubmission } from '../src/requests/model/requestForm'
import { RequestQueue } from '../src/requests/ui/RequestQueue'
import {
  canAdoptRequestTriageDraft,
  createSafeTriageRoutingOverride,
} from '../src/requests/model/requestTriageRouting'
import {
  isRequestAiOperationPendingForSubmission,
  updateRequestAiOperationFence,
} from '../src/requests/model/requestAiOperationFence'

const aiController: AiAssistanceController = {
  cancelGeneration: () => undefined,
  decide: async () => undefined,
  generate: async () => aiTriageGenerationFixture,
  generation: aiTriageGenerationFixture,
  isDecisionPending: false,
  isFeedbackPending: false,
  isGenerating: false,
  reset: () => undefined,
  revalidateGeneration: async () => undefined,
  sendFeedback: async () => undefined,
}

describe('RequestQueue', () => {
  /** Verifies a delayed completion from submission-a cannot clear submission-b's operation fence. */
  test('ignores a delayed completion from the previous submission', () => {
    const pendingFence = updateRequestAiOperationFence(
      { pending: false },
      'submission-a',
      'submission-a',
      true,
    )
    expect(pendingFence).toEqual({ ownerSubmissionId: 'submission-a', pending: true })
    expect(updateRequestAiOperationFence(
      pendingFence ?? { pending: false },
      'submission-b',
      'submission-a',
      false,
    )).toBeUndefined()
    expect(isRequestAiOperationPendingForSubmission(
      pendingFence ?? { pending: false },
      'submission-b',
    )).toBe(false)
  })

  test('renders historical select labels and exposes a focusable detail control', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>Bug</dd>')
    expect(html).not.toContain('>bug</dd>')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('aria-label="Open request details: プロダクトサポート依頼 v1"')
    expect(submission.formId).toBe(requestSubmissionFixture.formId)
  })

  test('renders every known multi-select option label and preserves unknown legacy values', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      answers: {
        ...requestSubmissionFixture.answers,
        'request-kind': ['bug', 'legacy-option'],
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>不具合, legacy-option</dd>')
  })

  test('does not expose duplicate-candidate actions without the capability', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      capabilities: {
        ...requestSubmissionFixture.capabilities,
        canMarkDuplicate: false,
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).not.toContain('submission-previous')
  })

  test('renders an authorized evidence-first triage draft beside the selected conversion flow', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="ai-triage-composer"')
    expect(html).toContain('Unblock customer Workspace provisioning')
    expect(html).toContain('Provisioning intake source')
    expect(html).not.toContain('Use in conversion form')
  })

  /** Verifies adoption is not offered when a triage draft has no conversion fields. */
  test('does not offer adoption when a triage draft has no conversion fields', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const emptyTriageGeneration = {
      ...aiTriageGenerationFixture,
      content: {
        ...content,
        draft: {
          kind: 'triage',
          customFields: [],
        },
      },
    } satisfies AiAssistanceGeneration
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={{ ...aiController, generation: emptyTriageGeneration }}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="ai-triage-composer"')
    expect(html).toContain('No applicable field suggestions were returned.')
    expect(html).not.toContain('Use in conversion form')
  })

  /** Requires the current active-member directory before copying an AI assignee. */
  test('keeps an assignee proposal review-only when the member is not active', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }

    expect(canAdoptRequestTriageDraft(
      submission,
      content.draft,
      {},
      new Map([['core-team', new Set(['launch-readiness'])]]),
      new Set(['inactive-member']),
    )).toBe(false)
    expect(createSafeTriageRoutingOverride(
      submission,
      content.draft,
      {},
      new Map([['core-team', new Set(['launch-readiness'])]]),
      new Set(['member-ada']),
    )).toMatchObject({ assigneeUserId: 'member-ada' })
  })

  test('does not render AI draft markup when conversion capability is absent', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      capabilities: {
        ...requestSubmissionFixture.capabilities,
        canConvert: false,
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        aiAssistanceController={aiController}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Unblock customer Workspace provisioning')
    expect(html).not.toContain('Provisioning intake source')
  })

  test('does not expose administrator-only intake AI to a converting non-manager', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        accessToken="access-token"
        canUseAiAssistance={false}
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('Convert to Work Item')
    expect(html).not.toContain('data-testid="ai-triage-composer"')
    expect(html).not.toContain('Generate draft')
  })

  /** Keeps inherited Project and workflow status out of an unsafe Team change. */
  test('does not carry the old Team project or status into a changed Team adoption', () => {
    const submission = {
      ...normalizeRequestSubmission(requestSubmissionFixture),
      routing: {
        ...normalizeRequestSubmission(requestSubmissionFixture).routing,
        projectId: 'original-team-project',
        workflowStatusId: 'original-team-status',
      },
    }
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const changedTeamDraft = {
      ...content.draft,
      projectId: undefined,
      teamId: {
        ...content.draft.teamId,
        value: 'new-team',
      },
    }

    const override = createSafeTriageRoutingOverride(submission, changedTeamDraft)

    expect(override.teamId).toBeUndefined()
    expect(override.projectId).toBeUndefined()
    expect(override.workflowStatusId).toBeUndefined()
    expect(override.priority).toBe('high')

    const teamOnlyDraft = {
      ...changedTeamDraft,
      assigneeUserId: undefined,
      description: undefined,
      priority: undefined,
      projectId: undefined,
      title: undefined,
    }
    expect(canAdoptRequestTriageDraft(submission, teamOnlyDraft)).toBe(false)
  })

  /** Applies a changed Team only when no old Team-dependent values are inherited. */
  test('applies a changed Team only when no old Team-dependent values are inherited', () => {
    const baseSubmission = normalizeRequestSubmission(requestSubmissionFixture)
    const submission = {
      ...baseSubmission,
      routing: {
        ...baseSubmission.routing,
        projectId: undefined,
        workflowStatusId: undefined,
      },
    }
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const changedTeamDraft = {
      ...content.draft,
      projectId: undefined,
      teamId: {
        ...content.draft.teamId,
        value: 'new-team',
      },
    }

    expect(createSafeTriageRoutingOverride(submission, changedTeamDraft)).toMatchObject({
      priority: 'high',
      teamId: 'new-team',
    })
    expect(canAdoptRequestTriageDraft(
      submission,
      changedTeamDraft,
      {},
      undefined,
    )).toBe(false)
    expect(canAdoptRequestTriageDraft(
      submission,
      changedTeamDraft,
      {},
      undefined,
      new Set(['member-ada']),
    )).toBe(true)
  })

  /** Blocks a new Team proposal when a prior local override would remain applied. */
  test('does not adopt a Team proposal that conflicts with an existing local routing override', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const changedTeamDraft = {
      ...content.draft,
      projectId: undefined,
      teamId: {
        ...content.draft.teamId,
        value: 'team-c',
      },
      assigneeUserId: undefined,
      description: undefined,
      priority: undefined,
      title: undefined,
    }
    const currentOverride = {
      projectId: 'team-b-project',
      teamId: 'team-b',
    }

    expect(createSafeTriageRoutingOverride(
      submission,
      changedTeamDraft,
      currentOverride,
    )).toMatchObject(currentOverride)
    expect(canAdoptRequestTriageDraft(
      submission,
      changedTeamDraft,
      currentOverride,
    )).toBe(false)
  })

  /** Keeps a Project-only proposal review-only when it is outside the effective Team. */
  test('does not adopt a Project-only proposal outside the effective Team', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const projectOnlyDraft = {
      ...content.draft,
      assigneeUserId: undefined,
      description: undefined,
      priority: undefined,
      teamId: undefined,
      title: undefined,
      projectId: {
        ...content.draft.projectId,
        value: 'design-project',
      },
    }
    const projectDirectory = new Map([
      ['core-team', new Set(['core-project'])],
      ['design-team', new Set(['design-project'])],
    ])

    expect(createSafeTriageRoutingOverride(
      submission,
      projectOnlyDraft,
      {},
      projectDirectory,
    )).toEqual({})
    expect(canAdoptRequestTriageDraft(
      submission,
      projectOnlyDraft,
      {},
      projectDirectory,
    )).toBe(false)
  })

  /** Keeps a same-Team draft with an invalid Project review-only. */
  test('does not adopt a same-Team proposal containing an invalid Project', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const content = aiTriageGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'triage') {
      throw new Error('Triage fixture must stay available.')
    }
    const sameTeamProjectDraft = {
      ...content.draft,
      assigneeUserId: undefined,
      description: undefined,
      priority: undefined,
      teamId: {
        ...content.draft.teamId,
        value: submission.routing.teamId,
      },
      title: undefined,
      projectId: {
        ...content.draft.projectId,
        value: 'project-from-another-team',
      },
    }
    const projectDirectory = new Map([
      [submission.routing.teamId, new Set(['project-in-current-team'])],
      ['other-team', new Set(['project-from-another-team'])],
    ])

    expect(canAdoptRequestTriageDraft(
      submission,
      sameTeamProjectDraft,
      {},
      projectDirectory,
    )).toBe(false)
  })
})
