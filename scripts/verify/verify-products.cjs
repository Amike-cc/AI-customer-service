// 逐帧验证商品 SKU/attrs/specs/variants/sales 完整性
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'data', 'shops', '1783701851888', 'products.json');
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);
const products = data.products || data;

const INVALID_VAL = /^(无|空|\s*|-|\/|null|undefined)$/i;
let totalIssues = 0;

console.log(`共 ${products.length} 个商品\n${'='.repeat(80)}`);

products.forEach((p, i) => {
  console.log(`\n【${i + 1}】${p.name}`);
  console.log(`  ID: ${p.product_id}  SKU: ${p.sku}  sales: ${p.sales ?? '缺失'}  active: ${p.active}`);

  // attrs
  const attrIssues = [];
  const attrNameCount = {};
  (p.attrs || []).forEach((a) => {
    attrNameCount[a.name] = (attrNameCount[a.name] || 0) + 1;
    if (INVALID_VAL.test(a.value || '')) attrIssues.push(`无效值"${a.value}"(${a.name})`);
    if (!a.value || a.value.trim() === '') attrIssues.push(`空值(${a.name})`);
  });
  const dupAttrs = Object.entries(attrNameCount).filter(([, c]) => c > 1).map(([n, c]) => `${n}x${c}`);
  console.log(`  attrs (${(p.attrs || []).length}): ${(p.attrs || []).map(a => `${a.name}:${a.value}`).join(' | ') || '无'}`);
  if (dupAttrs.length) { console.log(`  ⚠ attrs 重复: ${dupAttrs.join(', ')}`); attrIssues.push(`重复:${dupAttrs.join(',')}`); totalIssues++; }
  if (attrIssues.length) { console.log(`  ⚠ attrs 问题: ${attrIssues.join('; ')}`); totalIssues++; }

  // specs
  const specIssues = [];
  const specNameCount = {};
  (p.specs || []).forEach((s) => {
    specNameCount[s.name] = (specNameCount[s.name] || 0) + 1;
    if (!s.values || s.values.length === 0) specIssues.push(`空规格值(${s.name})`);
  });
  const dupSpecs = Object.entries(specNameCount).filter(([, c]) => c > 1).map(([n, c]) => `${n}x${c}`);
  console.log(`  specs (${(p.specs || []).length}): ${(p.specs || []).map(s => `${s.name}=[${(s.values || []).join(',')}]`).join(' | ') || '无'}`);
  if (dupSpecs.length) { console.log(`  ⚠ specs 重复: ${dupSpecs.join(', ')}`); specIssues.push(`重复:${dupSpecs.join(',')}`); totalIssues++; }
  if (specIssues.length) { console.log(`  ⚠ specs 问题: ${specIssues.join('; ')}`); totalIssues++; }

  // variants
  const varIssues = [];
  let zeroStock = 0;
  (p.variants || []).forEach((v, vi) => {
    if (v.stock === 0 || v.stock == null) zeroStock++;
    if (!v.spec) varIssues.push(`variant#${vi} 无spec`);
    if (v.price == null || v.price < 0) varIssues.push(`variant#${vi} 价格异常(${v.price})`);
  });
  console.log(`  variants (${(p.variants || []).length}):`);
  (p.variants || []).forEach((v, vi) => {
    console.log(`    #${vi + 1} spec="${v.spec}" price=${v.price} stock=${v.stock} sku=${v.sku}`);
  });
  if (zeroStock === (p.variants || []).length && (p.variants || []).length > 0) {
    console.log(`  ⚠ 所有 variant stock=0`); varIssues.push('全部stock=0'); totalIssues++;
  } else if (zeroStock > 0) {
    console.log(`  ⚠ ${zeroStock} 个 variant stock=0`); varIssues.push(`${zeroStock}个stock=0`); totalIssues++;
  }
  if (varIssues.length) { console.log(`  ⚠ variants 问题: ${varIssues.join('; ')}`); totalIssues++; }

  // description
  const desc = p.description || '';
  const isSynthetic = desc.startsWith('商品名称：');
  console.log(`  description (${desc.length}字, ${isSynthetic ? '合成' : '原始'}): ${desc.substring(0, 90).replace(/\n/g, ' | ')}${desc.length > 90 ? '...' : ''}`);
  if (desc.length < 20) { console.log(`  ⚠ description 过短`); totalIssues++; }

  // images
  console.log(`  images: ${(p.images || []).length} 张  category: ${p.category || '缺失'}`);
});

console.log(`\n${'='.repeat(80)}\n总计问题: ${totalIssues}`);
