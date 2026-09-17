#!/usr/bin/env python3
"""Document-network check (quantum-os#116; ported from quantum-logical-framework#149).

Readability across the network of documents means a reader following a link always lands
somewhere: on the parent doc, the proof, or the source file. Three things are checked:

  1. Orphans    -- every .md at the root or under docs/ (except README.md) must be linked
                   from at least one OTHER .md.
  2. Dead links -- every relative Markdown link, in every .md file, must resolve on disk.
  3. Anchors    -- a relative link with a #fragment into another .md must name a heading
                   that exists there (GitHub's slug rule: lowercase, strip punctuation,
                   spaces to hyphens). This is what the README split would otherwise have
                   broken silently.

Exit status is non-zero on any failure, so this gates CI (seconds to run).

    python3 scripts/doc_network_check.py            # report
    python3 scripts/doc_network_check.py --quiet    # only failures
"""
import glob
import os
import re
import sys
import urllib.parse

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

QUIET = "--quiet" in sys.argv

LINK = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
HEADING = re.compile(r'^#{1,6}\s+(.*?)\s*#*\s*$', re.M)
SKIP_PREFIX = ("http://", "https://", "mailto:", "#")
SKIP_DIRS = ("node_modules", "target", ".git", "dist", "pkg")


def all_markdown():
    return sorted(p for p in glob.glob("**/*.md", recursive=True)
                  if not any(part in SKIP_DIRS for part in p.split(os.sep)))


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def slug(heading):
    """GitHub's heading -> anchor rule, close enough for our headings."""
    h = re.sub(r'`([^`]*)`', r'\1', heading)          # code spans keep their text
    h = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', h)     # links keep their label
    h = h.strip().lower()
    h = re.sub(r'[^\w\- ]', '', h)                    # drop punctuation (unicode word chars stay)
    return h.replace(' ', '-')


def anchors_of(text):
    seen = {}
    out = set()
    for m in HEADING.finditer(text):
        s = slug(m.group(1))
        n = seen.get(s, 0)
        seen[s] = n + 1
        out.add(s if n == 0 else f"{s}-{n}")
    return out


def check_orphans(texts):
    candidates = [p for p in texts
                  if p != "README.md" and ("/" not in p or p.startswith("docs/"))]
    orphans = []
    for m in candidates:
        base = os.path.basename(m)
        if not any(base in t for p, t in texts.items() if p != m):
            orphans.append(m)
    return orphans


def check_links(texts):
    dead, bad_anchor = {}, {}
    n = 0
    anchor_cache = {}
    for p, t in texts.items():
        base = os.path.dirname(p)
        for m in LINK.finditer(t):
            target = m.group(1)
            if target.startswith("#"):  # same-file anchor
                if p not in anchor_cache:
                    anchor_cache[p] = anchors_of(t)
                if target[1:].lower() not in anchor_cache[p]:
                    bad_anchor.setdefault(p, []).append(target)
                continue
            if target.startswith(SKIP_PREFIX):
                continue
            n += 1
            path, _, frag = target.partition("#")
            path = urllib.parse.unquote(path)
            if not path or ('.' not in path and '/' not in path):
                continue  # not a path (TeX-ish text that matches the link syntax)
            full = os.path.normpath(os.path.join(base, path))
            if not os.path.exists(full):
                dead.setdefault(p, []).append(target)
                continue
            if frag and full.endswith(".md"):
                if full not in anchor_cache:
                    anchor_cache[full] = anchors_of(read(full))
                if frag.lower() not in anchor_cache[full]:
                    bad_anchor.setdefault(p, []).append(target)
    return n, dead, bad_anchor


def main():
    texts = {p: read(p) for p in all_markdown()}
    orphans = check_orphans(texts)
    n_links, dead, bad_anchor = check_links(texts)

    if not QUIET:
        print(f"markdown files: {len(texts)}   relative links: {n_links}")
    if orphans:
        print("ORPHANS (no incoming link from any other .md):")
        for m in orphans:
            print("   ", m)
    if dead:
        print("DEAD LINKS:")
        for p, ts in sorted(dead.items()):
            for t in sorted(set(ts)):
                print(f"    {p}: {t}")
    if bad_anchor:
        print("BAD ANCHORS (file exists, heading does not):")
        for p, ts in sorted(bad_anchor.items()):
            for t in sorted(set(ts)):
                print(f"    {p}: {t}")
    ok = not orphans and not dead and not bad_anchor
    if not QUIET:
        print("OK" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
