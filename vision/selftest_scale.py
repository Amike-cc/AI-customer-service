"""
DPI 换算自检

验证 _capture_window 会按 scaleFactor 把 DIP 区域换算为物理像素。
不依赖真实窗口：用假 win32 模块替换截图调用，捕获传入 BitBlt 的坐标。

用法: vision\\venv\\Scripts\\python.exe vision\\selftest_scale.py
退出码: 0 通过 / 1 失败
"""
import os
import sys
import types

# 该脚本由 Node 集成测试启动，固定 UTF-8 输出以跨 Windows 活动代码页。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

captured = {}


class _FakeDC:
    def CreateCompatibleDC(self):
        return self

    def SelectObject(self, _bmp):
        return None

    def BitBlt(self, dest_xy, size, src_dc, src_xy, rop):
        captured['size'] = size
        captured['src_xy'] = src_xy
        return True

    def DeleteDC(self):
        return True


class _FakeBitmap:
    def CreateCompatibleBitmap(self, *_a):
        return None

    def GetInfo(self):
        return {'bmHeight': 10, 'bmWidth': 10}

    def GetBitmapBits(self, _flag):
        return bytes(10 * 10 * 4)

    def GetHandle(self):
        return 1


def _install_fake_win32():
    win32gui = types.ModuleType('win32gui')
    win32gui.IsWindow = lambda _h: True
    win32gui.GetClientRect = lambda _h: (0, 0, 800, 600)
    win32gui.GetDC = lambda _h: 1
    win32gui.DeleteObject = lambda _h: None
    win32gui.ReleaseDC = lambda *_a: None

    win32ui = types.ModuleType('win32ui')
    win32ui.CreateDCFromHandle = lambda _h: _FakeDC()
    win32ui.CreateBitmap = lambda: _FakeBitmap()

    win32con = types.ModuleType('win32con')
    win32con.SRCCOPY = 0x00CC0020

    sys.modules['win32gui'] = win32gui
    sys.modules['win32ui'] = win32ui
    sys.modules['win32con'] = win32con


def main() -> int:
    _install_fake_win32()
    from vision_service import VisionService

    service = VisionService({})
    region = {'x': 276, 'y': 60, 'width': 800, 'height': 700}

    cases = [
        (1.0, (276, 60), (800, 700)),
        (1.25, (345, 75), (1000, 875)),
        (1.5, (414, 90), (1200, 1050)),
    ]

    ok = True
    for factor, expect_src, expect_size in cases:
        captured.clear()
        service._capture_window('0x1', region, factor)
        actual_src = captured['src_xy']
        actual_size = captured['size']
        passed = actual_src == expect_src and actual_size == expect_size
        ok = ok and passed
        print(
            f'scaleFactor={factor}: src={actual_src} size={actual_size} '
            f'expected src={expect_src} size={expect_size} -> {"OK" if passed else "FAIL"}'
        )

    print('\nDPI 换算自检:', '通过' if ok else '失败')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
