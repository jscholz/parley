---
name: parley-pdf-rasterize
description: Rasterize PDFs to PNG images using the Parley plugin pipeline (pdftoppm).
tags: [PDF, vision, parley, attachments]
---

# Parley PDF Rasterization

When you need to read a PDF (an attachment, a download, a scanned document, a contract), rasterize it to page images and read them with vision instead of trying to extract text directly.

## Why This

- The Parley PWA already has a proven `_rasterize_pdf()` pipeline for PDFs uploaded to the chat.
- Uses `pdftoppm` from poppler-utils (available on most Linux systems).
- Converts each PDF page to a sharp PNG, then vision can read them.
- Better than pymupdf for scanned/image-heavy PDFs; handles encrypted/corrupt PDFs gracefully.
- Already battle-tested in production.

## How to Use

### 1. Get the PDF onto local disk under /tmp

Parley uploads already land as local files (the chat tells you the path);
otherwise download it (curl for a URL, or the relevant mail/drive tool).

### 2. Rasterize to PNGs using pdftoppm

```bash
# Simple two-argument form:
pdftoppm -png <input.pdf> <output_prefix>

# With tuning (mirroring Parley defaults):
pdftoppm -png \
  -r 150 \          # DPI (150 = readable, not bloated)
  -l 50 \           # Max pages (50-page cap avoids timeouts)
  /tmp/input.pdf \
  /tmp/output_prefix

# Output: /tmp/output_prefix-1.png, /tmp/output_prefix-2.png, etc.
# (1-based numbering; zero-padded for 10+ pages)
```

### 3. Read each PNG with vision_analyze

```python
# For each PNG page:
vision_analyze(
    image_url="/tmp/output_prefix-1.png",
    question="Read and transcribe all text on this page. Include headings, body, numbers, anything."
)
```

## Environment Knobs (Parley defaults)

```bash
PARLEY_PDF_DPI=150                          # Resolution
PARLEY_PDF_MAX_PAGES=50                     # Page cap
PARLEY_PDF_RASTERIZE_TIMEOUT_S=30           # Timeout per PDF
PARLEY_PDF_MAX_BYTES=20971520               # 20 MB file-size cap
```

## System Requirement

```bash
# Install pdftoppm (if not already present)
apt install poppler-utils  # Debian/Ubuntu
brew install poppler       # macOS
```

Check availability:
```bash
which pdftoppm && pdftoppm -v
```

## Advantages Over Alternatives

| Approach | Pros | Cons |
|----------|------|------|
| **pdftoppm (this skill)** | Fast, battle-tested, handles scans/images, graceful failure | Requires poppler-utils system dep |
| pymupdf | Lightweight Python | Times out on complex PDFs, struggles with scans |
| marker-pdf | Best OCR, handles equations | ~5GB install, slow, overkill for clean PDFs |
| web_extract | Zero deps if URL available | Only works if PDF has a URL |

## Error Handling

- **pdftoppm not found**: Install poppler-utils. If not allowed, fall back to web_extract if a URL exists.
- **Encrypted/corrupt PDF**: pdftoppm exits non-zero → shell catches it, returns `[]`. Vision won't see images but no crash.
- **Timeout (>30s)**: PDF is too complex or machine is slow. Try `-l 10` to limit pages.
- **Large file (>20MB)**: Parley rejects it; consider uploading to Drive in smaller chunks.

## Gotchas

- pdftoppm uses **1-based numbering**: `output_prefix-1.png` is page 1, not page 0.
- For 10+ pages, it zero-pads: `output_prefix-01.png`, `output_prefix-02.png`, etc. `glob()` handles both.
- The PDF tempfile is left on disk after rasterization — clean it up manually with `rm /tmp/*.pdf` when done.
- Vision is fast and stateless — no setup needed, just call it per-page.

## When to Use This vs. Alternatives

- ✅ **This skill**: scans, contracts, reports — any multi-page PDF where the visual layout matters.
- ✅ **web_extract**: If the PDF has a public URL (arxiv, GitHub, etc.).
- ❌ **Don't use**: Interactive forms, complex page layouts requiring perfect layout preservation (use a GUI). For pure text extraction from born-digital PDFs, pymupdf is simpler if already installed.

