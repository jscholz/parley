"""register(ctx) must declare cron_deliver_env_var so hermes ≥ 0.21 accepts
``deliver=parley:<chat>`` cron targets — and must still register on older
hermes that rejects the kwarg (2026-09-05: Press Radar jobs blocked as
"not a known cron delivery target" after the 0.21 upgrade)."""
from __future__ import annotations

import importlib


def _plugin():
    return importlib.import_module(__package__.rsplit(".", 1)[0])


class _Ctx:
    def __init__(self, reject_cron_kwarg: bool = False):
        self.reject = reject_cron_kwarg
        self.calls: list[dict] = []
        self.hooks: list[str] = []

    def register_platform(self, **kw):
        self.calls.append(kw)
        if self.reject and "cron_deliver_env_var" in kw:
            raise TypeError("__init__() got an unexpected keyword argument 'cron_deliver_env_var'")
        return object()

    def register_hook(self, name, fn):
        self.hooks.append(name)


def test_register_declares_cron_deliver_env_var():
    ctx = _Ctx()
    _plugin().register(ctx)
    assert len(ctx.calls) == 1
    kw = ctx.calls[0]
    assert kw["name"] == "parley"
    assert kw["cron_deliver_env_var"] == "PARLEY_HOME_CHANNEL"


def test_register_falls_back_when_hermes_rejects_the_kwarg():
    ctx = _Ctx(reject_cron_kwarg=True)
    _plugin().register(ctx)
    assert len(ctx.calls) == 2, "must retry without the kwarg"
    assert "cron_deliver_env_var" in ctx.calls[0]
    assert "cron_deliver_env_var" not in ctx.calls[1]
    assert ctx.calls[1]["name"] == "parley"
