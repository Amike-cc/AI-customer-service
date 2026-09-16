const CDP = require('chrome-remote-interface');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

(async () => {
  const target = (await getTargets()).find((item) => item.type === 'page' && item.url.includes('jinritemai'));
  if (!target) throw new Error('未找到抖店页面');
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: `Array.from(document.querySelectorAll('.auxo-dropdown-trigger')).map((item, index) => {
      const rect = item.getBoundingClientRect();
      const badges = Array.from(item.querySelectorAll('[class*="badge"], [class*="unread"], [class*="count"]')).map((node) => ({
        cls: String(node.className || ''), text: (node.innerText || node.textContent || '').trim().slice(0, 80),
      }));
      const firstText = item.querySelector('span, div');
      return {
        index,
        text: (item.innerText || '').trim().slice(0, 180),
        cls: String(item.className || ''),
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
        badges,
        firstFontWeight: firstText ? getComputedStyle(firstText).fontWeight : '',
      };
    }).filter((item) => item.w > 0 && item.h > 0)`,
    returnByValue: true,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  await client.close();
})().catch((error) => { console.error(error); process.exit(1); });
