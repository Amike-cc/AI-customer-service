"""检查数据库中飞鸽 shop_business_config 的当前配置"""
import sqlite3, json
conn = sqlite3.connect(r'd:\code\AIkefu\data\app.db')
cur = conn.cursor()
SHOP_ID = '1783701851888'

cur.execute("SELECT agent_mappings FROM shop_business_config WHERE shop_id=?", (SHOP_ID,))
row = cur.fetchone()
print("=== 飞鸽 agent_mappings ===")
if row:
    try:
        parsed = json.loads(row[0])
        print(json.dumps(parsed, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"parse error: {e}, raw: {row[0]}")
else:
    print("(no row)")

# 也检查所有 4 个店铺
cur.execute("SELECT shop_id, shop_name, platform FROM shop_config ORDER BY shop_id")
print("\n=== 所有店铺 ===")
for r in cur.fetchall():
    print(f"  shop_id={r[0]}, name={r[1]}, platform={r[2]}")

# 查询是否有转移指标记录
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%transfer%' OR name LIKE '%metric%' OR name LIKE '%event%')")
print("\n=== 转移/指标相关表 ===")
for r in cur.fetchall():
    print(f"  {r[0]}")

conn.close()
