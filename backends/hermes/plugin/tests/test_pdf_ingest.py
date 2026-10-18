"""PDF uploads become text + a few page images (2026-10-18). Field: a
94-page tax return inlined as 94 page images put one turn past the
model's window, and compression can't shrink the turn being answered."""
from __future__ import annotations

import base64
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_user_id_queries import _load_plugin  # noqa: E402


def _have(tool: str) -> bool:
    try:
        subprocess.run([tool, "-v"], capture_output=True, timeout=5, check=False)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


needs_poppler = pytest.mark.skipif(not (_have("pdftotext") and _have("pdftoppm")), reason="poppler not installed")


@pytest.fixture(scope="module")
def pdf():
    import importlib
    plugin = _load_plugin()
    return plugin, importlib.import_module(f"{plugin.__name__}.parley_pdf_ingest")


def _text_pdf(pages: list) -> bytes:
    """Minimal PDF; each entry is that page's text ('' = no text layer)."""
    parts = [b"%PDF-1.4\n"]
    offsets = [0]
    n = len(pages)
    page_nums = [4 + 2 * i for i in range(n)]

    def emit(num, body):
        offsets.append(sum(len(p) for p in parts))
        parts.append(b"%d 0 obj\n%b\nendobj\n" % (num, body))

    emit(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    emit(2, b"<< /Type /Pages /Count %d /Kids [%b] >>" % (n, " ".join(f"{p} 0 R" for p in page_nums).encode()))
    emit(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, text in enumerate(pages):
        lines = [l for l in text.split("\n")] if text else []
        ops = b"".join(b"BT /F1 11 Tf 50 %d Td (%b) Tj ET\n" % (740 - 14 * k, l.encode()) for k, l in enumerate(lines))
        emit(page_nums[i], b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (page_nums[i] + 1))
        emit(page_nums[i] + 1, b"<< /Length %d >>\nstream\n%b\nendstream" % (len(ops), ops))
    xref = sum(len(p) for p in parts)
    parts.append(b"xref\n0 %d\n0000000000 65535 f \n" % (len(offsets)))
    for off in offsets[1:]:
        parts.append(b"%010d 00000 n \n" % off)
    parts.append(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(offsets), xref))
    return b"".join(parts)


def _wordy(i: int) -> str:
    return "\n".join(f"Line {k} of page {i}: taxable income schedule entry amount 1234.56" for k in range(8))


def test_choose_pages_text_heavy_doc_gets_preview_plus_sparse(pdf):
    _, ing = pdf
    texts = ["x" * 900] * 94
    texts[46] = ""            # a signature page with no text
    pages, scanned = ing.choose_image_pages(texts, 94, preview=2, cap=6, sparse_chars=200)
    assert pages == [1, 2, 47] and not scanned


def test_choose_pages_scanned_doc_falls_back_to_first_pages(pdf):
    _, ing = pdf
    pages, scanned = ing.choose_image_pages([""] * 40, 40, preview=2, cap=6, sparse_chars=200)
    assert pages == [1, 2, 3, 4, 5, 6] and scanned


def test_choose_pages_respects_the_cap(pdf):
    _, ing = pdf
    pages, _ = ing.choose_image_pages(["x" * 900] * 5 + [""] * 20 + ["x" * 900] * 75, 100, preview=2, cap=6, sparse_chars=200)
    assert len(pages) == 6


def test_text_block_is_fenced_and_budgeted(pdf):
    _, ing = pdf
    texts = [f"page {i} body " * 50 for i in range(1, 11)]
    b = ing.build_text_block("return.pdf", 10, texts, [1, 2], "/home/x/uploads/u/0-return.pdf", scanned=False, max_chars=2000)
    assert b.startswith("[PDF attached: return.pdf — 10 pages. Page images included for page(s) 1-2.")
    assert "/home/x/uploads/u/0-return.pdf" in b and "pdftoppm" in b
    assert b.rstrip().endswith("[end of PDF: return.pdf]")
    assert "--- page 1 ---" in b and "Text budget reached" in b and "-f " in b
    assert len(b) < 3000


@needs_poppler
def test_prepare_pdf_real_file(pdf, tmp_path):
    _, ing = pdf
    pages = [_wordy(i) for i in range(1, 13)]
    pages[7] = ""                                  # page 8: no text layer
    p = tmp_path / "doc.pdf"; p.write_bytes(_text_pdf(pages))
    plan = ing.prepare_pdf(p, "doc.pdf", str(p), str(tmp_path / "doc"))
    assert plan.total_pages == 12
    assert plan.image_pages == [1, 2, 8]
    assert len(plan.images) == 3 and all(i.exists() and i.suffix == ".png" for i in plan.images)
    assert "taxable income schedule" in plan.text_block and "--- page 12 ---" in plan.text_block


@needs_poppler
def test_materialize_sends_text_and_few_images_not_every_page(pdf, tmp_path, monkeypatch):
    """The field case in miniature: 30 text pages → 2 images + the text,
    not 30 images."""
    plugin, _ = pdf
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    body = _text_pdf([_wordy(i) for i in range(1, 31)])
    Adapter = plugin.ParleyAdapter
    out: list = []
    paths, mimes, _ = Adapter._materialize_attachments(
        Adapter,
        [{"type": "image", "mimeType": "application/pdf", "fileName": "big.pdf",
          "content": "data:application/pdf;base64," + base64.b64encode(body).decode()}],
        text_out=out,
    )
    assert len(paths) == 2 and all(m == "image/png" for m in mimes)
    assert len(out) == 1 and out[0].startswith("[PDF attached: big.pdf — 30 pages")
    assert "--- page 30 ---" in out[0]


def test_compact_layout_keeps_columns_readable(pdf):
    _, ing = pdf
    raw = "Wages            12,345.00      \nTax              1,234.00\n\n\n\nTotal    13,579.00   "
    assert ing.compact_layout(raw) == "Wages  12,345.00\nTax  1,234.00\n\nTotal  13,579.00"
