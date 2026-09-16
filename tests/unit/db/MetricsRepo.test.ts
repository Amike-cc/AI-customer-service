import { MetricsRepo } from '@/db/repos/MetricsRepo';

describe('MetricsRepo', () => {
  it('sumByTag limits tagged totals to the requested shop', () => {
    const all = jest.fn().mockReturnValue([
      { tags: JSON.stringify({ type: 'input' }), total: 12 },
      { tags: JSON.stringify({ type: 'output' }), total: 5 },
    ]);
    const prepare = jest.fn().mockReturnValue({ all });
    const repo = new MetricsRepo({ prepare } as any);

    const totals = repo.sumByTag('token_consumed_total', 1_000, 'type', '10001');

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('shop_id = ?'));
    expect(all).toHaveBeenCalledWith('token_consumed_total', '10001', 1_000);
    expect(totals.get('input')).toBe(12);
    expect(totals.get('output')).toBe(5);
  });

  it('sumByTag keeps an explicit all-shop query when no shop is selected', () => {
    const all = jest.fn().mockReturnValue([]);
    const prepare = jest.fn().mockReturnValue({ all });
    const repo = new MetricsRepo({ prepare } as any);

    repo.sumByTag('token_consumed_total', 1_000, 'type');

    expect(prepare).toHaveBeenCalledWith(expect.not.stringContaining('shop_id = ?'));
    expect(all).toHaveBeenCalledWith('token_consumed_total', 1_000);
  });
});
