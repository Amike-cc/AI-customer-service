export type DiagnosticStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type DiagnosticCategory = 'config' | 'python' | 'models' | 'files' | 'runtime';

export interface DiagnosticResult {
  id: string;
  name: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  message: string;
  detail?: string;
  fixSuggestion?: string;
}

export interface DiagnosticSummary {
  results: DiagnosticResult[];
  total: number;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  healthScore: number;
  runAt: number;
}

export interface HealthStatus {
  healthy: boolean;
  dbConnected: boolean;
  visionRunning: boolean;
  apiKeyConfigured: boolean;
  shopCount: number;
  uptimeMs: number;
}
