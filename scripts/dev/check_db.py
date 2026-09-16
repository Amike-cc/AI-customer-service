import sqlite3
import os

db_path = r'd:\code\AIkefu\data\electron\app.db'
if not os.path.exists(db_path):
    print('DB not found:', db_path)
    exit(1)

conn = sqlite3.connect(db_path)
cur = conn.cursor()

print('=== shop_config 表 ===')
cur.execute('SELECT shop_id, shop_name, platform, login_status, last_login_at, updated_at FROM shop_config ORDER BY shop_id')
rows = cur.fetchall()
for row in rows:
    print(f'shop_id={row[0]}  shop_name={row[1]!r}  platform={row[2]}  login_status={row[3]}  last_login_at={row[4]}  updated_at={row[5]}')

conn.close()
