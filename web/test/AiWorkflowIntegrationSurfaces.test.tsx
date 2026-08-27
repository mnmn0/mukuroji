import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAssistanceGeneration, AiPlanningDraft } from '@mukuroji/contracts'
import { DocumentContextPanel } from '../src/documents/ui/DocumentContextPanel'
import {
  documentCommentFixtures,
  documentRecordFixture,
} from '../src/documents/fixtures'
import {
  aiPlanningGenerationFixture,
  aiSummaryGenerationFixture,
  aiWithheldGenerationFixture,
} from '../src/features/ai-assistance/fixtures'
import { AiPlanningStatusUpdateAssistantView } from '../src/features/ai-assistance/ui/AiPlanningStatusUpdateAssistant'
import { AiSummaryAssistantView } from '../src/features/ai-assistance/ui/AiSummaryAssistant'
import { AiWorkItemPlanningAssistantView } from '../src/features/ai-assistance/ui/AiWorkItemPlanningAssistant'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

describe('AI workflow integration surfaces', () => {
  test('keeps a Document source body out of the idle Brief markup', () => {
    const protectedBody = 'DOCUMENT_COMMENT_BODY_NOT_AUTHORIZED_FOR_IDLE_MARKUP'
    const html = renderToStaticMarkup(
      <DocumentContextPanel
        activeTab="brief"
        aiAssistanceAccessToken="test-access-token"
        backlinks={[]}
        comments={documentCommentFixtures.map((comment) => ({
          ...comment,
          body: protectedBody,
        }))}
        document={documentRecordFixture}
        locale="en"
        onClose={() => undefined}
        onTabChange={() => undefined}
        t={t}
        versions={[]}
      />,
    )

    expect(html).toContain('Generate brief')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toMatch(/aria-controls="[^"]+-document-context-tabpanel"/)
    expect(html).toMatch(/aria-labelledby="[^"]+-document-context-tab-brief"/)
    expect(html).not.toContain(protectedBody)
    expect(html).not.toContain(aiSummaryGenerationFixture.content.availability === 'available'
      ? aiSummaryGenerationFixture.content.draft.overview.text
      : 'UNREACHABLE_SUMMARY')
  })

  test('keeps the Document Brief mounted while another context tab is active', () => {
    const html = renderToStaticMarkup(
      <DocumentContextPanel
        activeTab="comments"
        aiAssistanceAccessToken="test-access-token"
        backlinks={[]}
        comments={[]}
        document={documentRecordFixture}
        locale="en"
        onClose={() => undefined}
        onTabChange={() => undefined}
        t={t}
        versions={[]}
      />,
    )

    expect(html).toContain('data-testid="ai-summary-assistant"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('Generate brief')
  })

  /** Verifies closing the drawer hides rather than unmounts the Brief session. */
  test('keeps the Document Brief mounted while the drawer is closed', () => {
    const html = renderToStaticMarkup(
      <DocumentContextPanel
        activeTab="brief"
        aiAssistanceAccessToken="test-access-token"
        backlinks={[]}
        comments={[]}
        document={documentRecordFixture}
        isOpen={false}
        locale="en"
        onClose={() => undefined}
        onTabChange={() => undefined}
        t={t}
        versions={[]}
      />,
    )

    expect(html).toMatch(/<aside[^>]*hidden=""/)
    expect(html).toContain('data-testid="ai-summary-assistant"')
    expect(html).toContain('Generate brief')
  })

  test('withholds a previously generated Brief without invoking domain adoption', () => {
    let adoptCount = 0
    const html = renderToStaticMarkup(
      <AiSummaryAssistantView
        generation={aiWithheldGenerationFixture}
        locale="en"
        onAdopt={() => { adoptCount += 1 }}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('unavailable because access changed')
    expect(html).not.toContain('Launch readiness notes')
    expect(html).not.toContain('The launch review is waiting')
    expect(adoptCount).toBe(0)
  })

  test('renders a Planning proposal without calling publish or local adoption on render', () => {
    let adoptCount = 0
    let generateCount = 0
    const html = renderToStaticMarkup(
      <AiPlanningStatusUpdateAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onAdopt={() => { adoptCount += 1 }}
        onDecide={async () => undefined}
        onGenerate={() => { generateCount += 1 }}
        t={t}
      />,
    )

    expect(html).toContain('Use status update in form')
    expect(html).toContain('The launch remains staged while accessibility sign-off is completed.')
    expect(adoptCount).toBe(0)
    expect(generateCount).toBe(0)
  })

  test('hides Planning approval actions while the status update is publishing', () => {
    const html = renderToStaticMarkup(
      <AiPlanningStatusUpdateAssistantView
        disabled
        generation={aiPlanningGenerationFixture}
        locale="en"
        onAdopt={() => undefined}
        onDecide={async () => undefined}
        onFeedback={() => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('The launch remains staged while accessibility sign-off is completed.')
    expect(html).not.toContain('Use status update in form')
    expect(html).not.toContain('Reject draft')
    expect(html).not.toContain('Was this draft helpful?')
  })

  /** Keeps an in-flight Planning generation cancellable until publishing starts. */
  test('keeps Planning cancellation available while AI generation is pending', () => {
    const html = renderToStaticMarkup(
      <AiPlanningStatusUpdateAssistantView
        isGenerating
        locale="en"
        onCancelGeneration={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('Cancel generation')
  })

  test('makes Work Item fields, estimate, child items, and dependencies reviewable', () => {
    let adoptCount = 0
    let generateCount = 0
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        locale="en"
        onAdopt={() => { adoptCount += 1 }}
        onDecide={async () => undefined}
        onGenerate={() => { generateCount += 1 }}
        t={t}
      />,
    )

    expect(html).toContain('Use supported fields in form')
    expect(html).toContain('Complete launch accessibility review')
    expect(html).toContain('4h')
    expect(html).toContain('Verify keyboard navigation findings')
    expect(html).toContain('accessibility-review')
    expect(html).toContain('staged-launch')
    expect(adoptCount).toBe(0)
    expect(generateCount).toBe(0)
  })

  /** Keeps Work Item AI actions unavailable while the canonical save is pending. */
  test('hides Work Item AI actions while the Work Item mutation is pending', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={aiPlanningGenerationFixture}
        isMutationPending
        locale="en"
        onAdopt={() => undefined}
        onDecide={async () => undefined}
        onFeedback={() => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('Complete launch accessibility review')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Use supported fields in form')
    expect(html).not.toContain('Reject draft')
    expect(html).not.toContain('Was this draft helpful?')
  })

  /** Keeps an in-flight Work Item generation cancellable while no domain save is running. */
  test('keeps Work Item cancellation available while AI generation is pending', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        isGenerating
        locale="en"
        onCancelGeneration={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('Cancel generation')
  })

  /** Verifies review-only Planning values remain visible without an adoption callback. */
  test('does not offer Work Item adoption for review-only Planning values', () => {
    const content = aiPlanningGenerationFixture.content
    if (content.availability !== 'available' || content.draft.kind !== 'planning') {
      throw new Error('Planning fixture must stay available.')
    }
    const reviewOnlyDraft: AiPlanningDraft = {
      dependencies: content.draft.dependencies,
      kind: 'planning',
      plannedEffortMinutes: content.draft.plannedEffortMinutes,
      statusUpdate: content.draft.statusUpdate,
      subtasks: content.draft.subtasks,
    }
    const reviewOnlyGeneration: AiAssistanceGeneration = {
      ...aiPlanningGenerationFixture,
      content: {
        ...content,
        draft: reviewOnlyDraft,
      },
    }

    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        generation={reviewOnlyGeneration}
        locale="en"
        onAdopt={() => undefined}
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).toContain('4h')
    expect(html).not.toContain('Use supported fields in form')
  })

  test('does not focus or render a replacement prompt before a Work Item draft exists', () => {
    const html = renderToStaticMarkup(
      <AiWorkItemPlanningAssistantView
        locale="en"
        onDecide={async () => undefined}
        onGenerate={() => undefined}
        t={t}
      />,
    )

    expect(html).not.toContain('Keep or replace your manual edits?')
    expect(html).not.toContain('Replace with AI draft')
  })
})
