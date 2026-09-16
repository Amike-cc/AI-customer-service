// 验证快手当前状态：聊天视图、URL、会话列表、激活会话
const CDP = require('chrome-remote-interface');

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const ksTarget = targets.find(t => t.url && t.url.includes('kwaixiaodian'));
  if (!ksTarget) {
    console.log('未找到快手 target');
    return;
  }

  const client = await CDP({ target: ksTarget, port: 9222 });
  const { Runtime } = client;

  const script = `
  (function() {
    var result = {
      url: location.href,
      title: document.title,
      // 检查所有可能的会话项元素
      sessionBaseCards: [],
      sessionStarCards: [],
      sessionListGroupItems: [],
      // 检查右侧聊天视图状态
      chatView: {
        textareas: 0,
        visibleTextareas: 0,
        messages: 0,
        lastMessageText: '',
        lastMessageClass: ''
      },
      // 检查激活的会话
      activeSession: null,
      // 检查 __feigeScannerProcessed 状态
      scannerState: {
        scanIndex: window.__feigeScanIndex,
        observerInstalled: window.__feigeObserverInstalled,
        msgQueueLength: window.__feigeMsgQueue ? window.__feigeMsgQueue.length : -1,
        seenMessages: window.__feigeSeenMessages ? window.__feigeSeenMessages.size : -1,
        suppressUntil: window.__feigeSuppressUntil,
        now: Date.now()
      }
    };

    // 1. SessionBaseCard 元素
    var sbc = document.querySelectorAll('.SessionBaseCard, [class*="SessionBaseCard"]');
    for (var i = 0; i < sbc.length && i < 5; i++) {
      var el = sbc[i];
      result.sessionBaseCards.push({
        cls: (el.className || '').toString(),
        rect: el.getBoundingClientRect(),
        text: (el.innerText || '').trim().slice(0, 100),
        hasColorHighLight: /colorHighLight/.test(el.className || ''),
        hasColorLowLight: /colorLowLight/.test(el.className || ''),
        hasActive: /\\bactive\\b/i.test(el.className || '')
      });
    }

    // 2. SessionStarCard 元素
    var ssc = document.querySelectorAll('.SessionStarCard');
    result.sessionStarCards.length = ssc.length;
    for (var j = 0; j < ssc.length && j < 3; j++) {
      result.sessionStarCards.push({
        cls: (ssc[j].className || '').toString(),
        childrenCount: ssc[j].children.length,
        text: (ssc[j].innerText || '').trim().slice(0, 100)
      });
    }

    // 3. SessionListGroupItem 元素（分组标题，非会话项）
    var slgi = document.querySelectorAll('.SessionListGroupItem');
    result.sessionListGroupItems.length = slgi.length;
    for (var k = 0; k < slgi.length && k < 10; k++) {
      result.sessionListGroupItems.push({
        cls: (slgi[k].className || '').toString(),
        text: (slgi[k].innerText || '').trim().slice(0, 60),
        // 是否有子元素（实际会话卡片）
        hasChildren: slgi[k].children.length > 1
      });
    }

    // 4. 聊天视图状态
    var textareas = document.querySelectorAll('textarea');
    result.chatView.textareas = textareas.length;
    for (var t = 0; t < textareas.length; t++) {
      var r = textareas[t].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        result.chatView.visibleTextareas++;
      }
    }

    // 5. 检查右侧聊天区域
    var chatArea = document.querySelector('[class*="LayoutDefaultWrapper"], [class*="chat-view"], [class*="ChatView"], [class*="message-list"], [class*="ChatMainContent"]');
    if (chatArea) {
      // 查找所有消息
      var msgSelectors = [
        '[class*="LayoutDefaultWrapper_msgBody"]',
        '[class*="LayoutDefaultWrapper"]',
        '[class*="__isMine"]',
        '[class*="__notMe"]'
      ];
      var allMsgs = [];
      for (var m = 0; m < msgSelectors.length; m++) {
        var msgs = chatArea.querySelectorAll(msgSelectors[m]);
        if (msgs.length > 0) {
          allMsgs = Array.from(msgs);
          break;
        }
      }
      result.chatView.messages = allMsgs.length;
      if (allMsgs.length > 0) {
        var last = allMsgs[allMsgs.length - 1];
        result.chatView.lastMessageText = (last.innerText || '').trim().slice(0, 100);
        // 检查祖先类
        var p = last;
        var ancestorCls = '';
        for (var a = 0; a < 6 && p; a++) {
          ancestorCls += ' | ' + ((p.className || '').toString().slice(0, 80));
          p = p.parentElement;
        }
        result.chatView.lastMessageClass = ancestorCls;
      }
    }

    return JSON.stringify(result, null, 2);
  })()
  `;

  const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
  console.log('=== 快手状态验证 ===');
  console.log(result.value);

  await client.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
