import { describe, expect, test } from 'bun:test'
import { aiAssistanceOfflineBaseline } from './offline-baseline'
import {
  createAiAssistanceOfflineReviewDigests,
  evaluateAiAssistanceOffline,
  type AiAssistanceOfflineBaseline,
  type AiAssistanceOfflineInputCase,
  type AiAssistanceOfflineRecordedOutput,
} from './evaluate-ai-assistance'

/** Returns one required sanitized input case by zero-based position. */
function requireInputCase(index: number): AiAssistanceOfflineInputCase {
  const inputCase = aiAssistanceOfflineBaseline.inputDataset.cases[index]
  if (!inputCase) throw new TypeError(`Offline input case ${index} is required.`)
  return inputCase
}

/** Returns one required recorded output by zero-based position. */
function requireRecordedOutput(index: number): AiAssistanceOfflineRecordedOutput {
  const output = aiAssistanceOfflineBaseline.recordedOutputs.cases[index]
  if (!output) throw new TypeError(`Offline recorded output ${index} is required.`)
  return output
}

/** Creates a single-case baseline while retaining reviewed global provenance. */
function createSingleCaseBaseline(
  inputCase: AiAssistanceOfflineInputCase,
  recordedOutput: AiAssistanceOfflineRecordedOutput,
): AiAssistanceOfflineBaseline {
  return {
    inputDataset: {
      ...aiAssistanceOfflineBaseline.inputDataset,
      cases: [inputCase],
    },
    recordedOutputs: {
      ...aiAssistanceOfflineBaseline.recordedOutputs,
      cases: [recordedOutput],
    },
  }
}

