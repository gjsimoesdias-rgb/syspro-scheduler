import React, { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** Render this instead of the default fallback UI when an error is caught. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called when an error is caught. Hook this up to your telemetry pipeline. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Subtree to protect. */
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level error boundary. Without this, any thrown error in a child
 * component blanks the whole React tree and the user sees a white screen.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 * Or, for finer-grained recovery, wrap individual heavy panels (Gantt,
 * What-if, ScheduleComparison) so a single panel crash doesn't kill the
 * rest of the UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log so the developer console shows the full component stack.
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught an error:', error, info);
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      return <DefaultFallback error={error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

interface DefaultFallbackProps {
  error: Error;
  onReset: () => void;
}

const DefaultFallback: React.FC<DefaultFallbackProps> = ({ error, onReset }) => {
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '2rem',
    background: 'var(--bg-base, #0b1020)',
    color: 'var(--text-primary, #e6ebf5)',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    textAlign: 'center'
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 560,
    background: 'var(--bg-surface, #131a37)',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 12,
    padding: '2rem',
    boxShadow: '0 12px 36px rgba(0,0,0,0.08)'
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 12,
    justifyContent: 'center',
    marginTop: '1.25rem'
  };

  const primaryBtn: React.CSSProperties = {
    padding: '0.6rem 1.2rem',
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600
  };

  const secondaryBtn: React.CSSProperties = {
    padding: '0.6rem 1.2rem',
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(0,0,0,0.2)',
    borderRadius: 6,
    cursor: 'pointer'
  };

  const detailStyle: React.CSSProperties = {
    marginTop: '1rem',
    padding: '0.75rem',
    background: 'rgba(0,0,0,0.04)',
    borderRadius: 6,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    textAlign: 'left',
    overflow: 'auto',
    maxHeight: 220
  };

  return (
    <div style={containerStyle} role="alert" aria-live="assertive">
      <div style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Something went wrong</h1>
        <p style={{ marginTop: '0.5rem', opacity: 0.85 }}>
          The scheduler hit an unexpected error and couldn&apos;t finish rendering. The
          rest of your data is safe — try reloading. If it keeps happening,
          copy the details below to whoever maintains this app.
        </p>
        <div style={buttonRowStyle}>
          <button type="button" style={primaryBtn} onClick={() => window.location.reload()}>
            Reload page
          </button>
          <button type="button" style={secondaryBtn} onClick={onReset}>
            Try again
          </button>
        </div>
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer' }}>Technical details</summary>
          <pre style={detailStyle}>{error.message}{'\n\n'}{error.stack}</pre>
        </details>
      </div>
    </div>
  );
};

export default ErrorBoundary;
