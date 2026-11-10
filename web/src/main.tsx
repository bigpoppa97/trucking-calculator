import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { AuthProvider } from './lib/auth.js'
// Fonts bundled with the app (10.11.2026) — weights the UI uses; Polish letters come from latin-ext.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/azeret-mono/400.css'
import '@fontsource/azeret-mono/500.css'
import '@fontsource/azeret-mono/600.css'
import '@fontsource/azeret-mono/700.css'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
