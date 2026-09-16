"""
视觉服务自检脚本

在不依赖真实店铺窗口的前提下验证视觉链路可用：生成合成聊天截图
（买家消息靠左、卖家消息靠右），调用 VisionService 的识别方法，
断言 OCR 能真正识别出文本并完成左右分类。

这比协议握手测试更能发现问题：VISION_PROTOCOL_TEST 路径返回预制空响应，
完全不经过 OCR，曾因此漏掉"结果解析与 PaddleOCR 3.x 不兼容"的缺陷。

用法:
    vision\\venv\\Scripts\\python.exe vision\\selfcheck.py [--json]

退出码: 0 通过 / 1 失败
"""
import argparse
import asyncio
import json
import os
import sys

import numpy as np

# Electron/Node 在 Windows 下按 UTF-8 读取自检结果；显式设置 Python
# 标准流编码，避免系统活动代码页（通常为 CP936）把中文 OCR 结果写成乱码。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from vision_service import VisionService  # noqa: E402

# 合成图中应当被识别出的文本（与 build_sample_image 绘制内容一致，忽略标点）
EXPECTED_BUYER_TEXT = '你好'      # 买家消息：左侧
EXPECTED_BUYER_TEXT_2 = '快递'    # 买家消息：左侧
EXPECTED_SELLER_TEXT = '明天发出'  # 卖家消息：右侧


def _load_font(size: int = 34):
    for candidate in (
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
    ):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:  # noqa: BLE001
                continue
    return None


def build_sample_image() -> np.ndarray:
    """生成 900x500 的合成聊天截图：买家消息在左，卖家消息在右。"""
    img = Image.new('RGB', (900, 500), 'white')
    draw = ImageDraw.Draw(img)
    font = _load_font()
    draw.text((40, 60), '你好，请问这款有货吗？', fill='black', font=font)
    draw.text((40, 160), '发什么快递？', fill='black', font=font)
    # 右侧 > 60% 宽度，应被判为卖家
    draw.text((620, 300), '亲，明天发出', fill='black', font=font)
    return np.array(img)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true', help='以 JSON 输出结果')
    args = parser.parse_args()

    service = VisionService({'ocr_lang': 'ch', 'ocr_use_angle_cls': False, 'ocr_enable_mkldnn': False})
    if not args.json:
        print('loading PaddleOCR engine ...', file=sys.stderr)
    await service.load_models()

    image = build_sample_image()
    messages, controls = service._full_window_ocr(image, {})

    texts = [m['text'] for m in messages]
    buyers = [m['text'] for m in messages if m['isBuyer']]
    sellers = [m['text'] for m in messages if not m['isBuyer']]

    def has_fragment(haystack, needle):
        # OCR 可能省略标点，做去标点的包含判断
        return any(needle in h.replace('，', '').replace('？', '').replace('。', '') for h in haystack)

    ok = (
        has_fragment(buyers, EXPECTED_BUYER_TEXT)
        and has_fragment(buyers, EXPECTED_BUYER_TEXT_2)
        and has_fragment(sellers, EXPECTED_SELLER_TEXT)
    )

    result = {
        'ok': ok,
        'allTexts': texts,
        'buyerTexts': buyers,
        'sellerTexts': sellers,
        'inputBox': controls.get('inputBox'),
        'sendButton': controls.get('sendButton'),
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print('=== OCR 识别结果 ===')
        for m in messages:
            side = '买家' if m['isBuyer'] else '卖家'
            print(f"  [{side}] {m['text']}  (conf={m['confidence']:.2f})")
        print('\n=== 控件兜底定位 ===')
        print('  inputBox  :', controls.get('inputBox'))
        print('  sendButton:', controls.get('sendButton'))
        print('\n自检结论:', '通过' if ok else '失败（未识别出预期的买家/卖家文本）')

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
