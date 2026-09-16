import { useEffect } from 'react';
import { useToast } from './Toast';

export function DeepseekErrorHandler() {
  const toast = useToast();

  useEffect(() => {
    const unsub = window.api.deepseek.onError((data) => {
      toast.show('error', data.message);
    });
    return unsub;
  }, [toast]);

  return null;
}
