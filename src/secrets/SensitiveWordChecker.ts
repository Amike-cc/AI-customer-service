/**
 * 敏感词检测器
 * 详见 docs/21-进程模型与运行细节.md §21.6
 */
import fs from 'fs-extra';
import type { Config } from '../config/schema';

interface SensitiveEntry {
  word: string;
  category: string;
  action: 'block' | 'warn' | 'replace';
}

export interface SensitiveHit {
  word: string;
  category: string;
  action: 'block' | 'warn' | 'replace';
  position: number;
}

export interface SensitiveCheckResult {
  passed: boolean;
  hits: SensitiveHit[];
}

export class SensitiveWordChecker {
  private entries: SensitiveEntry[] = [];
  private entryMap = new Map<string, SensitiveEntry>();
  private compiledRegex: RegExp | null = null;
  private replaceRegex: RegExp | null = null;

  constructor(private config: Config) {}

  async load(): Promise<void> {
    const filePath = this.config.deepseek.sensitive_words_dict;
    if (!(await fs.pathExists(filePath))) return;

    const lines = (await fs.readFile(filePath, 'utf8')).split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [word, category, action] = trimmed.split('|');
      if (!word || !category || !action) continue;
      this.entries.push({
        word: word.trim(),
        category: category.trim(),
        action: action.trim() as 'block' | 'warn' | 'replace',
      });
    }
    this.buildIndex();
  }

  async reload(): Promise<void> {
    this.entries = [];
    this.entryMap.clear();
    this.compiledRegex = null;
    this.replaceRegex = null;
    await this.load();
  }

  private buildIndex(): void {
    this.entryMap.clear();
    for (const entry of this.entries) {
      this.entryMap.set(entry.word, entry);
    }

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (this.entries.length > 0) {
      const sorted = [...this.entries].sort((a, b) => b.word.length - a.word.length);
      this.compiledRegex = new RegExp(sorted.map((e) => escape(e.word)).join('|'), 'g');
    } else {
      this.compiledRegex = null;
    }

    const replaceEntries = this.entries.filter((e) => e.action === 'replace');
    if (replaceEntries.length > 0) {
      const sorted = [...replaceEntries].sort((a, b) => b.word.length - a.word.length);
      this.replaceRegex = new RegExp(sorted.map((e) => escape(e.word)).join('|'), 'g');
    } else {
      this.replaceRegex = null;
    }
  }

  check(text: string): SensitiveCheckResult {
    const hits: SensitiveHit[] = [];
    if (this.compiledRegex) {
      this.compiledRegex.lastIndex = 0;
      for (const match of text.matchAll(this.compiledRegex)) {
        const matched = match[0];
        const entry = this.entryMap.get(matched);
        if (entry) {
          hits.push({
            word: matched,
            category: entry.category,
            action: entry.action,
            position: match.index ?? 0,
          });
        }
      }
    }
    const blocks = hits.filter((h) => h.action === 'block');
    return { passed: blocks.length === 0, hits };
  }

  /** 将 replace 类型的敏感词替换为 *** */
  sanitize(text: string): string {
    if (!this.replaceRegex) return text;
    this.replaceRegex.lastIndex = 0;
    return text.replace(this.replaceRegex, (matched) => '*'.repeat(matched.length));
  }
}
