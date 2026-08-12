import { afterEach, describe, expect, test } from 'bun:test'
import type { FocusItem, FocusQueueResponse } from '@mukuroji/contracts'
import { focusQueueResponseFixture } from '../src/features/focus-queue/fixtures'
import {
  FocusQueueApiError,
  getFocusQueue,
  updateFocusSnooze,
} from '../src/features/focus-queue/api/focusQueue'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Focus queue API', () => {
  test('loads a validated response without changing server rank order', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify(focusQueueResponseFixture),
      { headers: { 'Content-Type': 'application/json' }, status: 200 },
    )

    const response = await getFocusQueue('focus-token')

    expect(response.sections[0]?.items.map((item) => item.workItem.id)).toEqual([
      'WI-194',
      'WI-202',
    ])
  })

  test('fails closed when a source deep link leaves the application origin', async () => {
    const firstSection = focusQueueResponseFixture.sections[0]
    const firstItem = firstSection?.items[0]
    const firstSignal = firstItem?.signals[0]
    if (!firstSection || !firstItem || !firstSignal) {
      throw new Error('The Focus fixture requires one signal.')
    }
    const invalidResponse = {
      ...focusQueueResponseFixture,
      sections: [{
        ...firstSection,
        items: [{
          ...firstItem,
          signals: [{
            ...firstSignal,
            source: { ...firstSignal.source, deepLink: 'https://example.com/leak' },
          }],
        }],
      }, ...focusQueueResponseFixture.sections.slice(1)],
    }
    globalThis.fetch = async () => new Response(JSON.stringify(invalidResponse), { status: 200 })

    await expect(getFocusQueue('focus-token')).rejects.toBeInstanceOf(FocusQueueApiError)
  })

  test('rejects incomplete policy projections and invalid snooze revisions', async () => {
    const effectivePolicy = focusQueueResponseFixture.effectivePolicies[0]
    const userPolicy = focusQueueResponseFixture.userPolicy
    if (!effectivePolicy || !userPolicy) {
      throw new Error('The Focus fixture requires effective and user policies.')
    }

    const invalidSnoozeRevision = structuredClone(focusQueueResponseFixture)
    const [snoozeItem] = requireFirstTwoFocusItems(invalidSnoozeRevision)
    snoozeItem.snoozeRevision = 1.5

    const invalidResponses = [
      {
        ...focusQueueResponseFixture,
        effectivePolicies: [{
          ...effectivePolicy,
          baseSettings: undefined,
        }],
      },
      {
        ...focusQueueResponseFixture,
        effectivePolicies: [{
          ...effectivePolicy,
          teamSettings: undefined,
        }],
      },
      {
        ...focusQueueResponseFixture,
        teamPolicies: undefined,
      },
      {
        ...focusQueueResponseFixture,
        policyCapabilities: {
          canEditPersonal: 'yes',
          editableTeamIds: ['core-team'],
        },
      },
      {
        ...focusQueueResponseFixture,
        policyCapabilities: {
          canEditPersonal: true,
          editableTeamIds: ['core-team', 42],
        },
      },
      {
        ...focusQueueResponseFixture,
        teamPolicies: [userPolicy],
      },
      invalidSnoozeRevision,
    ]

    for (const response of invalidResponses) {
      await expectInvalidFocusQueueResponse(response)
    }
  })

  test('rejects negative version evidence and a nonpositive Focus item version', async () => {
    const policyVersion = structuredClone(focusQueueResponseFixture)
    if (!policyVersion.userPolicy) throw new Error('The Focus fixture requires a user policy.')
    policyVersion.userPolicy.version = -1

    const provenanceVersion = structuredClone(focusQueueResponseFixture)
    const provenance = provenanceVersion.effectivePolicies[0]?.provenance[0]
    if (!provenance) throw new Error('The Focus fixture requires policy provenance.')
    provenance.version = -1

    const sourceVersion = structuredClone(focusQueueResponseFixture)
    const [sourceVersionItem] = requireFirstTwoFocusItems(sourceVersion)
    const sourceVersionSignal = sourceVersionItem.signals[0]
    if (!sourceVersionSignal) throw new Error('The Focus fixture requires one signal.')
    sourceVersionSignal.freshness.sourceVersion = -1

    const itemVersion = structuredClone(focusQueueResponseFixture)
    const [versionedItem] = requireFirstTwoFocusItems(itemVersion)
    versionedItem.version = 0

    const snoozeRevision = structuredClone(focusQueueResponseFixture)
    const [snoozedItem] = requireFirstTwoFocusItems(snoozeRevision)
    snoozedItem.snoozeRevision = -1

    for (const response of [
      policyVersion,
      provenanceVersion,
      sourceVersion,
      itemVersion,
      snoozeRevision,
    ]) {
      await expectInvalidFocusQueueResponse(response)
    }
  })

  test('rejects noncanonical Focus timestamps and inconsistent resolution state', async () => {
    const generatedAt = structuredClone(focusQueueResponseFixture)
    generatedAt.generatedAt = '2026-08-09T04:30:00Z'

    const sourceOccurredAt = structuredClone(focusQueueResponseFixture)
    const [sourceItem] = requireFirstTwoFocusItems(sourceOccurredAt)
    const sourceSignal = sourceItem.signals[0]
    if (!sourceSignal) throw new Error('The Focus fixture requires one signal.')
    sourceSignal.source.occurredAt = '2026-08-09T03:30:00Z'

    const evaluatedAt = structuredClone(focusQueueResponseFixture)
    const [evaluatedItem] = requireFirstTwoFocusItems(evaluatedAt)
    const evaluatedSignal = evaluatedItem.signals[0]
    if (!evaluatedSignal) throw new Error('The Focus fixture requires one signal.')
    evaluatedSignal.freshness.evaluatedAt = '2026-08-09T04:20:00Z'

    const validUntil = structuredClone(focusQueueResponseFixture)
    const [validUntilItem] = requireFirstTwoFocusItems(validUntil)
    const validUntilSignal = validUntilItem.signals[0]
    if (!validUntilSignal) throw new Error('The Focus fixture requires one signal.')
    validUntilSignal.freshness.validUntil = '2026-08-09T04:45:00Z'

    const openWithResolvedAt = structuredClone(focusQueueResponseFixture)
    const [openItem] = requireFirstTwoFocusItems(openWithResolvedAt)
    const openSignal = openItem.signals[0]
    if (!openSignal) throw new Error('The Focus fixture requires one signal.')
    openSignal.resolution.resolvedAt = '2026-08-09T04:25:00.000Z'

    const resolvedWithoutResolvedAt = structuredClone(focusQueueResponseFixture)
    const doneSignal = resolvedWithoutResolvedAt.sections
      .find((section) => section.section === 'done')?.items[0]?.signals[0]
    if (!doneSignal) throw new Error('The Focus fixture requires one resolved signal.')
    delete doneSignal.resolution.resolvedAt

    const noncanonicalResolvedAt = structuredClone(focusQueueResponseFixture)
    const noncanonicalDoneSignal = noncanonicalResolvedAt.sections
      .find((section) => section.section === 'done')?.items[0]?.signals[0]
    if (!noncanonicalDoneSignal) {
      throw new Error('The Focus fixture requires one resolved signal.')
    }
    noncanonicalDoneSignal.resolution.resolvedAt = '2026-08-09T04:25:00Z'

    const snoozedUntil = structuredClone(focusQueueResponseFixture)
    const snoozedFocusItem = snoozedUntil.sections
      .find((section) => section.section === 'snoozed')?.items[0]
    if (!snoozedFocusItem) throw new Error('The Focus fixture requires one snoozed item.')
    snoozedFocusItem.snoozedUntil = '2026-08-11T00:00:00Z'

    const itemUpdatedAt = structuredClone(focusQueueResponseFixture)
    const [updatedItem] = requireFirstTwoFocusItems(itemUpdatedAt)
    updatedItem.updatedAt = '2026-08-09T04:30:00Z'

    const policyUpdatedAt = structuredClone(focusQueueResponseFixture)
    if (!policyUpdatedAt.userPolicy) throw new Error('The Focus fixture requires a user policy.')
    policyUpdatedAt.userPolicy.updatedAt = '2026-08-09T04:00:00Z'

    for (const response of [
      generatedAt,
      sourceOccurredAt,
      evaluatedAt,
      validUntil,
      openWithResolvedAt,
      resolvedWithoutResolvedAt,
      noncanonicalResolvedAt,
      snoozedUntil,
      itemUpdatedAt,
      policyUpdatedAt,
    ]) {
      await expectInvalidFocusQueueResponse(response)
    }
  })

  test('rejects out-of-range policies, duplicate Team capabilities, and loose targets', async () => {
    const fractionalSettings = structuredClone(focusQueueResponseFixture)
    const settings = fractionalSettings.effectivePolicies[0]?.settings
    if (!settings) throw new Error('The Focus fixture requires effective settings.')
    settings.dueSoonDays = 1.5

    const boundedSettings = structuredClone(focusQueueResponseFixture)
    const weights = boundedSettings.effectivePolicies[0]?.settings.weights
    if (!weights) throw new Error('The Focus fixture requires effective weights.')
    weights.blocker = 10_001

    const fractionalOverrides = structuredClone(focusQueueResponseFixture)
    if (!fractionalOverrides.userPolicy) {
      throw new Error('The Focus fixture requires a user policy.')
    }
    fractionalOverrides.userPolicy.overrides.slaHours = 1.5

    const boundedOverrides = structuredClone(focusQueueResponseFixture)
    if (!boundedOverrides.userPolicy) throw new Error('The Focus fixture requires a user policy.')
    boundedOverrides.userPolicy.overrides.weights = { urgent: -1 }

    const duplicateEditableTeam = {
      ...focusQueueResponseFixture,
      policyCapabilities: {
        canEditPersonal: true,
        editableTeamIds: ['core-team', 'core-team'],
      },
    }
    const blankEditableTeam = {
      ...focusQueueResponseFixture,
      policyCapabilities: {
        canEditPersonal: true,
        editableTeamIds: [''],
      },
    }
    const looseUserTarget = {
      ...focusQueueResponseFixture,
      userPolicy: {
        ...focusQueueResponseFixture.userPolicy,
        target: { type: 'user', userId: 'another@example.com' },
      },
    }

    for (const response of [
      fractionalSettings,
      boundedSettings,
      fractionalOverrides,
      boundedOverrides,
      duplicateEditableTeam,
      blankEditableTeam,
      looseUserTarget,
    ]) {
      await expectInvalidFocusQueueResponse(response)
    }
  })

  test('rejects inconsistent section, identity, rank, and policy references', async () => {
    const wrongSectionOrder = {
      ...focusQueueResponseFixture,
      sections: [...focusQueueResponseFixture.sections].reverse(),
    }

    const duplicateSection = structuredClone(focusQueueResponseFixture)
    const duplicateGroup = duplicateSection.sections[1]
    if (!duplicateGroup) throw new Error('The Focus fixture requires a Next section.')
    duplicateGroup.section = 'now'

    const mismatchedItemSection = structuredClone(focusQueueResponseFixture)
    const [mismatchedItem] = requireFirstTwoFocusItems(mismatchedItemSection)
    mismatchedItem.section = 'next'

    const duplicateItemId = structuredClone(focusQueueResponseFixture)
    const [firstIdentityItem, secondIdentityItem] = requireFirstTwoFocusItems(duplicateItemId)
    secondIdentityItem.id = firstIdentityItem.id

    const duplicateWorkItem = structuredClone(focusQueueResponseFixture)
    const [firstWorkItem, secondWorkItem] = requireFirstTwoFocusItems(duplicateWorkItem)
    secondWorkItem.workItem = structuredClone(firstWorkItem.workItem)

    const missingSignalReference = structuredClone(focusQueueResponseFixture)
    const [signalReferenceItem] = requireFirstTwoFocusItems(missingSignalReference)
    const referencedComponent = signalReferenceItem.rank.components[0]
    if (!referencedComponent) throw new Error('The Focus fixture requires one rank component.')
    referencedComponent.signalId = 'missing-signal'

    const invalidRankSum = structuredClone(focusQueueResponseFixture)
    const [rankedItem] = requireFirstTwoFocusItems(invalidRankSum)
    rankedItem.rank.score += 1

    const missingPolicyReference = structuredClone(focusQueueResponseFixture)
    const [policyItem] = requireFirstTwoFocusItems(missingPolicyReference)
    policyItem.effectivePolicyId = 'missing-policy'

    const invalidResponses = [
      wrongSectionOrder,
      duplicateSection,
      mismatchedItemSection,
      duplicateItemId,
      duplicateWorkItem,
      missingSignalReference,
      invalidRankSum,
      missingPolicyReference,
    ]

    for (const response of invalidResponses) {
      await expectInvalidFocusQueueResponse(response)
    }
  })

  test('sends revision and mutation headers to the encoded snooze endpoint', async () => {
    let observedUrl = ''
    let observedInit: RequestInit | undefined
    const item = focusQueueResponseFixture.sections[0]?.items[0]
    if (!item) throw new Error('The Focus fixture requires one item.')
    globalThis.fetch = async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return new Response(JSON.stringify({ item }), { status: 200 })
    }

    await updateFocusSnooze(
      'core team',
      'WI/194',
      'focus-token',
      { expectedVersion: 3, snoozedUntil: '2026-08-10T00:00:00.000Z' },
      { correlationId: 'correlation-1', idempotencyKey: 'idempotency-1' },
    )

    expect(observedUrl).toEndWith('/focus/items/core%20team/WI%2F194/snooze')
    expect(observedInit?.method).toBe('PUT')
    expect(new Headers(observedInit?.headers).get('Authorization')).toBe('Bearer focus-token')
    expect(new Headers(observedInit?.headers).get('Idempotency-Key')).toBe('idempotency-1')
    expect(observedInit?.body).toBe(JSON.stringify({
      expectedVersion: 3,
      snoozedUntil: '2026-08-10T00:00:00.000Z',
    }))
  })
})

/**
 * Returns the first two Now items required by semantic response validation tests.
 *
 * @param response - Mutable clone of the complete Focus response fixture.
 * @returns The first and second Now items.
 */
function requireFirstTwoFocusItems(response: FocusQueueResponse): [FocusItem, FocusItem] {
  const firstItem = response.sections[0]?.items[0]
  const secondItem = response.sections[0]?.items[1]
  if (!firstItem || !secondItem) {
    throw new Error('The Focus fixture requires two Now items.')
  }
  return [firstItem, secondItem]
}

/**
 * Expects one untrusted Focus response to fail with the stable boundary code.
 *
 * @param response - Structurally or semantically invalid response body.
 * @returns Nothing after the request has been rejected.
 */
async function expectInvalidFocusQueueResponse(response: unknown): Promise<void> {
  globalThis.fetch = async () => new Response(JSON.stringify(response), { status: 200 })
  await expect(getFocusQueue('focus-token')).rejects.toMatchObject({
    code: 'InvalidFocusQueueResponse',
    status: 502,
  })
}
