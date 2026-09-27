import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiSummaryGenerationFixture } from '../fixtures'
import { useAiAssistanceController } from '../mutations/useAiAssistanceController'
import { AiActivityLauncher } from './AiActivityLauncher'
import { AiActivityProvider } from './AiActivityProvider'
import { AiAssistanceReview } from './AiAssistanceReview'

const t = createTranslator('ja')

/** Exercises the real controller and session provider against an isolated response fixture. */
function SessionAssistant() {
  const controller = useAiAssistanceController({ accessToken: 'storybook-token', activityLabel: 'リリースに向けた進捗をまとめる' })
  const [enabled, setEnabled] = useState(true)
  return (
    <>
      <AiActivityLauncher enabled={enabled} t={t} />
      <main className="mx-auto grid max-w-3xl gap-6 p-6">
        <h1 className="text-xl font-semibold">リリースに向けた進捗</h1>
        <button className="workbench-button-primary min-h-[44px] w-fit px-4" disabled={!enabled || controller.isGenerating} onClick={() => void controller.generate({ task: 'summary', locale: 'ja', sources: [{ type: 'document', documentId: 'doc-1', expectedRevision: 1 }] })} type="button">要約を生成</button>
        <button className="min-h-[44px] w-fit" onClick={() => setEnabled(false)} type="button">AIを無効にする</button>
        <AiAssistanceReview adoptLabel="案を承認" errorKind={controller.error?.kind} generation={controller.generation} isDecisionPending={controller.isDecisionPending} isGenerating={controller.isGenerating} locale="ja" onAdopt={async () => { await controller.decide('approved') }} onCancelGeneration={controller.cancelGeneration} renderDraft={() => <p>レビュー待ちの課題をまとめました。</p>} t={t} />
      </main>
    </>
  )
}

/** Metadata for the real session controller lifecycle, with no external AI request. */
const meta = {
  title: 'Application/AI Assistance/Activity Session',
  render: () => <MemoryRouter initialEntries={['/home']}><AiActivityProvider locale="ja"><SessionAssistant /></AiActivityProvider></MemoryRouter>,
  beforeEach: () => {
    const originalFetch = globalThis.fetch
    const generation = { ...aiSummaryGenerationFixture, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith(`/ai-assistance/generations/${generation.id}/decision`)) {
        return Response.json({ ...generation, revision: generation.revision + 1, decision: { outcome: 'approved', decidedAt: new Date().toISOString() } })
      }
      if (url.endsWith(`/ai-assistance/generations/${generation.id}`)) {
        return Response.json({ code: 'ProviderFailure' }, { status: 503 })
      }
      if (!url.endsWith('/ai-assistance/generations')) return originalFetch(input, init)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return Response.json(generation)
    }
    return () => { globalThis.fetch = originalFetch }
  },
} satisfies Meta
export default meta
/** Typed session integration story. */
type Story = StoryObj<typeof meta>

/** Opening the board preserves the active assistant and restores focus when dismissed. */
export const GenerationContinuesInBoard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '要約を生成' }))
    const launcher = canvas.getByRole('button', { name: 'AIアクティビティ' })
    await userEvent.click(launcher)
    const dialog = canvas.getByRole('dialog', { name: 'AIアクティビティ' })
    await expect(dialog).toBeVisible()
    await within(dialog).findByRole('button', { name: /確認待ち リリースに向けた進捗/ }, { timeout: 5000 })
    await userEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
    await expect(launcher).toHaveFocus()
    await expect(canvas.getByRole('heading', { name: 'あなたの確認待ち' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'AIを無効にする' }))
    await expect(launcher).toBeVisible()
  },
}

/** With no session activity, disabling all AI tasks hides the otherwise empty entry. */
export const DisabledWithoutHistory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'AIを無効にする' }))
    await expect(canvas.queryByRole('button', { name: 'AIアクティビティ' })).not.toBeInTheDocument()
  },
}

/** A phone detail leaving the Working filter returns focus to stable filter controls. */
export const WorkingSelectionCompletes: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '要約を生成' }))
    await userEvent.click(canvas.getByRole('button', { name: 'AIアクティビティ' }))
    const dialog = within(canvas.getByRole('dialog', { name: 'AIアクティビティ' }))
    await userEvent.click(dialog.getByRole('button', { name: '作業中' }))
    const card = dialog.getByRole('button', { name: /生成中 リリースに向けた進捗/ })
    await userEvent.click(card)
    const phoneDetail = card.offsetParent === null
    if (phoneDetail) await expect(dialog.getByRole('complementary')).toHaveFocus()
    await dialog.findByText('条件に一致する作業はありません。', {}, { timeout: 5000 })
    if (phoneDetail) await waitFor(() => expect(dialog.getByRole('group', { name: '表示する作業' })).toHaveFocus())
  },
}

/** A successful recorded approval remains visible when the following disclosure read fails. */
export const RecordedDecisionSurvivesReadFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '要約を生成' }))
    await userEvent.click(await canvas.findByRole('button', { name: '案を承認' }, { timeout: 5000 }))
    await waitFor(() => expect(canvas.queryByText('レビュー待ちの課題をまとめました。')).not.toBeInTheDocument())
    await userEvent.click(canvas.getByRole('button', { name: 'AIアクティビティ' }))
    const dialog = within(canvas.getByRole('dialog', { name: 'AIアクティビティ' }))
    await expect(dialog.getByRole('button', { name: /承認済み 要約を作成/ })).toBeVisible()
    await expect(dialog.queryByRole('button', { name: '元の画面へ' })).not.toBeInTheDocument()
  },
}
