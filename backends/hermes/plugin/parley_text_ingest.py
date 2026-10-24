"""Plain-text attachments (.md, .txt, source files, …) ride INSIDE the
turn's text, fenced, the way a PDF's extracted text does (2026-10-24,
field: "Enable me to upload text files, including .md files and
anything else that is a synonym for a plain text source. Currently,
parley rejects it.").

A text file is not media: there is nothing for the vision pipeline to
do with it, and hermes' `media_urls` contract is for images/video. So
``_materialize_attachments`` persists the durable copy like any upload,
inlines the content as a block (budgeted — a 20 MB log must not eat the
window), and does NOT add it to media_urls.

The block opens with ``[File attached: …]`` and ends with ``[end of
file: …]`` so the Parley bubble can hide it (attachmentNotes.ts) and
show the file chip instead; a ``[File note: …]`` line inside becomes the
bubble's caption when the content was truncated.
"""
from __future__ import annotations

import os
from typing import Optional

# Characters of file content inlined per attachment. 200k chars ≈ 50k
# tokens: generous for notes, specs and source files; a dump beyond it
# is truncated with a note (the whole file is still saved on disk).
TEXT_BLOCK_MAX_CHARS = int(os.environ.get("PARLEY_TEXT_ATTACH_MAX_CHARS", "200000") or 200000)

# Extensions we treat as plain text even when the browser reports no
# or an odd MIME type (".ts" arrives as video/mp2t; ".md" often as "").
TEXT_EXTS = frozenset({
    "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "org", "log", "csv", "tsv",
    "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
    "xml", "html", "htm", "xhtml", "svg", "css", "scss", "less",
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "pyi", "rb", "go", "rs", "java", "kt", "kts",
    "swift", "m", "mm", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "pl", "pm",
    "lua", "r", "jl", "scala", "clj", "ex", "exs", "erl", "hs", "ml", "dart", "vue", "svelte",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto",
    "tex", "bib", "diff", "patch", "gitignore", "gitattributes", "editorconfig", "dockerfile",
    "makefile", "cmake", "gradle", "lock", "srt", "vtt", "ics",
})
TEXT_MIMES = frozenset({
    "application/json", "application/ld+json", "application/x-ndjson", "application/xml",
    "application/x-yaml", "application/yaml", "application/toml", "application/javascript",
    "application/x-javascript", "application/typescript", "application/x-typescript",
    "application/x-sh", "application/x-shellscript", "application/sql", "application/graphql",
    "application/x-httpd-php", "application/x-python", "application/x-tex", "application/x-latex",
    "image/svg+xml",
})
# Browser MIME guesses that are plain text in disguise.
_MISLABELED = {"video/mp2t": "ts", "application/octet-stream": None}

_LANG_BY_EXT = {
    "md": "md", "markdown": "md", "mdx": "md", "json": "json", "jsonl": "json", "yaml": "yaml", "yml": "yaml",
    "toml": "toml", "xml": "xml", "html": "html", "htm": "html", "css": "css", "js": "js", "mjs": "js", "cjs": "js",
    "jsx": "jsx", "ts": "ts", "tsx": "tsx", "py": "python", "rb": "ruby", "go": "go", "rs": "rust", "java": "java",
    "kt": "kotlin", "swift": "swift", "c": "c", "h": "c", "cpp": "cpp", "hpp": "cpp", "cs": "csharp", "sh": "bash",
    "bash": "bash", "zsh": "bash", "sql": "sql", "csv": "csv", "diff": "diff", "patch": "diff", "tex": "latex",
}


def _ext(file_name: Optional[str]) -> str:
    name = (file_name or "").rsplit("/", 1)[-1].lower()
    if name in ("dockerfile", "makefile", "cmakelists.txt"):
        return name.split(".")[0]
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1]


def is_text_attachment(mime: Optional[str], file_name: Optional[str]) -> bool:
    """True for anything we should inline as text rather than hand to the
    media pipeline. MIME first (``text/*`` and the structured-text
    application types), then the extension for empty / mislabeled MIMEs."""
    m = (mime or "").split(";", 1)[0].strip().lower()
    if m.startswith("text/"):
        return True
    if m in TEXT_MIMES:
        return True
    if m and m not in _MISLABELED:
        return False
    return _ext(file_name) in TEXT_EXTS


def normalized_mime(mime: Optional[str], file_name: Optional[str]) -> str:
    """A truthful MIME for the durable copy: ``text/markdown`` for .md
    arriving as "", ``text/plain`` for a mislabeled .ts, etc."""
    m = (mime or "").split(";", 1)[0].strip().lower()
    ext = _ext(file_name)
    if ext in ("md", "markdown", "mdx"):
        return "text/markdown"
    if ext == "csv":
        return "text/csv"
    if ext == "json" or ext == "jsonl":
        return "application/json"
    if ext in ("html", "htm"):
        return "text/html"
    if m and m not in _MISLABELED and (m.startswith("text/") or m in TEXT_MIMES):
        return m
    return "text/plain"


def decode_text(payload: bytes) -> str:
    """UTF-8 with BOM tolerance; undecodable bytes become U+FFFD rather
    than failing the turn."""
    if payload.startswith(b"\xef\xbb\xbf"):
        payload = payload[3:]
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return payload.decode("utf-8", errors="replace")


def _human(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def text_block(file_name: str, text: str, size_bytes: int, saved_path: Optional[str] = None,
               max_chars: int = TEXT_BLOCK_MAX_CHARS) -> str:
    """The fenced block appended to the user's turn. Fenced with a
    longer backtick run than any the content holds, so a markdown file
    with its own code fences cannot close ours early."""
    name = file_name or "file"
    lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    note = ""
    body = text
    if len(body) > max_chars:
        body = body[:max_chars].rstrip()
        note = (f"\n[File note: {name} is {_human(size_bytes)} — only the first {max_chars:,} characters "
                f"are inlined; the full file is saved on disk.]")
    lang = _LANG_BY_EXT.get(_ext(name), "")
    longest = 0
    run = 0
    for ch in body:
        if ch == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    fence = "`" * max(3, longest + 1)
    head = f"[File attached: {name} — {lines} line{'s' if lines != 1 else ''}, {_human(size_bytes)}"
    if saved_path:
        head += f". Saved at: {saved_path}"
    head += "]"
    return f"{head}{note}\n{fence}{lang}\n{body}\n{fence}\n[end of file: {name}]"
