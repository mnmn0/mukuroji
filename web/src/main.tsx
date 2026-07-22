import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App'
import {
  applyFontSizePreference,
  getInitialFontSizePreference,
} from './shared/lib/preferences/fontSize'

applyFontSizePreference(getInitialFontSizePreference())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
