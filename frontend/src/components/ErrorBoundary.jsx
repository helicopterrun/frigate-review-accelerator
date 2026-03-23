import React from 'react';

// TODO: Vitest test — ErrorBoundary catches thrown child error and
// renders fallback without unmounting sibling panels.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{ padding: 16, color: '#ff6b6b', background: '#1a1a2e',
                      borderRadius: 8, fontFamily: 'monospace', fontSize: 12 }}>
          <strong>{this.props.label ?? 'Component'} error</strong>
          <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
            {this.state.error?.message}
          </pre>
          <button onClick={() => this.setState({ hasError: false, error: null })}
                  style={{ marginTop: 8, padding: '4px 12px', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
