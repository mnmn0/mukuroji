import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, userEvent, within } from 'storybook/test'
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
  return (
    <>
      <AiActivityLauncher t={t} />
      <main className="mx-auto grid max-w-3xl gap-6 p-6">
        <h1 className="text-xl font-semibold">リリースに向けた進捗</h1>
        <button className="workbench-button-primary min-h-[44px] w-fit px-4" disabled={controller.isGenerating} onClick={() => void controller.generate({ task: 'summary', locale: 'ja', sources: [{ type: 'document', documentId: 'doc-1', expectedRevision: 1 }] })} type="button">要約を生成</button>
        <AiAssistanceReview generation={controller.generation} isGenerating={controller.isGenerating} locale="ja" onCancelGeneration={controller.cancelGeneration} renderDraft={() => <p>レビュー待ちの課題をまとめました。</p>} t={t} />
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
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.endsWith('/ai-assistance/generations')) return originalFetch(input, init)
      await new Promise((resolve) => setTimeout(resolve, 400))
      return Response.json({ ...aiSummaryGenerationFixture, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })
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
    await within(dialog).findByRole('button', { name: /確認待ち リリースに向けた進捗/ })
    await userEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
    await expect(launcher).toHaveFocus()
    await expect(canvas.getByRole('heading', { name: 'あなたの確認待ち' })).toBeVisible()
  },
}
