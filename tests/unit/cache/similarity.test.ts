/**
 * 文本相似度工具函数单元测试
 * 覆盖 bigrams、jaccard、levenshtein、normalizeQuestion、similarity、getDynamicThreshold
 */
import {
  bigrams,
  jaccard,
  levenshtein,
  normalizeQuestion,
  similarity,
  getDynamicThreshold,
} from '@/cache/similarity';

describe('similarity 工具函数', () => {
  it('bigrams 正确生成二元组', () => {
    const result = bigrams('abcd');
    expect(result).toEqual(new Set(['ab', 'bc', 'cd']));
  });

  it('bigrams 忽略空白字符', () => {
    const result = bigrams('a b c');
    expect(result).toEqual(new Set(['ab', 'bc']));
  });

  it('jaccard 相似度计算（相同返回1）', () => {
    const a = new Set(['ab', 'bc', 'cd']);
    expect(jaccard(a, a)).toBe(1);
  });

  it('jaccard 无交集返回0', () => {
    const a = new Set(['ab', 'bc']);
    const b = new Set(['xy', 'yz']);
    expect(jaccard(a, b)).toBe(0);
  });

  it('levenshtein 编辑距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('normalizeQuestion 同义词归一化（退货=退换、快递=物流、多少钱=价格）', () => {
    expect(normalizeQuestion('退货')).toBe('退换');
    expect(normalizeQuestion('快递')).toBe('物流');
    expect(normalizeQuestion('多少钱')).toBe('价格');
  });

  it('normalizeQuestion 去除标点和空格', () => {
    expect(normalizeQuestion('你好，世界！')).toBe('你好世界');
    expect(normalizeQuestion('  Hello   World  ')).toBe('helloworld');
    expect(normalizeQuestion('退款？多少钱！')).toBe('退钱价格');
  });

  it('similarity 短文本使用编辑距离辅助（退货 vs 退换 > 0.4）', () => {
    // 纯 bigram 相似度为 0（无共同二元组），编辑距离辅助后应 > 0.4
    // levenshtein('退货','退换')=1, editSim=1-1/2=0.5, 0.5*0.9=0.45
    const sim = similarity('退货', '退换');
    expect(sim).toBeGreaterThan(0.4);
    // 验证确实大于纯 bigram 相似度（0）
    const bigramSim = jaccard(bigrams('退货'), bigrams('退换'));
    expect(sim).toBeGreaterThan(bigramSim);
  });

  it('getDynamicThreshold 短文本高阈值', () => {
    // 短文本（<10）返回最高阈值 0.85
    expect(getDynamicThreshold('短')).toBe(0.85);
    expect(getDynamicThreshold('一二三四五')).toBe(0.85);
    // 中等文本（10-29）返回 0.75
    expect(getDynamicThreshold('这是一个中等长度的文本')).toBe(0.75);
    // 长文本（>=30）返回 0.7
    expect(
      getDynamicThreshold('这是一个非常长的文本用于测试动态阈值功能它已经超过了三十个字符的长度限制'),
    ).toBe(0.7);
  });
});
