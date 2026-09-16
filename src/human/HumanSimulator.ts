/**
 * 人工行为模拟器
 * 详见 docs/开发文档-v2.md §5
 */
import type { Config } from '../config/schema';

export class HumanSimulator {
  constructor(private config: Config) {}

  /**
   * 计算回复延迟（毫秒），按时段差异化
   */
  getReplyDelayMs(): number {
    const hour = new Date().getHours();
    const { default: def, peak_hours, night_hours } = this.config.human_simulator.reply_delay;
    let range = def;
    if (peak_hours && hour >= peak_hours.hours[0] && hour < peak_hours.hours[1]) {
      range = peak_hours;
    } else if (night_hours && hour >= night_hours.hours[0] && hour < night_hours.hours[1]) {
      range = night_hours;
    }
    return this.randomBetween(range.min_ms, range.max_ms);
  }

  /**
   * 计算打字总耗时（毫秒），含段落停顿
   */
  getTypingDurationMs(text: string): number {
    const cpm = this.randomBetween(
      this.config.human_simulator.typing_speed_min_cpm,
      this.config.human_simulator.typing_speed_max_cpm,
    );
    const baseMs = (text.length / cpm) * 60 * 1000;

    const { min_chars, max_chars, min_ms, max_ms } = this.config.human_simulator.segment_pause;
    const pauseCount = Math.floor(text.length / this.randomBetween(min_chars, max_chars));
    const pauseMs = pauseCount * this.randomBetween(min_ms, max_ms);

    return Math.round(baseMs + pauseMs);
  }

  /**
   * 将文本分段打字，逐段回调
   */
  async typeText(text: string, onSegment: (segment: string) => Promise<void>): Promise<void> {
    const { min_chars, max_chars, min_ms, max_ms } = this.config.human_simulator.segment_pause;
    let pos = 0;
    while (pos < text.length) {
      const segLen = this.randomBetween(min_chars, max_chars);
      const segment = text.slice(pos, pos + segLen);
      await onSegment(segment);
      pos += segLen;
      if (pos < text.length) {
        await this.sleep(this.randomBetween(min_ms, max_ms));
      }
    }
  }

  /**
   * 仅将文本分段（不延迟），返回段数组
   * 用于需要预先知道分段数再逐段发送的场景
   */
  splitText(text: string): string[] {
    const { min_chars, max_chars } = this.config.human_simulator.segment_pause;
    const segments: string[] = [];
    let pos = 0;
    while (pos < text.length) {
      const segLen = this.randomBetween(min_chars, max_chars);
      segments.push(text.slice(pos, pos + segLen));
      pos += segLen;
    }
    return segments.length > 0 ? segments : [text];
  }

  randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
