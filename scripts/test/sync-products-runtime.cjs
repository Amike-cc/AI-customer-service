const CDP = require('chrome-remote-interface');

function summarize(products) {
  return {
    count: products.length,
    active: products.filter((product) => product.active).length,
    inactive: products.filter((product) => !product.active).length,
    missingDescription: products.filter((product) => !product.description).length,
    missingCategory: products.filter((product) => !product.category).length,
    missingImages: products.filter((product) => !Array.isArray(product.images) || product.images.length === 0).length,
    missingSpecs: products.filter((product) => !Array.isArray(product.specs) || product.specs.length === 0).length,
    missingAttrs: products.filter((product) => !Array.isArray(product.attrs) || product.attrs.length === 0).length,
    missingVariants: products.filter((product) => !Array.isArray(product.variants) || product.variants.length === 0).length,
  };
}

async function evaluate(client, expression) {
  const response = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function main() {
  const shopId = process.argv[2];
  if (!shopId) throw new Error('用法: node scripts/test/sync-products-runtime.cjs <shopId>');

  const targets = await CDP.List({ port: 9222 });
  const target = targets.find((item) => item.type === 'page' && item.title === '飞鸽AI客服');
  if (!target) throw new Error('未找到飞鸽AI客服渲染页面');

  const client = await CDP({ target });
  try {
    const shops = await evaluate(client, 'window.api.shop.list()');
    const shop = shops.find((item) => item.shopId === shopId);
    if (!shop) throw new Error(`店铺不存在: ${shopId}`);
    if (shop.loginStatus !== 'logged_in') throw new Error(`店铺尚未登录: ${shop.loginStatus}`);

    const before = await evaluate(client, `window.api.product.list(${JSON.stringify(shopId)})`);
    console.log('同步前:', JSON.stringify(summarize(before)));
    console.log(`开始同步 ${shop.platform} / ${shop.shopName} ...`);
    const result = await evaluate(client, `window.api.product.sync(${JSON.stringify(shopId)})`);
    console.log('同步结果:', JSON.stringify(result));
    const after = await evaluate(client, `window.api.product.list(${JSON.stringify(shopId)})`);
    console.log('同步后:', JSON.stringify(summarize(after)));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
