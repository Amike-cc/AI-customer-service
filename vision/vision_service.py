"""
飞鸽AI客服视觉服务
详见 docs/技术选型决策记录.md §5.2

通信协议：stdin/stdout 行分隔 JSON
启动方式：python vision_service.py

使用 PaddleOCR 全图识别，并通过位置启发式区分买家消息和界面控件。
"""

import sys
import json
import time
import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

# PaddlePaddle 3.x + PP-OCRv5/v6 + OneDNN 推理后端不兼容：
# 抛出 NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>]
# (at paddle/fluid/framework/new_executor/instruction/onednn/onednn_instruction.cc:118)
#
# 注意：仅设置 FLAGS_use_mkldnn 环境变量对 PIR 执行器无效，必须同时向 PaddleOCR
# 显式传入 enable_mkldnn=False（见 load_models）。环境变量作为额外兜底保留。
# 参考: https://github.com/PaddlePaddle/Paddle/issues/61287
os.environ['FLAGS_use_mkldnn'] = '0'
os.environ['FLAGS_use_onednn'] = '0'
os.environ['FLAGS_use_mkldnn_bf16'] = '0'

import cv2
import numpy as np

from runtime_compat import install_optional_dependency_fallbacks

# 日志输出到 stderr，避免污染 stdout 通信
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
logger = logging.getLogger('vision')


