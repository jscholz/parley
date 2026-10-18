"""PDF uploads as a DOCUMENT, not a stack of page images (2026-10-18).

Field 2026-10-17: a 94-page tax return was rasterized to 94 page images
inlined in ONE user turn. Compression can't shrink the turn being
answered, so the session could never fit the model's window again
("Start a new session with /new") — and every later turn failed too.

Now a PDF becomes:
  * its extracted TEXT (pdftotext -layout, per page) inline in the turn,
    under a size budget — a fraction of the tokens page images cost;
  * page IMAGES for only a few pages: the first PREVIEW pages plus any
    page with (almost) no text layer — scans, figures, signature pages —
    capped at MAX_IMAGE_PAGES;
  * a note telling the agent where the saved PDF is and how to render any
    other page on demand (the parley-pdf-rasterize skill / pdftoppm).
A PDF with no usable text layer at all (a scan) falls back to images for
the first MAX_IMAGE_PAGES pages, and says so.

The text block is fenced so the Parley bubble can hide it (the user sees
their words + the PDF chip): it opens with "[PDF attached: …]" and ends
with "[end of PDF: …]" — see src/transcript/attachmentNotes.ts.
"""
from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from .parley_env import env_get

logger = logging.getLogger("hermes_plugins.parley.pdf")

PREVIEW_PAGES = int(env_get("PARLEY_PDF_PREVIEW_PAGES", "") or "2")
MAX_IMAGE_PAGES = int(env_get("PARLEY_PDF_MAX_IMAGE_PAGES", "") or "6")
SPARSE_PAGE_CHARS = int(env_get("PARLEY_PDF_SPARSE_PAGE_CHARS", "") or "200")
INLINE_TEXT_MAX_CHARS = int(env_get("PARLEY_PDF_INLINE_TEXT_MAX_CHARS", "") or "160000")   # ≈40k tokens
TIMEOUT_S = int(env_get("PARLEY_PDF_RASTERIZE_TIMEOUT_S", "") or "30")
DPI = int(env_get("PARLEY_PDF_DPI", "") or "150")


@dataclass
class PdfPlan:
    total_pages: int
    image_pages: List[int] = field(default_factory=list)     # 1-based page numbers rendered
    images: List[Path] = field(default_factory=list)
    text_block: str = ""
    scanned: bool = False


def page_count(path: Path) -> Optional[int]:
    try:
        out = subprocess.run(["pdfinfo", str(path)], capture_output=True, timeout=10, check=True)
        for line in (out.stdout or b"").decode(errors="ignore").splitlines():
            if line.startswith("Pages:"):
                return int(line.split(":", 1)[1].strip())
    except Exception as exc:
        logger.debug("[parley] pdfinfo failed on %s: %s", path, exc)
    return None


def page_texts(path: Path) -> List[str]:
    """Per-page text via pdftotext -layout (pages are \\f-separated)."""
    try:
        out = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
                             capture_output=True, timeout=TIMEOUT_S, check=True)
    except Exception as exc:
        logger.warning("[parley] pdftotext failed on %s: %s", path, exc)
        return []
    pages = (out.stdout or b"").decode("utf-8", errors="replace").split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return [compact_layout(p) for p in pages]


_RUN = re.compile(r" {3,}")
_TRAIL = re.compile(r"[ \t]+$", re.M)
_BLANKS = re.compile(r"\n{3,}")


def compact_layout(text: str) -> str:
    """-layout pads table columns with long runs of spaces (a tax return:
    439k chars raw → 258k compacted). Keep a visible column gap (two
    spaces), drop trailing space and blank-line runs. Pure; tested."""
    return _BLANKS.sub("\n\n", _TRAIL.sub("", _RUN.sub("  ", text)))


