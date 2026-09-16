import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StatusBar } from '../../renderer/src/components/layout/StatusBar';

describe('StatusBar', () => {
  it('renders status message', () => {
    const { container } = render(<StatusBar message="就绪" />);
    expect(screen.getByText('就绪')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('当前状态就绪');
    expect(screen.getByLabelText('应用状态栏')).toBeInTheDocument();
    expect(container.querySelector('.dot')).not.toBeInTheDocument();
  });

  it('updates message on prop change', () => {
    const { rerender } = render(<StatusBar message="就绪" />);
    expect(screen.getByText('就绪')).toBeInTheDocument();
    rerender(<StatusBar message="已切换店铺" />);
    expect(screen.getByText('已切换店铺')).toBeInTheDocument();
  });

  it('renders time display', () => {
    render(<StatusBar message="测试" />);
    // Time format should be HH:MM:SS
    const timeRegex = /\d{2}:\d{2}:\d{2}/;
    const timeElement = screen.getByText(timeRegex);
    expect(timeElement).toBeInTheDocument();
    expect(timeElement.tagName).toBe('TIME');
    expect(timeElement).toHaveAttribute('datetime', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(timeElement).toHaveAccessibleName(`当前时间 ${timeElement.textContent}`);
  });

  it('uses the shop login status instead of claiming the connection is healthy', () => {
    const { rerender } = render(
      <StatusBar message="就绪" shopName="测试店" platformLabel="抖店" loginStatus="logged_out" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('未登录|抖店 · 测试店');

    rerender(
      <StatusBar message="就绪" shopName="测试店" platformLabel="抖店" loginStatus="logging_in" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('登录中|抖店 · 测试店');

    rerender(
      <StatusBar message="就绪" shopName="测试店" platformLabel="抖店" loginStatus="logged_in" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('连接正常|抖店 · 测试店');
  });
});
