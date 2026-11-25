import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  myRequestAwaitingReplyFixture,
  myRequestListFixture,
  myRequestRestrictedWorkItemFixture,
  myRequestVisibleWorkItemFixture,
} from '../fixtures'
import { MyRequestsView } from './MyRequestsView'

/**
 * "My requests" の Storybook metadata です。
 */
const meta = {
  title: 'Application/Requests/My Requests',
  component: MyRequestsView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
          <Story />
        </main>
      </MemoryRouter>
    ),
  ],
  args: {
    requests: myRequestListFixture,
    isLoading: false,
    hasLoadError: false,
    canLoadMore: false,
    onLoadMore: fn(),
    onRetryList: fn(),
    onRetryDetail: fn(),
    onSelectRequest: fn(),
    hasDetailError: false,
    isDetailLoading: false,
    onReply: fn(async () => undefined),
    locale: 'ja',
    t: createTranslator('ja'),
  },
} satisfies Meta<typeof MyRequestsView>

export default meta

type Story = StoryObj<typeof meta>

/** 一覧だけを表示し、依頼を選ぶよう促す状態です。 */
export const List: Story = {}

/** 追加情報を求められた依頼に返信する状態です。 */
export const AwaitingReply: Story = {
  args: {
    selectedRequestId: myRequestAwaitingReplyFixture.id,
    selectedRequest: myRequestAwaitingReplyFixture,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByRole('textbox'), 'ThinkPad X1 を 8/1 から使います。')
    await userEvent.click(canvas.getByRole('button', { name: '返信を送る' }))
    await expect(args.onReply).toHaveBeenCalledWith(
      myRequestAwaitingReplyFixture.id,
      'ThinkPad X1 を 8/1 から使います。',
    )
  },
}

/** 見られる Work Item の番号・タイトル・状態とリンクを表示します。 */
export const VisibleWorkItem: Story = {
  args: {
    selectedRequestId: myRequestVisibleWorkItemFixture.id,
    selectedRequest: myRequestVisibleWorkItemFixture,
  },
}

/** 見られない Work Item は完了したかどうかだけを表示します。 */
export const RestrictedWorkItem: Story = {
  args: {
    selectedRequestId: myRequestRestrictedWorkItemFixture.id,
    selectedRequest: myRequestRestrictedWorkItemFixture,
  },
}

/** 一覧の読み込みに失敗し、再読み込みできる状態です。 */
export const LoadError: Story = {
  args: { requests: [], hasLoadError: true },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '再読み込み' }))
    await expect(args.onRetryList).toHaveBeenCalled()
  },
}

/** 一覧と選んだ依頼の詳細を読み込んでいる状態です。 */
export const Loading: Story = {
  args: {
    requests: [],
    isLoading: true,
    selectedRequestId: myRequestAwaitingReplyFixture.id,
    isDetailLoading: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('依頼を読み込んでいます…')).toBeInTheDocument()
    await expect(canvas.getByText('依頼の詳細を読み込んでいます…')).toBeInTheDocument()
  },
}
