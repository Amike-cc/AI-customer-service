/**
 * 飞书告警通知器
 * 详见 docs/18-监控与告警.md §18.6.1
 */
import axios from 'axios';
import crypto from 'crypto';
import type { AlertLevel } from '../AlertManager';

export class FeishuNotifier {
  constructor(private webhookUrl: string, private secret?: string) {}

  async send(level: AlertLevel, title: string, message: string): Promise<void> {
    const text = this.formatMessage(level, title, message);
    const body: Record<string, unknown> = {
      msg_type: 'text',
      content: { text },
    };

    if (this.secret) {
      const sign = this.genSign(this.secret);
      body.timestamp = sign.timestamp;
      body.sign = sign.sign;
    }

    // 10s 超时：webhook 无响应时不能阻塞告警链路
    await axios.post(this.webhookUrl, body, { timeout: 10000 });
  }

  private formatMessage(level: AlertLevel, title: string, message: string): string {
    const emoji: Record<AlertLevel, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `${emoji[level]} [${level.toUpperCase()}] ${title}\n时间: ${time}\n详情: ${message}`;
  }

  private genSign(secret: string): { timestamp: string; sign: string } {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
    return { timestamp, sign };
  }
}
