const CDP = require('chrome-remote-interface');

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const renderer = targets.find((target) => target.title === '飞鸽AI客服' && target.type === 'page');
  if (!renderer) throw new Error('主窗口未找到');

  const client = await CDP({ target: renderer, port: 9222 });
  try {
    const response = await client.Runtime.evaluate({
      expression: `window.api.diagnose.run().then((result) => JSON.stringify({
        summary: {
          total: result.total,
          pass: result.pass,
          warn: result.warn,
          fail: result.fail,
        },
        models: result.results.filter((item) => item.category === 'models'),
      }))`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    console.log(response.result.value);

    const uiResponse = await client.Runtime.evaluate({
      expression: `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        if (!document.querySelector('#settings-tab-config')) {
          const settingsButton = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent?.includes('全局设置'));
          if (!settingsButton) throw new Error('未找到全局设置入口');
          settingsButton.click();
          await sleep(1000);
        }
        const configTab = document.querySelector('#settings-tab-config');
        if (!configTab) throw new Error('未找到系统配置页签');
        configTab.click();
        await sleep(1000);
        const runButton = Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent?.trim() === '运行诊断');
        if (!runButton) throw new Error('未找到运行诊断按钮');
        runButton.click();
        for (let index = 0; index < 60; index += 1) {
          await sleep(100);
          if (document.body.innerText.includes('PP-OCRv6_medium_rec')) break;
        }
        const text = document.body.innerText;
        return JSON.stringify({
          categoryVisible: text.includes('模型文件'),
          paddleDetVisible: text.includes('PP-OCRv6_medium_det'),
          paddleRecVisible: text.includes('PP-OCRv6_medium_rec'),
          orientationVisible: text.includes('PP-LCNet_x1_0_doc_ori'),
          unwarpingVisible: text.includes('UVDoc'),
          dictionaryRemoved: !text.includes('OCR 电商词典'),
          yoloRemoved: !text.includes('YOLO 模型'),
        });
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (uiResponse.exceptionDetails) {
      throw new Error(uiResponse.exceptionDetails.exception?.description || uiResponse.exceptionDetails.text);
    }
    console.log(uiResponse.result.value);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
