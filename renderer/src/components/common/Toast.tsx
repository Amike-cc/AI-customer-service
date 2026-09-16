import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import styles from './Toast.module.css';

type ToastType = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  show: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;
const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // 保存自动关闭定时器句柄，组件卸载时统一清理（避免卸载后 setState）
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (type: ToastType, message: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, type, message }].slice(-MAX_TOASTS));
      const timer = setTimeout(() => dismiss(id), 4000);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // 卸载时清理全部定时器
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, []);

  // Context 值稳定：避免每次渲染重建对象导致订阅方 effect 反复执行
  const contextValue = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className={styles.container} aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle size={18} />,
  error: <AlertCircle size={18} />,
  warn: <AlertTriangle size={18} />,
  info: <Info size={18} />,
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  return (
    <div
      className={[styles.toast, styles[item.type]].filter(Boolean).join(' ')}
      role={item.type === 'error' || item.type === 'warn' ? 'alert' : 'status'}
    >
      <span className={styles.icon}>{ICONS[item.type]}</span>
      <span className={styles.message}>{item.message}</span>
      <button type="button" className={styles.close} onClick={onDismiss} aria-label="关闭通知">
        <X size={14} />
      </button>
    </div>
  );
}