class VisionService:
    """视觉识别服务，单实例多店铺共享"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.ocr_engine = None
        self._last_timing: Dict[str, int] = {}

    async def load_models(self) -> None:
        """加载 PaddleOCR 模型"""
        logger.info('loading PaddleOCR engine')
        fallbacks = install_optional_dependency_fallbacks(('pandas', 'bidi'))
        if fallbacks:
            logger.warning(
                'optional OCR dependencies unavailable; installed process-local fallback: %s',
                ', '.join(fallbacks),
            )
        from paddleocr import PaddleOCR
        ocr_kwargs = {
            'use_textline_orientation': self.config.get('ocr_use_angle_cls', False),
            'lang': self.config.get('ocr_lang', 'ch'),
            # 必须显式关闭 MKLDNN/OneDNN：PaddlePaddle 3.x 的 PIR 执行器在 OneDNN
            # 后端下会抛 NotImplementedError，且环境变量兜底不生效（见文件头注释）
            'enable_mkldnn': bool(self.config.get('ocr_enable_mkldnn', False)),
        }
        self.ocr_engine = PaddleOCR(**ocr_kwargs)
        logger.info('PaddleOCR engine loaded')
        logger.info('vision service ready, mode: full-window OCR')

    async def handle_request(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """处理来自 Node 主进程的识别请求"""
        req_id = req.get('requestId', '')
        try:
            import time
            t0 = time.time()

            # 1. 窗口截图（captureRegion 为 DIP，需按 scaleFactor 换算到物理像素）
            img = self._capture_window(
                req['windowHandle'],
                req.get('captureRegion'),
                req.get('scaleFactor', 1.0),
            )
            t1 = time.time()

            # 2. 预处理
            preprocessed = self._preprocess(img)
            t2 = time.time()

            # 3. 全图 OCR + 位置分类
            messages, controls = self._full_window_ocr(preprocessed, req)
            t3 = time.time()
            detections = {
                'inputBox': controls.get('inputBox'),
                'sendButton': controls.get('sendButton'),
            }
            t4 = time.time()

            self._last_timing = {
                'capture': int((t1 - t0) * 1000),
                'preprocess': int((t2 - t1) * 1000),
                'detect': int((t3 - t2) * 1000),
                'ocr': int((t4 - t3) * 1000),
                'total': int((t4 - t0) * 1000),
            }

            return {
                'requestId': req_id,
                'status': 'ok',
                'data': {
                    'messages': messages,
                    'inputBox': detections.get('inputBox'),
                    'sendButton': detections.get('sendButton'),
                },
                'timingMs': self._last_timing,
            }
        except Exception as e:
            logger.exception('handle_request failed')
            return {
                'requestId': req_id,
                'status': 'error',
                'error': str(e),
            }

    def _capture_window(self, handle: str, region: Optional[Dict], scale_factor: float = 1.0) -> np.ndarray:
        """通过 Win32 API 截取窗口。

        region 来自 Electron 的 getBounds()，单位是 DIP；BitBlt 使用物理像素。
        在 125%/150% 缩放的显示器上必须按 scale_factor 换算，否则截取区域错位。
        """
        import win32gui
        import win32ui
        import win32con

        hwnd = int(handle, 16) if isinstance(handle, str) else handle
        if not win32gui.IsWindow(hwnd):
            raise ValueError(f'invalid window handle: {handle}')

        # 获取窗口客户区大小
        left, top, right, bottom = win32gui.GetClientRect(hwnd)
        width = right - left
        height = bottom - top

        if region:
            factor = float(scale_factor) if scale_factor and scale_factor > 0 else 1.0
            left = int(round(region.get('x', 0) * factor))
            top = int(round(region.get('y', 0) * factor))
            width = int(round(region.get('width', width) * factor))
            height = int(round(region.get('height', height) * factor))

        # BitBlt 截图
        hwnd_dc = win32gui.GetDC(hwnd)
        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
        save_dc = mfc_dc.CreateCompatibleDC()

        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(mfc_dc, width, height)
        save_dc.SelectObject(bmp)

        save_dc.BitBlt((0, 0), (width, height), mfc_dc, (left, top), win32con.SRCCOPY)

        bmp_info = bmp.GetInfo()
        bmp_bits = bmp.GetBitmapBits(True)
        img = np.frombuffer(bmp_bits, dtype=np.uint8)
        img = img.reshape(bmp_info['bmHeight'], bmp_info['bmWidth'], 4)
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

        # 释放资源
        win32gui.DeleteObject(bmp.GetHandle())
        save_dc.DeleteDC()
        mfc_dc.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwnd_dc)

        return img

    def _preprocess(self, img: np.ndarray) -> np.ndarray:
        """图像预处理：降噪"""
        denoised = cv2.GaussianBlur(img, (3, 3), 0)
        return denoised

    @staticmethod
    def _poly_to_bbox(poly) -> List[float]:
        """四点多边形 → [x1, y1, x2, y2]"""
        xs = [float(p[0]) for p in poly]
        ys = [float(p[1]) for p in poly]
        return [min(xs), min(ys), max(xs), max(ys)]

    def _normalize_ocr_items(self, result) -> List[Dict]:
        """
        把 PaddleOCR 的返回结果统一成 [{'bbox','text','confidence'}]。

        必须同时支持两种格式，否则识别结果会被静默误读：
          - 2.x 列表格式：[[bbox, (text, conf)], ...]
          - 3.x OCRResult（dict-like）：{'rec_texts', 'rec_scores', 'rec_polys'/'rec_boxes'}

        3.x 的 OCRResult 是可迭代的映射对象；若按 2.x 方式 line[1][0] 取值，
        实际取到的是字典键字符串的字符（曾导致识别结果变成 ['n','a','o','t','o']）。
        """
        items: List[Dict] = []
        if not result:
            return items

        page = result[0] if isinstance(result, (list, tuple)) and len(result) > 0 else result
        if page is None:
            return items

        # --- PaddleOCR 3.x：OCRResult / dict ---
        if isinstance(page, dict) or hasattr(page, 'get'):
            def _get(key):
                try:
                    return page.get(key)
                except Exception:  # noqa: BLE001
                    return None

            texts = _get('rec_texts') or []
            scores = _get('rec_scores') or []
            polys = _get('rec_polys') or _get('dt_polys')
            boxes = _get('rec_boxes')
            for idx, raw_text in enumerate(texts):
                text = raw_text if isinstance(raw_text, str) else str(raw_text)
                conf = float(scores[idx]) if idx < len(scores) else 0.0
                bbox = None
                if polys is not None and idx < len(polys):
                    bbox = self._poly_to_bbox(polys[idx])
                elif boxes is not None and idx < len(boxes):
                    bbox = [float(v) for v in boxes[idx][:4]]
                if bbox is None:
                    bbox = [0.0, 0.0, 0.0, 0.0]
                items.append({'bbox': bbox, 'text': text, 'confidence': conf})
            return items

        # --- PaddleOCR 2.x：列表格式 ---
        for line in page:
            try:
                if not line or len(line) < 2:
                    continue
                items.append({
                    'bbox': self._poly_to_bbox(line[0]),
                    'text': line[1][0],
                    'confidence': float(line[1][1]),
                })
            except Exception:  # noqa: BLE001
                continue
        return items

    def _full_window_ocr(self, img: np.ndarray, req: Dict) -> tuple:
        """
        全图 OCR + 位置启发式分类
        飞鸽 UI 布局：买家消息在左侧，卖家消息在右侧
        返回 (messages, controls)
        """
        h, w = img.shape[:2]
        # PaddleOCR 3.x：ocr() 已 @deprecated 转发到 predict()，但 predict() 不接受 cls 参数
        # 且 use_textline_orientation 已在初始化时设为 False（等价于旧 cls=False），
        # 这里直接调用 predict() 避免每次报警告并触发 TypeError
        result = self.ocr_engine.predict(img)
        ocr_items = self._normalize_ocr_items(result)

        messages = []
        controls = {
            'inputBox': req.get('controls', {}).get('inputBox'),
            'sendButton': req.get('controls', {}).get('sendButton'),
        }

        if not ocr_items:
            # 即使无 OCR 结果，也尝试兜底控件定位
            if not controls.get('inputBox') or not controls.get('sendButton'):
                detected = self._heuristic_controls([], w, h)
                if not controls.get('inputBox'):
                    controls['inputBox'] = detected.get('inputBox')
                if not controls.get('sendButton'):
                    controls['sendButton'] = detected.get('sendButton')
            return messages, controls

        for item in ocr_items:
            text = self._clean_text(item['text'])
            if not text or len(text) < 2:
                continue

            bbox_list = item['bbox']
            cx = (bbox_list[0] + bbox_list[2]) / 2

            # 启发式分类：左侧 60% 区域视为买家消息
            is_buyer = cx < w * 0.6

            # 过滤非消息文本（输入框提示、按钮文字等）
            if self._is_control_text(text, controls, bbox_list):
                continue

            messages.append({
                'bbox': bbox_list,
                'text': text,
                'confidence': item['confidence'],
                'isBuyer': is_buyer,
                'timestamp': int(time.time() * 1000),
            })

        # 控件检测：优先使用请求参数，否则启发式检测
        if not controls.get('inputBox') or not controls.get('sendButton'):
            detected = self._heuristic_controls(ocr_items, w, h)
            if not controls.get('inputBox'):
                controls['inputBox'] = detected.get('inputBox')
            if not controls.get('sendButton'):
                controls['sendButton'] = detected.get('sendButton')

        # 按下排序（最下方为最新）
        messages.sort(key=lambda m: m['bbox'][1], reverse=True)
        return messages, controls

    def _heuristic_controls(self, ocr_items: List[Dict], w: int, h: int) -> Dict:
        """启发式定位输入框和发送按钮（Electron UIAutomation 不可用时使用）。

        ocr_items 必须是 _normalize_ocr_items 归一化后的 [{'bbox','text','confidence'}]。
        """
        input_box = None
        send_button = None

        input_hints = ['请输入', '输入消息', '说点什么', '回复']
        send_hints = ['发送', 'send', 'Send']

        for item in ocr_items:
            bbox_list = item['bbox']
            text = item['text']
            cx = (bbox_list[0] + bbox_list[2]) / 2
            cy = (bbox_list[1] + bbox_list[3]) / 2

            # 发送按钮：右下角，文本短
            if not send_button:
                for hint in send_hints:
                    if hint in text and len(text) <= 6:
                        if cx > w * 0.7 and cy > h * 0.8:
                            send_button = {'bbox': bbox_list, 'confidence': 0.8}
                            break

            # 输入框：底部，含占位符文字
            if not input_box:
                for hint in input_hints:
                    if hint in text and len(text) <= 20:
                        if cy > h * 0.75:
                            input_box = {
                                'bbox': [int(w * 0.2), int(bbox_list[1]), int(w * 0.95), int(bbox_list[3])],
                                'confidence': 0.7,
                            }
                            break

        # 兜底：默认位置（底部中央）
        if not input_box:
            input_box = {
                'bbox': [int(w * 0.25), int(h * 0.88), int(w * 0.9), int(h * 0.95)],
                'confidence': 0.5,
            }
        if not send_button:
            send_button = {
                'bbox': [int(w * 0.9), int(h * 0.88), int(w * 0.98), int(h * 0.95)],
                'confidence': 0.5,
            }

        return {'inputBox': input_box, 'sendButton': send_button}

    def _is_control_text(self, text: str, controls: Dict, bbox: List[float]) -> bool:
        """判断文本是否属于控件（输入框占位符、按钮文字等）"""
        # 如果控件位置已知，检查 bbox 是否在控件区域内
        for ctrl_key in ('inputBox', 'sendButton'):
            ctrl = controls.get(ctrl_key)
            if ctrl and 'bbox' in ctrl:
                cx1, cy1, cx2, cy2 = ctrl['bbox']
                bx1, by1, bx2, by2 = bbox
                # 如果 bbox 在控件区域内，跳过
                if bx1 >= cx1 and by1 >= cy1 and bx2 <= cx2 and by2 <= cy2:
                    return True

        # 过滤常见控件提示文字
        control_hints = ['发送', '回车', 'Enter', '表情', '图片', '快捷', '转人工', '请输入']
        for hint in control_hints:
            if hint in text and len(text) <= 10:
                return True

        return False

    def _extract_text(self, result) -> str:
        """从 PaddleOCR 结果中提取纯文本（兼容 2.x/3.x 返回格式）"""
        return '\n'.join(item['text'] for item in self._normalize_ocr_items(result))

    def _clean_text(self, raw: str) -> str:
        """文本清洗：去空行、折叠空格、去末尾时间戳"""
        import re
        lines = [l.strip() for l in raw.split('\n') if l.strip()]
        text = ''.join(lines)
        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'[\d:\s]+$', '', text)
        return text.strip()


async def main():
    """主循环：从 stdin 读取请求，向 stdout 写入响应"""
    if os.environ.get('VISION_PROTOCOL_TEST') == '1':
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            req = json.loads(line)
            response = {
                'requestId': req.get('requestId', ''),
                'status': 'ok',
                'data': {'messages': [], 'inputBox': None, 'sendButton': None},
                'timingMs': {'capture': 0, 'preprocess': 0, 'detect': 0, 'ocr': 0, 'total': 0},
            }
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()

    config = {
        'ocr_lang': 'ch',
        'ocr_use_angle_cls': False,
        'ocr_use_gpu': False,
    }

    service = VisionService(config)
    await service.load_models()

    logger.info('vision service ready, waiting for requests...')

    # 使用线程池读取 stdin，避免 Windows ProactorEventLoop 管道 bug（WinError 6）
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            logger.info('stdin closed, exiting')
            break

        try:
            req = json.loads(line)
            resp = await service.handle_request(req)
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + '\n')
            sys.stdout.flush()
        except json.JSONDecodeError as e:
            logger.error('invalid JSON: %s', e)
        except Exception as e:
            logger.exception('unexpected error')


if __name__ == '__main__':
    asyncio.run(main())
