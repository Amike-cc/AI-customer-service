"""验证 buyer_profiles 表结构是否完整创建"""
import sqlite3
import os

db_path = r'd:\code\AIkefu\data\app.db'
print(f'数据库路径: {db_path}')
print(f'数据库存在: {os.path.exists(db_path)}')

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# 1. 验证 buyer_profiles 表存在
tables = cursor.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='buyer_profiles'"
).fetchall()
print(f'\n[V1] buyer_profiles 表存在: {len(tables) > 0}')

if tables:
    # 2. 验证字段完整
    cols = cursor.execute('PRAGMA table_info(buyer_profiles)').fetchall()
    col_names = [c[1] for c in cols]
    print(f'字段数量: {len(col_names)}')
    print(f'字段列表: {col_names}')

    expected_cols = [
        'id', 'shop_id', 'platform', 'buyer_name',
        'first_seen_at', 'last_seen_at',
        'consultation_count', 'message_count',
        'complaint_count', 'conversion_count', 'refund_count', 'escalation_count',
        'preferred_categories', 'preferred_specs', 'price_sensitivity',
        'vip_level', 'tags', 'remarks',
        'last_session_id', 'last_product_id', 'profile_version',
        'created_at', 'updated_at',
    ]
    missing = [c for c in expected_cols if c not in col_names]
    print(f'缺失字段: {missing if missing else "无"}')

    # 3. 验证索引
    indexes = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='buyer_profiles'"
    ).fetchall()
    print(f'\n索引: {[i[0] for i in indexes]}')

    # 4. 验证 UNIQUE 约束
    sql = cursor.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='buyer_profiles'"
    ).fetchone()[0]
    print(f'\nUNIQUE 约束存在: {"UNIQUE(shop_id, platform, buyer_name)" in sql}')

    # 5. 验证当前记录数
    count = cursor.execute('SELECT COUNT(*) FROM buyer_profiles').fetchone()[0]
    print(f'\n当前记录数: {count}')

conn.close()
print('\n=== 验证完成 ===')
