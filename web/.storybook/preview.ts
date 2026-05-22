import type { Preview } from '@storybook/react-vite'
import '../src/index.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      expanded: true,
    },
    options: {
      storySort: {
        order: ['Introduction', 'Application', 'Design System'],
      },
    },
  },
}

export default preview
