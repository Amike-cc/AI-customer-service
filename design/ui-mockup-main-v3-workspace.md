# 主工作台 UI 设计稿 V3

设计日期：2026-09-15  
生成方式：内置 image_gen 图像生成工具  
图片尺寸：1586 × 992  
设计图：[ui-mockup-main-v3-workspace.png](ui-mockup-main-v3-workspace.png)

本稿基于综合开发文档重新设计，展示数据均为示例，不代表当前软件运行状态或功能完成证明。

## 设计变化

- 深色窄导航与浅色店铺/会话列表组合成左侧区域，四个平台固定为拼多多、抖店、快手小店、微信小店。
- 左侧先选店铺，再选会话；未读数、在线状态和当前选择分开显示。
- 中间提供统一工作台/平台原页切换，增加消息区宽度，底部集中快捷回复、知识库、商品、订单和发送工具。
- 右侧集中 AI 自动回复开关、运行状态、人工接管、当前商品、订单摘要、转接记录、回复质量和测试/审计入口。
- AI 接待状态使用绿色，人工接管使用琥珀色，发送与选中状态使用蓝色；人工接管只保留一个主入口。
- 上一版 V2 保留为历史设计资产。V3 是新的视觉参考，不能据此宣称相关业务代码已经完成。

## 布局实现参考

按窗口内容宽度计算，组合左侧区域约占 24%，中央约占 51%，右侧约占 25%。左侧区域内部拆为窄导航和店铺/会话列表。具体 DIP 和响应式断点仍需按综合开发文档适配；React 与 WebContentsView 必须共享计算后的边界。新稿没有改变内部平台 ID。

## 完整生成提示词

以下为本稿实际使用的完整提示词。

Use case: ui-mockup.
Asset type: one high-fidelity Windows desktop application screenshot, a new redesign for the existing Chinese e-commerce AI customer service product "飞鸽 AI 客服".
Primary request: Create a polished, practical, carefully typeset Chinese customer-support workbench design image with clearly improved usability. Landscape 16:10 approximately 1920x1200. Full-bleed front-on UI screenshot, crisp vector-like geometry and typography, no device mockup or perspective. One single screen, not a collage.
Visual style: clean professional light workspace, restrained deep navy navigation, bright cobalt primary buttons, cool gray dividers, white panels, dark slate text, pale blue selection, amber manual takeover action, green online dots. Consistent 8-pixel spacing system, 10-pixel corner radii, subtle shadows only. Prioritize Chinese text legibility with Microsoft YaHei-like typography, generous spacing, and functional information hierarchy. Avoid gradients, neon glows, ornamental blobs, giant dashboard tiles.
Layout: three main working regions. A combined left navigation and store/session sidebar occupying roughly 23%, a large central chat workspace 51%, and a right operational context panel 26%. Slim global top bar and slim bottom status bar. In the left region, a narrow dark vertical icon rail about 70px wide with small clearly legible labels: "工作台" (selected), "店铺", "会话", "商品", "知识库", "质量", "诊断"; settings and avatar at bottom. Beside the rail, a white store and conversation list.
Top global bar: small bird mark and brand text "飞鸽 AI 客服", page title "工作台", spacious search field "搜索会话、商品或订单" with "Ctrl K" hint. On right a small green "4 家店铺在线", bell icon with badge 3, settings icon, then standard Windows minimize/maximize/close controls.
Left sidebar: title "我的店铺" with count 4 and add icon. Show EXACTLY the four supported platform labels, prominently and correctly rendered as "拼多多", "抖店", "快手小店", "微信小店". No other platform labels. Four store rows with color-coded simple platform icons:
1 selected pale-blue row "柚子家居旗舰店", small red "拼多多" badge, green online dot, unread 3.
2 "春风家居", dark "抖店" badge, green online dot.
3 "山茶美妆", orange "快手小店" badge, green online dot, unread 2.
4 "绿野生活馆", green "微信小店" badge, green online dot.
Below stores a divider, heading "当前店铺会话", tabs "全部" "未读 3" "人工", and 3 compact conversation rows with avatars and times. Selected "林女士" preview "还有其他颜色吗？"; other rows "陈先生" preview "想了解发货时间" and "周女士" preview "好的，谢谢". This list stays fully inside the left sidebar. Avoid placing an additional full-width fourth column.
Center: header "林女士", secondary line "柚子家居旗舰店 · 拼多多". A small green pill "AI 接待中". Small header buttons "订单" and "用户资料", more icon. Beneath, a subtle mode segmented control "统一工作台" selected and "平台原页" inactive.
Large spacious chronological chat timeline with readable short Chinese messages, buyer avatar on left and AI marker on right. Text should be verbatim:
buyer at 10:24: "这款枕头适合侧睡吗？"
AI at 10:25 in pale blue bubble: "这款云朵枕软硬适中，适合侧睡。您可以根据习惯选择高度。"
buyer at 10:26: "还有其他颜色吗？多久发货？"
AI at 10:27: "有白色、浅灰色和雾蓝色。现货预计 48 小时内发出。"
Below AI reply add tiny neutral source chips "商品资料" "发货政策" and discreet "已发送". Do not add unverified "已读" labels. No long paragraphs or huge blank chat gaps.
At bottom of center, a spacious functional composer separated by a thin border. Tab-like tools "快捷回复" "知识库" "商品" "订单". Placeholder "输入回复内容…" and small counter "0 / 800". Bottom toolbar has emoji, image, attachment icons. Small shortcut text "Ctrl + Enter 发送". One saturated cobalt "发送" button with paper-plane icon. Do not duplicate the manual takeover button here.
Right panel: concise vertically stacked context sections, all text readable, modest headings and clear alignment.
First card "接待控制": label "AI 自动回复" with ON switch, green health indicator "运行正常", short line "当前店铺由 AI 接待", then a full-width amber-outlined prominent button "人工接管".
Second card "当前商品": small realistic white pillow thumbnail, "轻柔云朵枕", price "¥89.00", tags "库存充足" and "匹配 98%", understated "查看商品" link.
Third card "订单摘要": "待发货" amber pill, line "轻柔云朵枕 × 1", "实付 ¥89.00", and "查看平台订单" link. No refund/payment/write-operation buttons.
Fourth card "转接记录": two slim timeline rows "10:16 人工 → AI" / "问题已解决", "10:12 AI → 人工" / "买家要求人工".
Fifth compact card "回复质量" with "92 / 100", tiny "近 7 天 · 128 条样本" and understated mini sparkline, not a factual accuracy claim.
At bottom right two small secondary actions "测试回复" and "审计日志".
Footer: green dot "连接正常", current store "拼多多 · 柚子家居旗舰店", and very subtle "界面设计稿 · 示例数据".
Constraints: render all four platform labels accurately and exactly once as prominent store badges; no 淘宝, no 京东, no 抖音 platform labels. Keep product title "飞鸽 AI 客服". No programming code, no engineering annotations, no photographic laptop, no floating mockup panels, no external watermark. Ensure no clipped elements, no overlap, all regions completely visible. The output must feel like a professionally designed usable Chinese desktop customer-support app, with a calm precise layout and a much larger chat area than the supporting cards.
