/**
 * 日志模块
 * 详见 docs/17-数据持久化与配置管理.md §17.9
 *
 * 导出 AppLogger 接口（宽松签名），支持以下两种调用格式：
 *   logger.info('plain message')
 *   logger.info({ shopId: 'x' }, 'message with meta')
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs-extra';
import type { Config } from '../config/schema';

const sanitizePatterns: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /1[3-9]\d{9}/g, replacement: '1**********' },
  { regex: /\d{17}[\dXx]/g, replacement: '******************' },
  { regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '***@***.***' },
  { regex: /\b\d{15,19}\b/g, replacement: '****************' },
];

/** 对任意字符串做敏感信息脱敏（手机号/身份证/邮箱/银行卡） */
function sanitizeText(value: string): string {
  let msg = value;
  for (const { regex, replacement } of sanitizePatterns) {
    msg = msg.replace(regex, replacement);
  }
  return msg;
}

/** 递归脱敏：覆盖嵌套对象/数组（如抓取 debug 数据、错误详情中的买家消息原文） */
function sanitizeDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // 防御深度过大的对象
  if (typeof value === 'string') return sanitizeText(value);
  if (value instanceof Error) {
    const err = value as Error & { stack?: string; message: string };
    try {
      err.message = sanitizeText(err.message);
      if (err.stack) err.stack = sanitizeText(err.stack);
    } catch {
      // 不可变 Error 忽略
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = sanitizeDeep(value[i], depth + 1) as typeof value[number];
    }
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        obj[k] = sanitizeText(v);
      } else if (v && typeof v === 'object') {
        obj[k] = sanitizeDeep(v, depth + 1);
      }
    }
    return value;
  }
  return value;
}

const sanitize = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = sanitizeText(info.message);
  }
  // meta 对象（err 堆栈、content、shopId 等字段）也可能包含买家消息原文，
  // 递归脱敏所有字段（含嵌套对象/数组），避免手机号/身份证等泄露到日志文件
  if (info && typeof info === 'object') {
    for (const key of Object.keys(info as Record<string, unknown>)) {
      if (key === 'message' || key === 'level' || key === 'timestamp' || key === 'label' || key === 'splat') {
        continue;
      }
      (info as Record<string, unknown>)[key] = sanitizeDeep((info as Record<string, unknown>)[key]);
    }
  }
  return info;
});

export interface AppLogger {
  trace(message: string, ...meta: unknown[]): void;
  trace(meta: object, message: string): void;
  debug(message: string, ...meta: unknown[]): void;
  debug(meta: object, message: string): void;
  info(message: string, ...meta: unknown[]): void;
  info(meta: object, message: string): void;
  warn(message: string, ...meta: unknown[]): void;
  warn(meta: object, message: string): void;
  error(message: string, ...meta: unknown[]): void;
  error(meta: object, message: string): void;
  child?(...args: unknown[]): AppLogger;
}

export function createLogger(config: Config, extraTransports?: winston.transport[]): AppLogger {
  const logDir = path.resolve(config.app.data_dir, 'logs');
  fs.ensureDirSync(logDir);

  const appLogTransport = new DailyRotateFile({
    filename: path.join(logDir, 'app-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: `${config.logging.rotation_max_bytes / 1024 / 1024}m`,
    maxFiles: `${config.logging.retention_days}d`,
  });
  const errorLogTransport = new DailyRotateFile({
    level: 'error',
    filename: path.join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: `${config.logging.rotation_max_bytes / 1024 / 1024}m`,
    maxFiles: `${config.logging.retention_days}d`,
  });

  // winston-daily-rotate-file v5 要求监听 error 事件，否则未处理的文件系统错误会崩溃进程
  appLogTransport.on('error', (err) => {
    console.error('app log transport error:', err);
  });
  errorLogTransport.on('error', (err) => {
    console.error('error log transport error:', err);
  });

  const transports: winston.transport[] = [
    appLogTransport,
    errorLogTransport,
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ];
  if (extraTransports && extraTransports.length > 0) {
    transports.push(...extraTransports);
  }

  const inner = winston.createLogger({
    level: config.logging.level,
    format: winston.format.combine(
      winston.format.timestamp(),
      sanitize(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports,
  });

  const wrap = (level: string) => (
    ...args: [object, string] | [string, ...unknown[]]
  ): void => {
    // 支持 (metaObject, messageString) 和 (messageString, ...meta) 两种格式
    if (args.length >= 2 && typeof args[0] === 'object' && args[0] !== null && typeof args[args.length - 1] === 'string') {
      const meta = args[0] as Record<string, unknown>;
      const message = args[args.length - 1] as string;
      inner.log(level, { ...meta, message });
      return;
    }
    inner.log(level, ...(args as [string, ...unknown[]]));
  };

  // 启动时清理超出保留期的旧日志文件
  const cleanupOldLogs = () => {
    const files = fs.readdirSync(logDir);
    const cutoff = Date.now() - config.logging.retention_days * 86400000;
    for (const file of files) {
      if (file.startsWith('app-') || file.startsWith('error-')) {
        const filePath = path.join(logDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.removeSync(filePath);
          }
        } catch { /* 跳过无法访问的文件 */ }
      }
    }
  };
  try { cleanupOldLogs(); } catch { /* 清理失败不阻塞启动 */ }

  return {
    trace: wrap('trace'),
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}
