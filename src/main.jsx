import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { loadRuntimeConfig } from '@/lib/runtimeConfig'
import App from '@/App.jsx'
import './index.css'

loadRuntimeConfig().then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
