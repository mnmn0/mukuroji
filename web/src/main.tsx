import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App'
import { startAppServiceWorker } from './app/pwa/appServiceWorker'
import { startStaleChunkReload } from './app/staleChunkReload'
import { startAppInstallPrompt } from './shared/lib/pwa/installPrompt'
import {
  applyFontSizePreference,
  getInitialFontSizePreference,
} from './shared/lib/preferences/fontSize'
import {
  applyThemePreference,
  getInitialThemePreference,
} from './shared/lib/preferences/theme'

applyFontSizePreference(getInitialFontSizePreference())
applyThemePreference(getInitialThemePreference())
startStaleChunkReload()
startAppServiceWorker()
startAppInstallPrompt()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
