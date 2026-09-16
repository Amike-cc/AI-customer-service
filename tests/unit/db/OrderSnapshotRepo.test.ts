import SqliteDatabase from 'better-sqlite3';
import { OrderSnapshotRepo } from '../../../src/db/repos/OrderSnapshotRepo';

describe('OrderSnapshotRepo.search', () => {
  let db: SqliteDatabase.Database;
  let repo: OrderSnapshotRepo;
  const rows = [
    {
      shop_id: 'shop-a',
      session_id: 'session-1',
      order_ref: 'ORD-1001',
      summary: '蓝色卫衣 1 件',
      platform_url: 'https://example.test/order/1001',
      captured_at: 2,
    },
  ];

  beforeEach(() => {
    const all = jest.fn(() => rows);
    db = { prepare: jest.fn(() => ({ all })) } as unknown as SqliteDatabase.Database;
    repo = new OrderSnapshotRepo(db);
  });

  it('matches order reference or summary within requested shops', () => {
    expect(repo.search(['shop-a'], '蓝色', 20).map((row) => row.orderRef)).toEqual(['ORD-1001']);
    expect(repo.search(['shop-a'], 'ORD-1001', 20)[0]?.sessionId).toBe('session-1');
    expect(repo.search([], 'ORD-1001', 20)).toHaveLength(0);
  });
});
