import { Component } from 'react'
import { Button } from '@/components/ui/button'

export class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card p-8 text-center">
          <h2 className="text-base font-semibold text-[var(--danger)]">Something went wrong</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{this.state.error?.message}</p>
          <Button className="mt-4" variant="secondary" onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
