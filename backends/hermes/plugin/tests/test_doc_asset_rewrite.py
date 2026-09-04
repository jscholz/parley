"""Unit tests for display_doc's local-asset rewriting.

Field report (2026-09-04): the ITAD mosaic mockup rendered six
broken-image icons in the Docs panel although all six files were present
on disk under exactly the referenced names.

The panel renders HTML in ``<iframe sandbox=… srcdoc=…>``, and a LOCAL
reference cannot load there — the frame's document is ``about:srcdoc``,
so a relative path has no usable base, and ``file:`` is blocked. Measured
in the real frame that day:

    sandbox=""                   every subresource → no request at all
    sandbox="allow-same-origin"  fully-qualified proxy URL → 200

So the client relaxed the sandbox (scripts still blocked) and the plugin
rewrites local references to ``/api/parley/media/<id>`` URLs before the
content ships.

These tests pin the rewriting half. The properties that matter:

  * ``<img src>`` AND CSS ``url(...)`` are both covered — url() was the
    known gap in the first version of this fix, and it is what a
    background-image slide uses.
  * Already-absolute references are never touched. ``data:`` in
    particular is the one form that has always worked; rewriting it
    would be a regression.
  * A reference we cannot resolve or register is left EXACTLY as it was,
    so a doc degrades to a broken image rather than failing to display.
  * Registration is memoized per document, including negative results —
    a still reused across six tiles must cost one HTTP call, not six.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


def _load():
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent = str(plugin_pkg.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    return importlib.import_module(f"{plugin_pkg.name}.parley_doc_tool")


@pytest.fixture(scope="module")
def dt():
    return _load()


@pytest.fixture
def doc(tmp_path):
    """A doc file with a real asset beside it."""
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "tile.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 64)
    p = tmp_path / "slide.html"
    p.write_text("<html></html>")
    return p


@pytest.fixture
def registered(dt, monkeypatch):
    """Stub the registry; record every call so we can assert memoization."""
    calls = []

    def _fake(path):
        calls.append(Path(path))
        return f"/api/parley/media/{Path(path).stem}.jpg"

    monkeypatch.setattr(dt, "_register_media_sync", _fake)
    return calls


# ── the regression: both reference syntaxes ──────────────────────────

def test_img_src_is_rewritten(dt, doc, registered):
    html = '<img src="assets/tile.jpg" height="70">'
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert 'src="/api/parley/media/tile.jpg"' in out
    assert (rw, sk) == (1, 0)


@pytest.mark.parametrize("css", [
    'background-image: url("assets/tile.jpg");',
    "background-image: url('assets/tile.jpg');",
    "background-image: url(assets/tile.jpg);",
    "background-image: url(  assets/tile.jpg  );",
])
def test_css_url_all_quoting_forms(dt, doc, registered, css):
    """The gap that shipped in the first cut of this fix."""
    out, rw, sk = dt._rewrite_local_assets(f"<style>.a{{{css}}}</style>", doc)
    assert "/api/parley/media/tile.jpg" in out
    assert "assets/tile.jpg" not in out
    assert (rw, sk) == (1, 0)


def test_inline_style_attribute_is_covered(dt, doc, registered):
    out, rw, _ = dt._rewrite_local_assets(
        '<div style="background:url(assets/tile.jpg) center/cover"></div>', doc)
    assert "/api/parley/media/tile.jpg" in out
    assert rw == 1


def test_bare_url_stays_bare_inside_a_style_attribute(dt, doc, registered):
    """Regression: emitting a double quote for a bare url() terminates the
    surrounding style="…" attribute, so the rule silently dies. Caught by
    rendering the real frame on 2026-09-04 — the background went black
    while the two quoted forms beside it loaded fine."""
    out, _rw, _sk = dt._rewrite_local_assets(
        '<div style="height:200px;background:url(assets/tile.jpg) center"></div>',
        doc)
    assert 'url(/api/parley/media/tile.jpg)' in out
    assert '"' not in out.split('style="')[1].split('">')[0]
    # The attribute must still be exactly one quoted region.
    assert out.count('"') == 2


@pytest.mark.parametrize("quote", ['"', "'", ""])
def test_original_quoting_is_preserved(dt, doc, registered, quote):
    out, _, _ = dt._rewrite_local_assets(
        f"<style>.a{{background:url({quote}assets/tile.jpg{quote})}}</style>", doc)
    assert f"url({quote}/api/parley/media/tile.jpg{quote})" in out


def test_img_and_css_in_one_document(dt, doc, registered):
    html = ('<style>.hero{background:url(assets/tile.jpg)}</style>'
            '<img src="assets/tile.jpg">')
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert out.count("/api/parley/media/tile.jpg") == 2
    assert (rw, sk) == (2, 0)
    # Same file twice → ONE registration.
    assert len(registered) == 1


# ── absolute references are never touched ────────────────────────────

@pytest.mark.parametrize("src", [
    "data:image/png;base64,iVBORw0KGgo=",
    "https://example.com/a.jpg",
    "http://example.com/a.jpg",
    "//example.com/a.jpg",
])
def test_absolute_srcs_pass_through_untouched(dt, doc, registered, src):
    html = f'<img src="{src}"><style>.a{{background:url({src})}}</style>'
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert out == html
    assert (rw, sk) == (0, 0)
    assert registered == []          # no pointless HTTP calls


# ── graceful degradation ─────────────────────────────────────────────

def test_missing_file_is_left_exactly_as_it_was(dt, doc, registered):
    html = '<img src="assets/nope.jpg">'
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert out == html
    assert (rw, sk) == (0, 1)
    assert registered == []          # never reached the registry


def test_registry_refusal_leaves_reference_intact(dt, doc, monkeypatch):
    """e.g. an .svg, which the media lane refuses on purpose."""
    monkeypatch.setattr(dt, "_register_media_sync", lambda p: None)
    html = '<img src="assets/tile.jpg">'
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert out == html
    assert (rw, sk) == (0, 1)


def test_negative_results_are_memoized(dt, doc, monkeypatch):
    calls = []
    monkeypatch.setattr(dt, "_register_media_sync",
                        lambda p: (calls.append(p), None)[1])
    html = '<img src="assets/tile.jpg"><img src="assets/tile.jpg">'
    _out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert (rw, sk) == (0, 2)
    assert len(calls) == 1           # a miss is remembered as a miss


def test_absolute_local_path_resolves(dt, doc, registered):
    abs_path = str((doc.parent / "assets" / "tile.jpg").resolve())
    out, rw, _ = dt._rewrite_local_assets(f'<img src="{abs_path}">', doc)
    assert "/api/parley/media/tile.jpg" in out
    assert rw == 1


def test_file_url_resolves(dt, doc, registered):
    abs_path = (doc.parent / "assets" / "tile.jpg").resolve()
    out, rw, _ = dt._rewrite_local_assets(f'<img src="file://{abs_path}">', doc)
    assert "/api/parley/media/tile.jpg" in out
    assert rw == 1


def test_document_without_assets_is_untouched(dt, doc, registered):
    html = "<h1>Just words</h1>"
    out, rw, sk = dt._rewrite_local_assets(html, doc)
    assert (out, rw, sk) == (html, 0, 0)


def test_back_compat_alias_still_resolves(dt):
    assert dt._rewrite_local_images is dt._rewrite_local_assets
