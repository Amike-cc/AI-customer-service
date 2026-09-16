import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from './Input';
import styles from './SearchInput.module.css';

interface SearchInputProps {
  placeholder?: string;
  onSearch: (value: string) => void;
  debounceMs?: number;
  ariaLabel?: string;
}

export function SearchInput({ placeholder = '搜索...', onSearch, debounceMs = 300, ariaLabel }: SearchInputProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      onSearch(value);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [value, onSearch, debounceMs]);

  return (
    <div className={styles.search}>
      <Input
        icon={<Search size={14} />}
        type="search"
        aria-label={ariaLabel ?? placeholder.replace(/\.{3}|…/g, '')}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={[styles.input, value && styles.inputWithClear].filter(Boolean).join(' ')}
      />
      {value && (
        <button type="button" className={styles.clearButton} onClick={() => setValue('')} aria-label="清空搜索">
          <X size={13} />
        </button>
      )}
    </div>
  );
}
