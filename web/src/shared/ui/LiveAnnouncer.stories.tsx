import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { announce } from '../lib/liveAnnouncements'
import { LiveAnnouncer } from './LiveAnnouncer'

const meta = {
  title: 'Design System/Live Announcer',
  component: LiveAnnouncer,
  decorators: [(Story) => (
    <div className="grid gap-3 p-6">
      <div className="flex gap-2">
        <button className="workbench-button" onClick={() => announce('変更を保存しました。')} type="button">
          保存を通知
        </button>
        <button
          className="workbench-button"
          onClick={() => announce('保存できませんでした。', 'assertive')}
          type="button"
        >
          失敗を通知
        </button>
      </div>
      <Story />
    </div>
  )],
} satisfies Meta<typeof LiveAnnouncer>

/** Persistent live regions that read confirmations and failures to screen-reader users. */
export default meta

/** Story variants for the live announcer. */
type Story = StoryObj<typeof meta>

/** Announces a polite confirmation and an assertive failure into the hidden regions. */
export const Announcements: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '保存を通知' }))
    await expect(canvas.getByTestId('live-announcer-polite')).toHaveTextContent('変更を保存しました。')
    await userEvent.click(canvas.getByRole('button', { name: '失敗を通知' }))
    await expect(canvas.getByTestId('live-announcer-assertive')).toHaveTextContent('保存できませんでした。')
  },
}