def choose_image_pages(texts: List[str], total: int, *, preview: int = PREVIEW_PAGES,
                       cap: int = MAX_IMAGE_PAGES, sparse_chars: int = SPARSE_PAGE_CHARS) -> tuple:
    """Which pages to show as images. Returns (pages, scanned). Pure; tested."""
    if total <= 0:
        return [], False
    lengths = [len((texts[i] if i < len(texts) else "").strip()) for i in range(total)]
    sparse = [i + 1 for i, n in enumerate(lengths) if n < sparse_chars]
    scanned = len(sparse) >= max(1, int(total * 0.6))
    if scanned:
        return list(range(1, min(total, cap) + 1)), True
    chosen: List[int] = []
    for p in list(range(1, min(total, preview) + 1)) + sparse:
        if p not in chosen:
            chosen.append(p)
        if len(chosen) >= cap:
            break
    return sorted(chosen), False


def render_pages(path: Path, pages: List[int], out_prefix: str, dpi: int = DPI) -> List[Path]:
    out: List[Path] = []
    for p in pages:
        prefix = f"{out_prefix}-p{p:03d}"
        try:
            subprocess.run(["pdftoppm", "-png", "-r", str(dpi), "-f", str(p), "-l", str(p),
                            "-singlefile", str(path), prefix],
                           capture_output=True, timeout=TIMEOUT_S, check=True)
            png = Path(prefix + ".png")
            if png.exists():
                out.append(png)
        except Exception as exc:
            logger.warning("[parley] pdftoppm page %d failed on %s: %s", p, path, exc)
    return out


def _ranges(pages: List[int]) -> str:
    if not pages:
        return "none"
    out, start, prev = [], pages[0], pages[0]
    for p in pages[1:]:
        if p == prev + 1:
            prev = p
            continue
        out.append(f"{start}" if start == prev else f"{start}-{prev}")
        start = prev = p
    out.append(f"{start}" if start == prev else f"{start}-{prev}")
    return ", ".join(out)


def build_text_block(name: str, total: int, texts: List[str], image_pages: List[int],
                     saved_path: Optional[str], *, scanned: bool,
                     max_chars: int = INLINE_TEXT_MAX_CHARS) -> str:
    """The fenced block appended to the user's turn. Pure; tested."""
    where = f" Saved at: {saved_path}." if saved_path else ""
    render = (f" To see any other page, render it: pdftoppm -png -r 150 -f P -l P '{saved_path}' /tmp/page"
              " (or use the parley-pdf-rasterize skill)." if saved_path else "")
    head = (f"[PDF attached: {name} — {total} page{'s' if total != 1 else ''}. "
            f"Page images included for page(s) {_ranges(image_pages)}.{where}{render}]")
    if scanned:
        body = ("(This PDF has little or no text layer — it looks scanned. Read it from the page images; "
                f"pages beyond {_ranges(image_pages)} need rendering on request.)")
        return f"{head}\n{body}\n[end of PDF: {name}]"
    parts: List[str] = []
    used = 0
    cut_at = None
    for i, t in enumerate(texts, start=1):
        chunk = f"--- page {i} ---\n{t.rstrip()}\n"
        if used + len(chunk) > max_chars:
            cut_at = i
            break
        parts.append(chunk)
        used += len(chunk)
    if cut_at is not None:
        parts.append(f"(Text budget reached — pages {cut_at}-{total} are not included here. "
                     "Render or extract them from the saved PDF when needed: "
                     f"pdftotext -layout -f {cut_at} -l {total} '{saved_path or name}' -)\n")
    return f"{head}\n{''.join(parts)}[end of PDF: {name}]"


def prepare_pdf(path: Path, name: str, saved_path: Optional[str], out_prefix: str) -> Optional[PdfPlan]:
    """Text + a few page images for one uploaded PDF. None on failure (the
    caller falls back to full rasterization)."""
    total = page_count(path)
    texts = page_texts(path)
    if total is None:
        total = len(texts)
    if not total:
        return None
    pages, scanned = choose_image_pages(texts, total)
    images = render_pages(path, pages, out_prefix)
    block = build_text_block(name, total, texts, pages, saved_path, scanned=scanned)
    logger.info("[parley] PDF %s: %d pages → text %d chars, images for %s%s",
                name, total, sum(len(t) for t in texts), _ranges(pages), " (scanned)" if scanned else "")
    return PdfPlan(total_pages=total, image_pages=pages, images=images, text_block=block, scanned=scanned)
