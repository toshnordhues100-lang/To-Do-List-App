#!/usr/bin/env python3
"""Assemble the single-file Claude Artifact edition of Cadence.

The artifact runs on claude.ai, calls Claude through the viewer's own account,
stores each person's tasks in the artifact database and files reminders into
Google Calendar. It reuses the parser, date, store and voice modules from js/
by inlining them (imports and exports stripped) ahead of artifact/app.js.

Run: python3 artifact/build.py  ->  artifact/cadence.html
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "artifact" / "cadence.html"

MODULES = ["js/dates.js", "js/parser.js", "js/store.js", "js/voice.js"]


def strip_module_syntax(src: str) -> str:
    src = re.sub(r"^import [^;]+;\s*$", "", src, flags=re.M)
    src = re.sub(r"^export (const|function|class|let)\b", r"\1", src, flags=re.M)
    return src


def main() -> None:
    parts = []
    for rel in MODULES:
        code = (ROOT / rel).read_text()
        parts.append(f"// ---- {rel} ----\n" + strip_module_syntax(code))
    shared = "\n".join(parts)
    app = (ROOT / "artifact" / "app.js").read_text()
    css = (ROOT / "css" / "styles.css").read_text()
    theme = (ROOT / "artifact" / "theme.css").read_text()
    shell = (ROOT / "artifact" / "shell.html").read_text()

    html = shell.replace("/*__CSS__*/", css + "\n" + theme)
    html = html.replace("/*__JS__*/", "(() => {\n'use strict';\n" + shared + "\n" + app + "\n})();")
    OUT.write_text(html)
    print(f"wrote {OUT} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
