const CDP = require('chrome-remote-interface');

async function main() {
  const shopId = process.argv[2];
  if (!shopId) throw new Error('用法: node scripts/test/diagnose-product-list.cjs <shopId>');

  const targets = await CDP.List({ port: 9222 });
  const target = targets.find((item) => item.type === 'page' && item.title === '飞鸽AI客服');
  if (!target) throw new Error('未找到飞鸽AI客服渲染页面');

  const client = await CDP({ target });
  try {
    const response = await client.Runtime.evaluate({
      expression: `window.api.product.diagnoseListPage(${JSON.stringify(shopId)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    const result = response.result.value;
    if (!result?.ok) throw new Error(result?.error || '诊断失败');

    const data = JSON.parse(result.data);
    const productApiUrls = (data.apiRequests || [])
      .map((item) => item.url || item)
      .filter((url) => /product|goods|list|spu|item/i.test(url));
    console.log(JSON.stringify({
      url: data.url,
      title: data.title,
      isLoginPage: data.isLoginPage,
      bodyTextLen: data.bodyTextLen,
      bodyTextSnippet: data.bodyTextSnippet,
      tables: data.tables,
      potentialSelectors: data.potentialSelectors,
      apiRequestCount: data.apiRequestCount,
      productApiUrls: productApiUrls.slice(0, 50),
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
