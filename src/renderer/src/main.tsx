import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// i18n first: the UI language is resolved before the first render.
import './i18n'
import App from './App'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
