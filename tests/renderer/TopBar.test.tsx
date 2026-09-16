import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TopBar } from '../../renderer/src/components/layout/TopBar';

describe('TopBar', () => {
  it('renders brand title', () => {
    render(<TopBar shopCount={3} connectionStatus="connected" />);
    expect(screen.getByText('飞鸽AI客服')).toBeInTheDocument();
  });

  it('shows shop count', () => {
    render(<TopBar shopCount={5} connectionStatus="connected" />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows "已连接" when connected', () => {
    render(<TopBar shopCount={1} connectionStatus="connected" />);
    expect(screen.getByText('已连接')).toBeInTheDocument();
  });

  it('shows "连接中" while loading or logging in', () => {
    render(<TopBar shopCount={1} connectionStatus="connecting" />);
    expect(screen.getByText('连接中')).toBeInTheDocument();
  });

  it('shows "未连接" when there is no logged-in shop', () => {
    render(<TopBar shopCount={0} connectionStatus="idle" />);
    expect(screen.getByText('未连接')).toBeInTheDocument();
  });

  it('renders theme toggle button', () => {
    render(<TopBar shopCount={1} connectionStatus="connected" />);
    expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument();
  });

  it('routes notification and settings actions to the parent', () => {
    const onOpenNotifications = jest.fn();
    const onOpenSettings = jest.fn();
    render(
      <TopBar
        shopCount={1}
        connectionStatus="connected"
        alertCount={2}
        onOpenNotifications={onOpenNotifications}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '通知' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
