import type { Preview } from '@storybook/react-vite'
import { applyThemePreference, isThemePreference } from '../src/shared/lib/preferences/theme'
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
  globalTypes: {
    theme: {
      description: 'Application color theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  decorators: [
    (Story, context) => {
      const theme: unknown = context.globals.theme
      applyThemePreference(isThemePreference(theme) ? theme : 'light')
      return Story()
    },
  ],
}

export default preview
