import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { COMPLETION_GATE_OVERRIDE_REASON_FORM_FIELD } from '../model/completionGateOverride'
import { WorkItemCompletionGateStatus, type WorkItemCompletionGateStatusProps } from './WorkItemCompletionGateStatus'

/** Form ID the story editor uses, as the Work Item editor passes its own form ID. */
const storyFormId = 'completion-gate-story-editor'

/** Props of the story harness: the checklist props and the editor's submit callback. */
type CompletionGateStoryProps = WorkItemCompletionGateStatusProps & {
  /** Receives the status and override reason the editor form submits. */
  onSubmit: (values: { status: string; reason: string }) => void
}

/**
 * Renders the checklist next to a minimal Work Item editor form, so the override reason is
 * submitted with the chosen status the way the detail pane saves it.
 *
 * @param props - Checklist props and the submit callback.
 * @returns The checklist and the editor form.
 */
function CompletionGateStoryHarness({ onSubmit, ...props }: CompletionGateStoryProps) {
  return (
    <div className="grid max-w-xl gap-3">
      <WorkItemCompletionGateStatus {...props} />
      <form
        className="flex flex-wrap items-center gap-2"
        id={storyFormId}
        onSubmit={(event) => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          onSubmit({
            status: String(values.get('status') ?? ''),
            reason: String(values.get(COMPLETION_GATE_OVERRIDE_REASON_FORM_FIELD) ?? ''),
          })
        }}
      >
        <label className="text-sm" htmlFor={`${storyFormId}-status`}>Status</label>
        <select className="workbench-input px-2 py-1" defaultValue="doing" id={`${storyFormId}-status`} name="status">
          <option value="doing">Doing</option>
          <option value="done">Done</option>
        </select>
        <button className="workbench-button px-3 py-1" type="submit">Save</button>
      </form>
    </div>
  )
}

/** Metadata of the completion Gate checklist stories. */
const meta = {
  title: 'Application/Work Items/Completion Gate Status',
  component: CompletionGateStoryHarness,
  args: {
    policy: { acceptanceCriteria: 'required', humanApproval: 'warn' },
    acceptanceCriteria: [
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', text: 'Tests pass', satisfied: true },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', text: 'Docs updated', satisfied: false },
    ],
    approvalSummary: { pendingCount: 0, approvedCount: 0, changesRequestedCount: 0, rejectedCount: 0, overdueCount: 0 },
    locale: 'ja',
    onSubmit: fn(),
  },
} satisfies Meta<typeof CompletionGateStoryHarness>

export default meta
/** Typed completion Gate checklist story. */
type Story = StoryObj<typeof meta>

/** A manager enters an override reason and saves the Work Item as completed with the unmet Gate. */
export const ManagerOverride: Story = {
  args: { overrideFormId: storyFormId },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const reason = canvas.getByLabelText('Gate を override して完了にする理由（マネージャー）')
    await userEvent.type(reason, 'Docs ship in the follow-up release.')
    await userEvent.selectOptions(canvas.getByLabelText('Status'), 'done')
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }))
    await expect(args.onSubmit).toHaveBeenCalledWith({ status: 'done', reason: 'Docs ship in the follow-up release.' })
  },
}

/** A viewer who does not manage the Work Item sees the checklist but no override field. */
export const NonManager: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('work-item-completion-gate')).toBeVisible()
    await expect(canvas.queryByLabelText('Gate を override して完了にする理由（マネージャー）')).toBeNull()
  },
}

/** A fulfilled Gate never asks for an override reason, even from a manager. */
export const FulfilledGate: Story = {
  args: {
    overrideFormId: storyFormId,
    acceptanceCriteria: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', text: 'Tests pass', satisfied: true }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('work-item-completion-gate')).toBeVisible()
    await expect(canvas.queryByLabelText('Gate を override して完了にする理由（マネージャー）')).toBeNull()
  },
}
