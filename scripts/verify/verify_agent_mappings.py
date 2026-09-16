"""验证 shop_business_config 表的 agent_mappings 字段是否成功迁移"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'app.db')

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("PRAGMA table_info(shop_business_config)")
    cols = cur.fetchall()
    print('shop_business_config columns:')
    for c in cols:
        print(f'  {c[1]}: {c[2]} default={c[4]}')

    agent_row = [c for c in cols if c[1] == 'agent_mappings']
    print(f'\nagent_mappings column exists: {len(agent_row) > 0}')
    if agent_row:
        print(f'  type={agent_row[0][2]}, default={agent_row[0][4]}, notnull={agent_row[0][3]}')

    # 查询所有店铺的 agent_mappings 值
    print('\nExisting agent_mappings data:')
    cur.execute("SELECT shop_id, agent_mappings FROM shop_business_config")
    rows = cur.fetchall()
    for row in rows:
        print(f'  shop_id={row[0]}, agent_mappings={row[1]}')
    if not rows:
        print('  (no rows - no shop business config records yet)')

    conn.close()
    print('\nVerification complete.')

if __name__ == '__main__':
    main()
