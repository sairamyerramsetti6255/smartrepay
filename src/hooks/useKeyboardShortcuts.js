import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function useKeyboardShortcuts() {
  const navigate = useNavigate()

  useEffect(() => {
    function onKey(e) {
      if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key === 'm') navigate('/match')
      if (key === 'e') navigate('/exceptions')
      if (key === 'r') navigate('/reconcile')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}
