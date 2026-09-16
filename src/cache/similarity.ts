/**
 * 文本相似度工具函数
 *
 * 提供 bigram 字符级 n-gram 集合与 Jaccard 相似度计算。
 * 被 LruCache 语义缓存和 PatternMatcher 学习模式匹配共用。
 */

const SYNONYMS: Array<[string, string]> = [
  ['退货', '退换'],
  ['退款', '退钱'],
  ['发货', '寄出'],
  ['到货', '收到'],
  ['尺码', '尺寸'],
  ['颜色', '色号'],
  ['快递', '物流'],
  ['人工', '真人客服'],
  ['便宜', '优惠'],
  ['多少钱', '价格'],
  ['什么时候', '何时'],
  ['坏了', '破损'],
  ['发错', '寄错'],
];

export function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  const normalized = text.replace(/\s+/g, '');
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[b.length][a.length];
}

export function normalizeQuestion(text: string): string {
  let result = text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  for (const [from, to] of SYNONYMS) {
    result = result.replaceAll(from, to);
  }
  return result;
}

export function similarity(a: string, b: string): number {
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  const bigramSim = jaccard(bigramsA, bigramsB);
  if (a.length < 20 || b.length < 20) {
    const editSim = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
    return Math.max(bigramSim, editSim * 0.9);
  }
  return bigramSim;
}

export function getDynamicThreshold(text: string): number {
  if (text.length < 10) return 0.85;
  if (text.length < 30) return 0.75;
  return 0.7;
}
