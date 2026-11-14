import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ShowMoreItemsButton } from './ShowMoreItemsButton'
import { useIncrementalRender } from './useIncrementalRender'

/** Items of the sample long list. */
const sampleItems = Array.from({ length: 12 }, (_, index) => `Work Item ${index + 1}`)

/**
 * Renders a sample list in steps of five items with the "show more" button below it.
 *
 * @returns The sample list.
 */
function IncrementalListSample() {
  const { renderedItems, hiddenCount, showMore } = useIncrementalRender(sampleItems, 5)
  return (
    <div className="grid max-w-sm gap-2 p-6">
      <ul className="grid gap-1 text-sm" data-testid="incremental-list">
        {renderedItems.map((item) => <li key={item}>{item}</li>)}
      </ul>
      {hiddenCount > 0 ? (
        <ShowMoreItemsButton
          label={`さらに ${Math.min(5, hiddenCount)} 件を表示（未表示 ${hiddenCount} 件）`}
          onShowMore={showMore}
          testId="incremental-list-show-more"
        />
      ) : null}
    </div>
  )
}

const meta = {
  title: 'Design System/Show More Items Button',
  component: ShowMoreItemsButton,
  args: {
    label: 'さらに 200 件を表示（未表示 1800 件）',
    onShowMore: () => undefined,
  },
} satisfies Meta<typeof ShowMoreItemsButton>

/** Button below a long list that renders the next step of its items. */
export default meta

/** Story variants for the show-more button. */
type Story = StoryObj<typeof meta>

/** The button on its own, as shown under a 2,000-row table. */
export const Default: Story = {}

/** A long list that renders five items at a time until every item is shown. */
export const IncrementalList: Story = {
  render: () => <IncrementalListSample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = canvas.getByTestId('incremental-list')
    await expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    await userEvent.click(canvas.getByTestId('incremental-list-show-more'))
    await expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    await userEvent.click(canvas.getByTestId('incremental-list-show-more'))
    await expect(within(list).getAllByRole('listitem')).toHaveLength(12)
    await expect(canvas.queryByTestId('incremental-list-show-more')).toBeNull()
  },
}
