import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';

// A component that throws on demand, used to trigger the boundary.
function MaybeThrow({ shouldThrow, message = 'test error message' }) {
  if (shouldThrow) throw new Error(message);
  return <div>rendered fine</div>;
}

describe('ErrorBoundary', () => {
  // Suppress React's console.error for expected boundary catches — the error
  // is intentional in these tests and the noise obscures actual failures.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  it('renders children normally when no error is thrown', () => {
    render(
      <ErrorBoundary label="Test">
        <MaybeThrow shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('rendered fine')).toBeInTheDocument();
  });

  it('catches a thrown child error and renders the fallback label', () => {
    render(
      <ErrorBoundary label="Widget">
        <MaybeThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Widget error/i)).toBeInTheDocument();
  });

  it('displays the error message in the fallback UI', () => {
    render(
      <ErrorBoundary label="Widget">
        <MaybeThrow shouldThrow={true} message="specific failure" />
      </ErrorBoundary>
    );
    expect(screen.getByText(/specific failure/i)).toBeInTheDocument();
  });

  it('renders a Retry button in the fallback UI', () => {
    render(
      <ErrorBoundary label="Widget">
        <MaybeThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('uses "Component" as the default label when none is provided', () => {
    render(
      <ErrorBoundary>
        <MaybeThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Component error/i)).toBeInTheDocument();
  });

  it('renders a custom fallback when the fallback prop is provided', () => {
    render(
      <ErrorBoundary fallback={<div>custom fallback</div>}>
        <MaybeThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
  });

  it('resets error state when Retry is clicked and child no longer throws', () => {
    // Use a ref-backed flag so the closure inside MaybeThrow reads live state.
    let shouldThrow = true;

    function RecoverableChild() {
      if (shouldThrow) throw new Error('recoverable');
      return <div>recovered</div>;
    }

    render(
      <ErrorBoundary label="Widget">
        <RecoverableChild />
      </ErrorBoundary>
    );

    // Boundary has caught the error.
    expect(screen.getByText(/Widget error/i)).toBeInTheDocument();

    // Resolve the underlying error condition.
    shouldThrow = false;

    // Click Retry — boundary resets hasError → false and re-renders child.
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
