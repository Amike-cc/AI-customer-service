/**
 * Sidebar 组件测试
 * 覆盖店铺列表渲染、错误显示、空状态提示等场景
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Sidebar } from '../../renderer/src/components/layout/Sidebar';
import type { ShopListItem } from '../../renderer/src/types/api';

jest.mock('../../renderer/src/components/common/DropdownMenu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown">{children}</div>,
}));
jest.mock('../../renderer/src/components/common/Modal', () => ({
  Modal: ({ children, open, footer }: { children: React.ReactNode; open: boolean; footer?: React.ReactNode }) =>
    open ? <div data-testid="modal">{children}{footer}</div> : null,
}));
jest.mock('../../renderer/src/components/common/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div data-testid="confirm-dialog">{title}</div> : null,
}));
jest.mock('../../renderer/src/components/common/Input', () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock('../../renderer/src/components/common/Button', () => ({
  Button: (props: any) => <button {...props}>{props.children}</button>,
}));
jest.mock('../../renderer/src/components/common/Select', () => ({
  Select: (props: any) => <select {...props}>{props.children}</select>,
}));
jest.mock('../../renderer/src/components/common/Toast', () => ({
  useToast: () => ({ show: jest.fn() }),
}));
jest.mock('../../renderer/src/components/shops/TestReplyDialog', () => ({
  TestReplyDialog: () => <div data-testid="test-reply-dialog" />,
}));

const noop = () => Promise.resolve();
const noopDetect = () => Promise.resolve({ ok: true, agents: [] });

const defaultProps = {
  shops: [],
  activeShopId: null,
  view: 'shop' as const,
  alertCount: 0,
  loginStatuses: {},
  error: null as string | null,
  onSelectShop: jest.fn(),
  onOpenSettings: jest.fn(),
  onTakeover: noop,
  onRelease: noop,
  onAddAccount: noop,
  onRemove: noop,
  onStart: noop,
  onStop: noop,
  onRename: noop,
  onSetAutoReply: noop,
  onSetTransferTarget: noop,
  onDetectAgents: noopDetect,
};

function makeShop(overrides?: Partial<ShopListItem>): ShopListItem {
  return {
    shopId: '1001',
    shopName: '测试店铺',
    platform: 'feige',
    feigeClientPath: '',
    enabled: true,
    autoReply: true,
    loginStatus: 'logged_in',
    lastLoginAt: Date.now(),
    transferTarget: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'Idle',
    stateRecord: {},
    ...overrides,
  };
}

describe('Sidebar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('无店铺且无错误时显示空提示', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText(/暂无店铺/)).toBeInTheDocument();
  });

  it('error prop 非空时显示错误信息', () => {
    const errMsg = '获取店铺列表失败: 数据库连接超时';
    render(<Sidebar {...defaultProps} error={errMsg} />);
    expect(screen.getByText(errMsg)).toBeInTheDocument();
  });

  it('error prop 为 null 时不显示错误区域', () => {
    render(<Sidebar {...defaultProps} error={null} />);
    const errorElements = screen.queryAllByText(/获取店铺列表失败/);
    expect(errorElements).toHaveLength(0);
  });

  it('有店铺时不显示空提示', () => {
    const shops = [makeShop({ shopId: '1', shopName: '店铺A' })];
    render(<Sidebar {...defaultProps} shops={shops} />);
    expect(screen.queryByText(/暂无店铺/)).not.toBeInTheDocument();
    expect(screen.getByText('店铺A')).toBeInTheDocument();
  });

  it('多店铺全部渲染', () => {
    const shops = [
      makeShop({ shopId: '1', shopName: '店铺A' }),
      makeShop({ shopId: '2', shopName: '店铺B', platform: 'pinduoduo' }),
      makeShop({ shopId: '3', shopName: '店铺C', platform: 'kuaishou' }),
    ];
    render(<Sidebar {...defaultProps} shops={shops} />);
    expect(screen.getByText('店铺A')).toBeInTheDocument();
    expect(screen.getByText('店铺B')).toBeInTheDocument();
    expect(screen.getByText('店铺C')).toBeInTheDocument();
  });

  it('点击店铺触发 onSelectShop', () => {
    const shops = [makeShop({ shopId: '42', shopName: '点击测试店' })];
    const onSelectShop = jest.fn();
    render(<Sidebar {...defaultProps} shops={shops} onSelectShop={onSelectShop} />);
    fireEvent.click(screen.getByText('点击测试店'));
    expect(onSelectShop).toHaveBeenCalledWith('42');
  });

  it('显示平台标签', () => {
    const shops = [makeShop({ shopId: '1', shopName: '拼多多店', platform: 'pinduoduo' })];
    render(<Sidebar {...defaultProps} shops={shops} />);
    expect(screen.getByText('拼多多')).toBeInTheDocument();
  });

  it('同时有错误和店铺时错误信息优先显示', () => {
    const shops = [makeShop({ shopId: '1', shopName: '店铺A' })];
    const errMsg = '获取店铺列表失败: 部分数据缺失';
    render(<Sidebar {...defaultProps} shops={shops} error={errMsg} />);
    expect(screen.getByText(errMsg)).toBeInTheDocument();
    expect(screen.getByText('店铺A')).toBeInTheDocument();
  });

  it('点击主导航将入口交给上层路由', () => {
    const onNavigate = jest.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: '商品' }));
    expect(onNavigate).toHaveBeenCalledWith('products');
  });

  it('添加店铺弹窗支持四个平台卡片选择并提交平台', async () => {
    const onAddAccount = jest.fn().mockResolvedValue(undefined);
    render(<Sidebar {...defaultProps} onAddAccount={onAddAccount} />);

    fireEvent.click(screen.getAllByRole('button', { name: '添加店铺' })[0]);
    expect(screen.getByRole('radiogroup', { name: '店铺平台' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '拼多多' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('radio', { name: '拼多多' }));
    fireEvent.change(screen.getByLabelText('店铺名称'), { target: { value: '拼多多测试店' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(onAddAccount).toHaveBeenCalledWith('拼多多测试店', 'pinduoduo'));
  });
});
