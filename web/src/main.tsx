import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyFontSizePreference, getInitialFontSizePreference } from './preferences/fontSize'

applyFontSizePreference(getInitialFontSizePreference())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
