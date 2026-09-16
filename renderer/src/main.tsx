import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/variables.css';
import './styles/global.css';
import './styles/animations.css';
import appLayout from '../../shared/ui-layout.json';

// Electron WebContentsView 与 React 外壳共用同一份布局尺寸，避免店铺网页覆盖侧栏或产生留缝。
document.documentElement.style.setProperty('--sidebar-width', `${appLayout.sidebarWidth}px`);
document.documentElement.style.setProperty('--topbar-height', `${appLayout.topbarHeight}px`);
document.documentElement.style.setProperty('--statusbar-height', `${appLayout.statusbarHeight}px`);

// 浏览器环境（非 Electron）下注入 window.api mock，避免组件崩溃
// Electron 环境下 contextBridge 会覆盖此 mock
if (typeof window !== 'undefined' && !(window as any).api) {
  const noop = () => { /* no-op in browser */ };
  const noopPromise = <T,>(): Promise<T> => Promise.resolve(undefined as unknown as T);
  const noopArray = <T,>(): Promise<T[]> => Promise.resolve([] as unknown as T[]);
  const noopObj = <T,>(): Promise<T> => Promise.resolve({} as unknown as T);
  const subscribe = (): (() => void) => () => { /* no-op unsubscribe */ };

  (window as any).api = {
    app: {
      openExternal: (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve(); },
    },
    update: {
      getState: () => Promise.resolve({ status: 'not-available', currentVersion: '浏览器预览' }),
      check: () => Promise.resolve({ ok: false, state: { status: 'not-available', currentVersion: '浏览器预览' }, error: '浏览器预览模式' }),
      download: () => Promise.resolve({ ok: false, state: { status: 'not-available', currentVersion: '浏览器预览' }, error: '浏览器预览模式' }),
      install: () => Promise.resolve({ ok: false, state: { status: 'not-available', currentVersion: '浏览器预览' }, error: '浏览器预览模式' }),
      onStateChanged: subscribe,
    },
    shop: {
      list: noopArray, takeover: noopObj, release: noopObj,
      setAutoReply: noopObj, addAccount: noopObj, removeAccount: noopObj,
      switchView: noopObj, exitView: noopObj, getLoginStatus: noopObj,
      getActiveShop: () => Promise.resolve({ shopId: null }),
      start: noopObj, stop: noopObj, rename: noopObj,
      forceReLogin: noopObj, reload: noopObj,
      markRead: noopObj, sendReply: noopObj,
      getBusinessConfig: () => Promise.resolve({ ok: false, error: '浏览器预览模式' }),
      updateBusinessConfig: noopObj,
      onStateChanged: subscribe, onLoginStatusChanged: subscribe,
      onNameUpdated: subscribe, onTransferEvent: subscribe,
    },
    deepseek: { onError: subscribe },
    config: {
      get: () => Promise.resolve({}), getApiKey: () => Promise.resolve(''),
      updateApiKey: noopObj,
    },
    log: {
      subscribe: noopObj, history: noopArray,
      onStream: subscribe,
    },
    alert: {
      list: noopArray, acknowledge: noopObj,
      onStream: subscribe, onRecovered: subscribe,
    },
    conversation: {
      sessions: noopArray, messages: noopArray, search: noopArray,
      stream: noopArray, sendText: noopObj, sendAttachment: noopObj,
      draft: () => Promise.resolve({ ok: true, draft: '' }),
      onMessage: subscribe,
    },
    workspace: {
      getSnapshot: () => Promise.resolve({ ok: false, error: '浏览器预览模式：工作台快照不可用' }),
      setLayout: () => Promise.resolve({ ok: true, layout: null }),
    },
    search: { global: () => Promise.resolve({ ok: true, groups: [], total: 0 }) },
    order: {
      summary: () => Promise.resolve({ ok: true, snapshot: null, message: '浏览器预览模式：暂无订单摘要' }),
      capture: () => Promise.resolve({ ok: true, snapshot: null, message: '浏览器预览模式：无法读取平台订单' }),
    },
    transfer: { history: noopArray },
    view: { hideForModal: noopObj, restoreAfterModal: noopObj },
    db: { backup: () => Promise.resolve({ ok: false, path: '' }) },
    audit: { list: noopArray },
    metrics: { summary: noopObj, history: noopObj },
    diagnose: { run: () => Promise.resolve({ results: [], total: 0, pass: 0, warn: 0, fail: 0, skip: 0, healthScore: 0, runAt: Date.now() }) },
    diagnostic: { checkAutoReply: noopObj, testReply: noopObj, systemHealth: noopObj },
    rule: { list: noopArray, add: noopObj, update: noopObj, delete: noopObj, reload: noopObj, importJson: noopObj, test: noopObj },
    faq: { list: noopArray, add: noopObj, update: noopObj, delete: noopObj },
    product: { list: noopArray, get: noopPromise, add: noopObj, update: noopObj, delete: noopObj, importJson: noopObj, sync: noopObj, getSyncStatus: noopPromise },
    test: { reply: noopObj },
    kb: {
      getPrompt: () => Promise.resolve(''), savePrompt: noopObj,
      getSensitiveWords: noopArray, saveSensitiveWords: noopObj, reloadSensitiveWords: noopObj,
      listTemplates: noopArray, getTemplate: noopPromise, saveTemplate: noopObj,
      deleteTemplate: noopObj, searchTemplates: noopArray, recommendTemplates: noopArray,
      getCategoryStats: noopArray, importTemplates: noopObj, exportTemplates: () => Promise.resolve(''),
      listFaqsByCategory: noopArray, exportKnowledge: () => Promise.resolve(''),
      importKnowledge: noopObj, listVersions: noopArray, rollback: noopObj,
      deleteVersion: noopObj, getPermissions: noopObj, updatePermissions: noopObj,
      checkPermission: () => Promise.resolve(true),
      submitForReview: noopObj, approveReview: noopObj, rejectReview: noopObj,
      listPendingReviews: noopArray, listReviewHistory: noopArray,
      getAccuracyStats: noopObj, getAccuracyTrend: noopArray,
      getOptimizationSuggestions: noopArray,
    },
    feedback: { add: noopObj, list: noopArray, stats: noopObj },
    learning: { patterns: noopArray, runs: noopArray, trigger: noopObj, stats: noopObj },
    intent: { recent: noopArray, stats: noopObj },
    escalation: { list: noopArray, resolve: noopObj, stats: noopObj },
    agent: { queue: noopArray, list: noopArray, refresh: noopObj, assign: noopObj },
    buyer: {
      profile: noopObj, list: noopArray, stats: noopObj,
      updateTags: noopObj, updateRemark: noopObj,
    },
  };
}

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', savedTheme);
} else {
  // 默认浅色主题
  document.documentElement.setAttribute('data-theme', 'light');
  localStorage.setItem('theme', 'light');
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
