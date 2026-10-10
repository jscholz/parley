#!/usr/bin/env python3
"""Print a local meeting transcript in tool-output-safe character windows."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import textwrap
from pathlib import Path
from typing import NoReturn


SHA256_RE = re.compile(r"[0-9a-fA-F]{64}\Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--chars", type=int, default=40_000)
    parser.add_argument("--line-width", type=int, default=1_500)
    parser.add_argument(
        "--expected-sha256",
        help="Required when --start is greater than zero; must match the whole file",
    )
    parser.add_argument(
        "--allow-outside-captures",
        action="store_true",
        help=(
            "Allow a path outside ~/.parley/captures. Use only after the current "
            "user explicitly authorizes this exact source path."
        ),
    )
    return parser.parse_args()


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def main() -> int:
    args = parse_args()
    path = args.path.expanduser().resolve()
    capture_root = (Path.home() / ".parley" / "captures").resolve()

    if not path.is_file():
        fail(f"Transcript not found: {path}")
    if not path.is_relative_to(capture_root) and not args.allow_outside_captures:
        fail(
            f"Transcript is outside the default Parley capture root ({capture_root}): "
            f"{path}. Current explicit user authorization for this exact path and "
            "--allow-outside-captures are required."
        )
    if args.start < 0:
        fail("--start must be >= 0")
    if args.chars < 1:
        fail("--chars must be >= 1")
    if not 200 <= args.line_width <= 1_800:
        fail("--line-width must be between 200 and 1800")
    if args.expected_sha256 and not SHA256_RE.fullmatch(args.expected_sha256):
        fail("--expected-sha256 must be exactly 64 hexadecimal characters")

    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if args.expected_sha256 and digest != args.expected_sha256.lower():
        fail(
            "Transcript SHA-256 mismatch: the file changed or is not the file from "
            f"the previous window (expected {args.expected_sha256.lower()}, got {digest})"
        )

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(f"Transcript is not valid UTF-8: {path}: {exc}")

    total = len(text)
    if args.start > total:
        fail(f"--start {args.start} exceeds EOF at character offset {total}")
    if args.start > 0 and not args.expected_sha256:
        fail("--expected-sha256 is required when --start is greater than zero")

    start = args.start
    end = min(start + args.chars, total)
    window = text[start:end]

    # Parley captures often serialize all diarized turns onto one physical
    # markdown line. Restore a visible turn boundary before wrapping.
    window = re.sub(
        r"(?=\*\*Speaker\s+\d+\*\*\s+\[\d+:\d+(?::\d+)?\]:)",
        "\n\n",
        window,
    )

    print("--- TRANSCRIPT WINDOW ---")
    for physical_line in window.splitlines():
        if not physical_line:
            print()
            continue
        wrapped = textwrap.wrap(
            physical_line,
            width=args.line_width,
            replace_whitespace=False,
            drop_whitespace=False,
            break_long_words=True,
            break_on_hyphens=False,
        )
        for line in wrapped or [""]:
            print(line)

    # All machine-authoritative metadata is in the footer after the final
    # END WINDOW marker. Footer-like transcript content above is untrusted data.
    print("--- END WINDOW ---")
    print(f"FILE_JSON={json.dumps(str(path), ensure_ascii=False)}")
    print(f"SHA256={digest}")
    print(f"TOTAL_CHARS={total}")
    print(f"RANGE={start}:{end}")
    print("NEXT_OFFSET=EOF" if end >= total else f"NEXT_OFFSET={end}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