describe('evaluateAiAssistanceOffline', () => {
  test('replays the sanitized four-workflow baseline through the production gateway', async () => {
    const report = await evaluateAiAssistanceOffline(aiAssistanceOfflineBaseline)
    const reviewDigests = createAiAssistanceOfflineReviewDigests(
      aiAssistanceOfflineBaseline,
    )

    expect(report.passed).toBe(true)
    expect(report.schemaVersion).toBe(2)
    expect(report.caseCount).toBe(4)
    expect(report.passedCaseCount).toBe(4)
    expect(report.provenance).toEqual({
      datasetRevision: 'sanitized-model-inputs-2026-08-25.v1',
      provider: 'bedrock-runtime',
      modelId: 'jp.anthropic.claude-sonnet-4-6',
      inferenceProfileId: 'jp.anthropic.claude-sonnet-4-6',
      promptVersion: 'ai-assistance-v1',
      schemaVersion: 1,
      systemInstructionsSha256: '6e5baf07fa8f5c09cd9ac86ddab7ca7dfd00111f420cf9984bc491387ff803b9',
      pricingRevision: 'bedrock-sonnet-4-6-standard-2026-08-25.v1',
      outputRevision: 'reviewed-structured-outputs-2026-08-25.v1',
    })
    expect(report.cases.every(
      (result) => result.metrics?.promptDigestMatched === true,
    )).toBe(true)
    expect(reviewDigests).toEqual({
      systemInstructionsSha256: '6e5baf07fa8f5c09cd9ac86ddab7ca7dfd00111f420cf9984bc491387ff803b9',
      cases: [
        {
          id: 'triage-grounded-routing-v2',
          promptSha256: '5b25bda8cd3ca0cfde828858346a79096669633db658732f6abceca09ba13f06',
        },
        {
          id: 'summary-grounded-actions-v2',
          promptSha256: 'f4976f16ac7cc36873024b4fe344d4ccfa6762b57ceb049165d28b378837c8d4',
        },
        {
          id: 'search-safe-filter-translation-v2',
          promptSha256: 'f65eb203359f3055518846a40ba3d991477b2f6cee5f9663b0ec551770320917',
        },
        {
          id: 'planning-review-only-draft-v2',
          promptSha256: 'c0817c229f2cfd3c78960f34c85bfad841a7594ea0086704ecf341d2bb56e7be',
        },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('promptContext')
    expect(JSON.stringify(report)).not.toContain('modelOutput')
    expect(JSON.stringify(report)).not.toContain('Checkout requests time out')
    expect(JSON.stringify(reviewDigests)).not.toContain('Checkout requests time out')
  })

  test('fails reviewed system-instruction and prompt-serialization digests independently', async () => {
    const inputCase = requireInputCase(0)
    const output = requireRecordedOutput(0)
    const promptRegression = createSingleCaseBaseline({
      ...inputCase,
      expectedPromptSha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    }, output)
    const systemRegression: AiAssistanceOfflineBaseline = {
      ...createSingleCaseBaseline(inputCase, output),
      inputDataset: {
        ...aiAssistanceOfflineBaseline.inputDataset,
        provenance: {
          ...aiAssistanceOfflineBaseline.inputDataset.provenance,
          systemInstructionsSha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
        cases: [inputCase],
      },
    }

    const promptReport = await evaluateAiAssistanceOffline(promptRegression)
    const systemReport = await evaluateAiAssistanceOffline(systemRegression)

    expect(promptReport.cases[0]?.failures).toContain('prompt-serialization-digest')
    expect(promptReport.cases[0]?.failures).not.toContain(
      'prompt-system-instructions-digest',
    )
    expect(systemReport.cases[0]?.failures).toContain(
      'prompt-system-instructions-digest',
    )
    expect(systemReport.cases[0]?.failures).not.toContain('prompt-serialization-digest')
  })

  test('fails the production strict parser for an incompatible recorded output', async () => {
    const inputCase = requireInputCase(2)
    const output = requireRecordedOutput(2)
    const invalidOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      modelOutput: {
        draft: {
          kind: 'search',
          interpretation: 'Unsafe relaxed output.',
          filters: {},
          caveats: [],
          unsupportedField: true,
        },
        uncertainty: { level: 'low', reason: 'This must be rejected.' },
      },
    }

    const report = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(inputCase, invalidOutput),
    )

    expect(report.passed).toBe(false)
    expect(report.cases[0]?.failures).toContain('schema-invalid')
    expect(report.cases[0]?.failures).not.toContain('prompt-serialization-digest')
    expect(report.cases[0]?.metrics).toBeUndefined()
  })

  test('applies production task validation to recorded Planning outputs', async () => {
    const inputCase = requireInputCase(3)
    const output = requireRecordedOutput(3)
    const invalidOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      modelOutput: {
        draft: {
          kind: 'planning',
          subtasks: [],
          dependencies: [],
          statusUpdate: {
            health: 'on-track',
            risk: 'none',
            summary: 'The source remains on track.',
            riskSummary: '',
            decisionSummary: '',
            helpNeeded: '',
            nextAction: 'Schedule the next review.',
            confidence: 'high',
            citationIds: ['W1'],
          },
        },
        uncertainty: { level: 'low', reason: 'The source is clear.' },
      },
    }
    const relaxedInputCase: AiAssistanceOfflineInputCase = {
      ...inputCase,
      minimumClaimCount: 0,
      requiredTextFragments: [],
      forbiddenSubstrings: [],
    }

    const report = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(relaxedInputCase, invalidOutput),
    )

    expect(report.passed).toBe(false)
    expect(report.cases[0]?.failures).toContain('application-validation-failed')
  })

  test('applies production triage routing validation to recorded outputs', async () => {
    const inputCase = requireInputCase(0)
    const output = requireRecordedOutput(0)
    const invalidOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      modelOutput: {
        draft: {
          kind: 'triage',
          title: {
            value: 'Investigate checkout timeout',
            reason: 'The intake describes repeated checkout timeouts.',
            confidence: 'high',
            citationIds: ['R1'],
          },
          teamId: {
            value: 'team-payments',
            reason: 'The route is visible.',
            confidence: 'high',
            citationIds: ['R1'],
          },
          projectId: {
            value: 'project-checkout',
            reason: 'The project is visible.',
            confidence: 'high',
            citationIds: ['R1'],
          },
          customFields: [],
        },
        uncertainty: { level: 'low', reason: 'The source is clear.' },
      },
    }
    const invalidInputCase: AiAssistanceOfflineInputCase = {
      ...inputCase,
      modelInput: {
        ...inputCase.modelInput,
        allowedValues: {
          ...inputCase.modelInput.allowedValues,
          triageRoutingTuples: [{
            teamId: 'team-payments',
            projectId: 'project-other',
            assigneeUserIds: ['member-payments-oncall'],
          }],
        },
      },
      minimumClaimCount: 0,
      requiredTextFragments: [],
      forbiddenSubstrings: [],
    }

    const report = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(invalidInputCase, invalidOutput),
    )

    expect(report.passed).toBe(false)
    expect(report.cases[0]?.failures).toContain('application-validation-failed')
  })

  test('fails closed without disclosing unsafe recorded output content', async () => {
    const inputCase = requireInputCase(1)
    const output = requireRecordedOutput(1)
    const unsafeOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      modelOutput: {
        draft: {
          kind: 'summary',
          overview: {
            id: 'overview-unsafe',
            text: 'SECRET_CANARY from an unauthorized source AKIA1234567890ABCDEF',
            confidence: 'high',
            citationIds: ['UNKNOWN'],
          },
          decisions: [],
          actions: [],
          risks: [],
        },
        uncertainty: { level: 'low', reason: 'SECRET_CANARY' },
      },
    }
    const unsafeInputCase: AiAssistanceOfflineInputCase = {
      ...inputCase,
      minimumClaimCount: 1,
      requiredTextFragments: [],
    }

    const report = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(unsafeInputCase, unsafeOutput),
    )
    const serializedReport = JSON.stringify(report)

    expect(report.passed).toBe(false)
    expect(report.cases[0]?.failures).toContain('citation-unknown')
    expect(report.cases[0]?.failures).toContain('safety-canary-leak')
    expect(serializedReport).not.toContain('SECRET_CANARY')
    expect(serializedReport).not.toContain('unauthorized source')
    expect(serializedReport).not.toContain('AKIA1234567890ABCDEF')
  })

  test('uses production redaction for recorded credential canaries', async () => {
    const inputCase = requireInputCase(1)
    const output = requireRecordedOutput(1)
    // Assemble token-shaped canaries at runtime so repository scanning treats them as fixtures.
    const canaries = [
      'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      'Cookie: session=opaque-session; HttpOnly',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.dGVzdC1zaWduYXR1cmU',
      ['ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'].join(''),
      ['xoxb-', '123456789012-123456789012-abcdefghijklmnopqrstuvwx'].join(''),
      'https://operator:password@example.test/private',
    ]

    for (const [index, canary] of canaries.entries()) {
      const canaryInput: AiAssistanceOfflineInputCase = {
        ...inputCase,
        id: `credential-canary-${index}`,
        minimumClaimCount: 1,
        requiredTextFragments: [],
      }
      const canaryOutput: AiAssistanceOfflineRecordedOutput = {
        ...output,
        id: canaryInput.id,
        modelOutput: {
          draft: {
            kind: 'summary',
            overview: {
              id: 'overview-canary',
              text: canary,
              confidence: 'high',
              citationIds: ['D1'],
            },
            decisions: [],
            actions: [],
            risks: [],
          },
          uncertainty: { level: 'low', reason: 'The fixture is intentionally unsafe.' },
        },
      }
      const report = await evaluateAiAssistanceOffline(
        createSingleCaseBaseline(canaryInput, canaryOutput),
      )

      expect(report.passed).toBe(false)
      expect(report.cases[0]?.failures).toContain('safety-canary-leak')
      expect(report.cases[0]?.metrics?.forbiddenMatchCount).toBe(1)
      expect(JSON.stringify(report)).not.toContain(canary)
    }
  })

  test('rejects unauthorized filter identifiers and an unredacted input recording', async () => {
    const inputCase = requireInputCase(2)
    const output = requireRecordedOutput(2)
    const unsafeFilterOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      modelOutput: {
        draft: {
          kind: 'search',
          interpretation: 'All work from another team.',
          filters: { teamIds: ['other-team'] },
          caveats: [],
        },
        uncertainty: {
          level: 'low',
          reason: 'The requested team is not in the reviewed allowlist.',
        },
      },
    }
    const unredactedInput: AiAssistanceOfflineInputCase = {
      ...inputCase,
      modelInput: {
        ...inputCase.modelInput,
        promptContext: 'Authorization: Bearer not-safe-for-a-recorded-input',
      },
    }

    const filterReport = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(inputCase, unsafeFilterOutput),
    )
    const inputReport = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(unredactedInput, output),
    )

    expect(filterReport.cases[0]?.failures).toContain('allowed-value-unknown')
    expect(filterReport.cases[0]?.failures).toContain('search-filter-mismatch')
    expect(inputReport.cases[0]?.failures).toContain('input-not-sanitized')
    expect(inputReport.cases[0]?.failures).toContain('prompt-serialization-digest')
    expect(JSON.stringify(inputReport)).not.toContain('not-safe-for-a-recorded-input')
  })

  test('fails provider budgets and independently versioned recording alignment', async () => {
    const inputCase = requireInputCase(3)
    const output = requireRecordedOutput(3)
    const expensiveOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      usage: {
        inputTokens: 100_000,
        outputTokens: 100_000,
        latencyMs: inputCase.budgets.maxLatencyMs + 1,
      },
    }
    const mismatchedOutput: AiAssistanceOfflineRecordedOutput = {
      ...output,
      id: 'different-recording-id',
    }

    const budgetReport = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(inputCase, expensiveOutput),
    )
    const alignmentReport = await evaluateAiAssistanceOffline(
      createSingleCaseBaseline(inputCase, mismatchedOutput),
    )

    expect(budgetReport.cases[0]?.failures).toContain('budget-input-tokens')
    expect(budgetReport.cases[0]?.failures).toContain('budget-output-tokens')
    expect(budgetReport.cases[0]?.failures).toContain('budget-latency')
    expect(budgetReport.cases[0]?.failures).toContain('budget-cost')
    expect(alignmentReport.cases[0]?.failures).toEqual(['recording-pair-mismatch'])
  })
})
