import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary } from '../../renderer/src/components/common/ErrorBoundary';

// Suppress console.error for expected error boundary behavior
const originalError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});
afterAll(() => {
  console.error = originalError;
});

function BrokenComponent(): React.ReactElement {
  throw new Error('test error');
}

function NormalComponent(): React.ReactElement {
  return <span>正常内容</span>;
}

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <NormalComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
  });

  it('renders fallback UI when child throws', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(screen.getByText('test error')).toBeInTheDocument();
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<span>自定义错误页面</span>}>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('自定义错误页面')).toBeInTheDocument();
  });

  it('renders reload button', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('刷新页面')).toBeInTheDocument();
  });

  it('calls onError callback', () => {
    const onError = jest.fn();
    render(
      <ErrorBoundary onError={onError}>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('test error');
  });
});