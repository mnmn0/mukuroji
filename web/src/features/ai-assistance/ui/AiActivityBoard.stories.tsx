import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { aiActivityFixtures, aiActivityFixtureNow } from '../activityFixtures'
import { AiActivityBoard } from './AiActivityBoard'

/** Metadata for the session activity board's responsive and interaction coverage. */
const meta = {
  title: 'Application/AI Assistance/Activity Board',
  component: AiActivityBoard,
  decorators: [(Story) => <div className="h-svh"><Story /></div>],
  args: {
    activities: aiActivityFixtures,
    locale: 'ja',
    now: aiActivityFixtureNow,
    onClose: fn(),
    onOpenOrigin: fn(),
    t: createTranslator('ja'),
  },
} satisfies Meta<typeof AiActivityBoard>

export default meta
/** Typed activity board stories. */
type Story = StoryObj<typeof meta>

/** Every lane is populated with actual phase semantics, without fabricated percentages. */
export const Overview: Story = {}
/** English labels and long content preserve the same information hierarchy. */
export const English: Story = { args: { locale: 'en', t: createTranslator('en') } }
/** Empty session is distinct from a filtered-out result set. */
export const Empty: Story = { args: { activities: [] } }
/** Expired review items no longer count as actionable review work. */
export const Expired: Story = { args: { now: aiActivityFixtureNow + 120_000 } }
/** The phone layout changes from lanes to a focused detail screen. */
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
/** Search and attention filtering preserve all matching human decisions and errors. */
export const FilterAndSelect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '確認が必要' }))
    await expect(canvas.queryByRole('region', { name: 'AIが作業中' })).not.toBeInTheDocument()
    await expect(canvas.getByRole('region', { name: 'エラー・利用不可' })).toBeInTheDocument()
    await userEvent.type(canvas.getByRole('searchbox'), 'アクセス権限')
    const result = canvas.getByRole('button', { name: /確認待ち アクセス権限のリクエスト/ })
    await userEvent.click(result)
    await expect(result).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.getByRole('complementary')).toHaveFocus()
  },
}
