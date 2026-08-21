#!/usr/bin/env python3
"""
Convert a Chinese .docx script into the markdown format that
`src/workflow/script_parser.ts` expects.

The parser looks for:
  # Title
  **剧本类型**: xxx            (optional)
  **人物角色**:
  1. **NameA**: short description
  2. **NameB**: short description
  **场景**: setting prose      (optional)
  **时长**: 3-5分钟            (optional)
  ---
  **【第一幕:xxx】**           (act heading — must be `**【...】**`)
  (stage direction in parens)  (parens become `direction` blocks)
  **NameA**：dialog             (Chinese colon → `dialog` blocks)

The input docx typically has:
  - Line 0: title
  - Line N: "场景：..." → setting
  - Line N+1: "人物：..." → one character (we list it under 人物角色)
  - Body: alternating `【act name】` headings and prose paragraphs

Usage:
  py scripts/convert_docx_to_md.py <input.docx> <output.md>

If `<output.md>` is omitted, writes next to the input with `.md` extension.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from docx import Document


def _read_paragraphs(path: Path) -> list[str]:
    """Read all non-empty paragraphs from a docx as a flat list."""
    doc = Document(str(path))
    return [p.text.strip() for p in doc.paragraphs if p.text.strip()]


def _parse_header(lines: list[str]) -> tuple[str, list[str], str, str, int]:
    """Extract title + setting + characters from the first few lines.

    Returns (title, character_lines, setting, duration, body_start_idx).
    Lines that look like body content are left in `lines` for the body pass.
    """
    title = ""
    setting = ""
    duration = ""
    character_lines: list[str] = []
    body_start = len(lines)  # default: nothing left for body

    for i, line in enumerate(lines):
        # Stop header parsing when we hit a body marker or `---` separator.
        if line.startswith("【") and line.endswith("】"):
            body_start = i
            break
        if line.strip().startswith("---"):
            body_start = i + 1
            break
        if line.startswith("# "):
            title = line[2:].strip()
            continue
        if line.startswith("**人物角色**") or line.startswith("**人物**") or line.startswith("**角色**"):
            # Characters follow as numbered list `1. **Name**: desc`
            j = i + 1
            while j < len(lines):
                sub = lines[j].strip()
                if sub and (sub[0].isdigit() and "**" in sub) or sub.startswith("- **"):
                    character_lines.append(sub)
                    j += 1
                else:
                    break
            # Continue from j; don't break the outer loop yet (more header keys may follow).
            continue
        if line.startswith("**场景**") or line.startswith("场景：") or line.startswith("场景:"):
            sep = "：" if "：" in line else (":" if ":" in line else None)
            if sep:
                setting = line.split(sep, 1)[1].strip()
            continue
        if line.startswith("**时长**") or line.startswith("**类型**") or line.startswith("**剧本类型**"):
            sep = "：" if "：" in line else (":" if ":" in line else None)
            if sep:
                duration = line.split(sep, 1)[1].strip()
            continue
        # If the first line is the title (no `#`), grab it now.
        if not title and i == 0:
            title = line

    return title, character_lines, setting, duration, body_start


def _parse_actors_header(actors_str: str) -> list[str]:
    """Parse the `人物：xxx（desc）` style into numbered character lines.

    The first comma/顿号/分号/分号 outside of parens splits characters, but
    commas INSIDE parens are part of the description. This keeps a single
    `小女娃（七八岁，将门幼女，眉眼软糯却眼神极亮）` as ONE character.
    """
    if not actors_str:
        return []
    # Split on top-level `、` only — parens content stays together.
    parts = [p.strip() for p in actors_str.split("、") if p.strip()]
    if len(parts) == 1:
        parts = [parts[0]]  # no-op; ensures we still iterate once
    out = []
    for idx, p in enumerate(parts, start=1):
        # Format: "Name（desc）" or "Name(desc)" or "Name:desc" or "Name desc"
        name, desc = "", ""
        for sep in ["（", "(", "：", ":"]:
            if sep in p:
                name, desc = p.split(sep, 1)
                break
        if not name:
            toks = p.split(None, 1)
            name = toks[0]
            desc = toks[1] if len(toks) > 1 else ""
        # Strip trailing ）/).
        desc = desc.rstrip("）)")
        out.append(f"{idx}. **{name.strip()}**: {desc.strip()}")
    return out


def _wrap_act(heading: str) -> str:
    """Ensure act heading is wrapped in `**【...】**`."""
    h = heading.strip()
    # Strip surrounding ** if any
    h = h.strip("*").strip()
    # Strip surrounding 【】 if any
    if h.startswith("【") and h.endswith("】"):
        h = h[1:-1]
    return f"**【{h}】**"


def _format_dialog(line: str) -> Optional[str]:
    """If line looks like dialog (starts with **Name** : / ：), return the
    parser-acceptable form. Otherwise None."""
    stripped = line.strip()
    if not stripped.startswith("**"):
        return None
    # Find closing **
    end = stripped.find("**", 2)
    if end < 0:
        return None
    after = stripped[end + 2:].lstrip()
    # Colon can be : or ：
    for sep in ["：", ":"]:
        if after.startswith(sep):
            text = after[len(sep):].strip()
            name = stripped[2:end].strip()
            return f"**{name}**{sep}{text}"
    return None


def _format_direction(line: str) -> Optional[str]:
    """If line is a parenthetical stage direction, return it wrapped in （）."""
    stripped = line.strip()
    for opener, closer in [("（", "）"), ("(", ")")]:
        if stripped.startswith(opener) and stripped.endswith(closer):
            inner = stripped[1:-1].strip()
            return f"（{inner}）"
    return None


def convert(docx_path: Path, md_path: Path) -> dict:
    lines = _read_paragraphs(docx_path)
    if not lines:
        raise SystemExit(f"ERROR: {docx_path} has no non-empty paragraphs")

    title, character_lines, setting, duration, body_start = _parse_header(lines)

    # If header parser didn't catch a `人物：xxx` style, scan first 10 lines.
    if not character_lines:
        for i, line in enumerate(lines[:10]):
            if line.startswith("人物") or line.startswith("**人物**"):
                if "：" in line:
                    val = line.split("：", 1)[1].strip()
                    character_lines = _parse_actors_header(val)
                    break

    # If still no title, take first line.
    if not title:
        title = lines[0]

    # Build md.
    out: list[str] = []
    out.append(f"# {title}")
    out.append("")
    out.append("**剧本类型**: 动作短片")
    out.append("")
    if character_lines:
        out.append("**人物角色**:")
        out.extend(character_lines)
        out.append("")
    if setting:
        out.append(f"**场景**: {setting}")
        out.append("")
    out.append("**时长**: 60秒")
    out.append("")
    out.append("---")
    out.append("")

    # Body: walk paragraphs from body_start and emit
    # act headings / directions / dialog / prose.
    current_act_lines: list[str] = []
    current_act_name: Optional[str] = None
    acts_seen = 0

    def flush_act():
        if current_act_name is None:
            return
        out.append(_wrap_act(current_act_name))
        out.append("")
        for ln in current_act_lines:
            out.append(ln)
            out.append("")
        current_act_lines.clear()

    for line in lines[body_start:]:
        stripped = line.strip()
        if not stripped:
            continue
        # Skip the AI-gen disclaimer note.
        if stripped.startswith("|（注") or stripped.startswith("| （注"):
            continue
        # Skip header residue (setting / character lines that slipped through).
        if stripped.startswith("场景") or stripped.startswith("人物") or stripped.startswith("**人物") \
                or stripped.startswith("**场景") or stripped.startswith("**时长") \
                or stripped.startswith("# "):
            continue
        # Detect act heading: line is `【xxx】` (with optional leading numbering).
        if stripped.startswith("【") and stripped.endswith("】"):
            flush_act()
            current_act_name = stripped[1:-1]
            acts_seen += 1
            continue
        # Detect stage direction (parenthetical).
        as_dir = _format_direction(stripped)
        if as_dir is not None:
            current_act_lines.append(as_dir)
            continue
        # Detect dialog.
        as_dlg = _format_dialog(stripped)
        if as_dlg is not None:
            current_act_lines.append(as_dlg)
            continue
        # Plain prose paragraph → wrap as a (direction) block so the parser
        # recognises it. Without this, parseScript yields 0 blocks per act and
        # decomposeIntoShots produces 0 shots — making the script useless for
        # creative pipelines. Wrapping prose in `（…）` is a small concession
        # to the parser's regex (DIRECTION_RE = /^（(.+?)）$/).
        # Skip if already very short (would feel noisy).
        if len(stripped) > 0:
            current_act_lines.append(f"（{stripped}）")
    flush_act()

    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("\n".join(out), encoding="utf-8")

    return {
        "input": str(docx_path),
        "output": str(md_path),
        "title": title,
        "characters": [c.split("**")[1] for c in character_lines if "**" in c],
        "acts": acts_seen,
        "lines_total": len(lines),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    in_path = Path(argv[1])
    if not in_path.exists():
        print(f"ERROR: input not found: {in_path}", file=sys.stderr)
        return 1
    if len(argv) >= 3:
        out_path = Path(argv[2])
    else:
        out_path = in_path.with_suffix(".md")
    info = convert(in_path, out_path)
    print(f"[docx2md] wrote {info['output']}")
    print(f"[docx2md] title={info['title']!r} characters={info['characters']} acts={info['acts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))