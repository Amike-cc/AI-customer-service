"""Runtime-only compatibility shims for optional PaddleX dependencies.

PaddleX imports pandas and python-bidi at module import time even though the
full-window OCR path does not use either dependency. Windows Smart App Control
can block their native extension files, which prevents PaddleOCR from loading.

Keep the fallback strictly process-local and only install it after the real
module has failed to import. Normal Python environments continue to use the
real packages unchanged.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import sys
import types
from typing import Iterable


class _FallbackModule(types.ModuleType):
    """Small import-time stand-in for an optional module that cannot load."""

    __path__ = []

    def __getattr__(self, name: str):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        value = _FallbackModule(f"{self.__name__}.{name}")
        setattr(self, name, value)
        return value

    def __call__(self, *args, **kwargs):
        if len(args) == 1 and not kwargs:
            # python-bidi's get_display(text) is the only runtime call reached by
            # the OCR path. Identity is safe for the non-RTL languages supported
            # by this application.
            return args[0]
        return None


class _FallbackLoader(importlib.abc.Loader):
    def create_module(self, spec):
        module = _FallbackModule(spec.name)
        module.__spec__ = spec
        module.__loader__ = self
        return module

    def exec_module(self, module):
        return None


class _FallbackFinder(importlib.abc.MetaPathFinder):
    def __init__(self, prefixes: Iterable[str]):
        self.prefixes = tuple(prefixes)

    def find_spec(self, fullname, path=None, target=None):
        if any(
            fullname == prefix or fullname.startswith(f"{prefix}.")
            for prefix in self.prefixes
        ):
            is_package = fullname in self.prefixes
            return importlib.machinery.ModuleSpec(
                fullname,
                _FallbackLoader(),
                is_package=is_package,
            )
        return None


def _try_import(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except Exception:
        return False


def install_optional_dependency_fallbacks(
    names: Iterable[str] = ("pandas", "bidi"),
) -> list[str]:
    """Install fallbacks for optional modules that cannot be imported.

    Returns the names that were replaced. Existing successful modules and
    already-installed fallbacks are left untouched.
    """
    missing: list[str] = []
    for name in names:
        if name in sys.modules:
            module = sys.modules[name]
            if isinstance(module, _FallbackModule):
                continue
            continue
        if not _try_import(name):
            missing.append(name)

    if missing:
        sys.meta_path.insert(0, _FallbackFinder(missing))
        for name in missing:
            sys.modules.pop(name, None)
            # Force PaddleX's subsequent import to use the finder immediately.
            importlib.import_module(name)

    return missing
