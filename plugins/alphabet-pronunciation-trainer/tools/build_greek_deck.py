#!/usr/bin/env python3
"""Rewrites decks/greek-alphabet (flashcards and their concepts) from a source folder of `{id, title, lang, blobs}` word files.

What a "letter" is in Ancient Greek lives here, and nowhere in the app: decomposed, accents and breathings dropped,
lowercased, final sigma folded into sigma. Each word practices itself fully and each of its letters by that letter's
share of the word. Every letter is `in` `grc:alphabet` (a `concept@3`): the alphabet counts the letters known, and
takes no evidence from them. Words are in no set.

Usage: build_greek_deck.py <source notes dir>   then   mise run publish-data plugins/alphabet-pronunciation-trainer/decks/greek-alphabet
"""

import hashlib
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path

DECK = Path(__file__).resolve().parent.parent / "decks" / "greek-alphabet"
ROOT_NAME = "grc:alphabet"
CARD_BLOB = {"image": "back", "audio": "audio"}


def letters(word: str) -> list[str]:
    decomposed = unicodedata.normalize("NFD", word)
    bare = "".join(c for c in decomposed if not unicodedata.combining(c)).lower().replace("ς", "σ")
    return [c for c in bare if c.isalpha()]


def concept_id(name: str) -> str:
    return "concept-" + hashlib.sha256(name.encode()).hexdigest()[:16]


def scalar(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def strengths(word: str) -> dict[str, float]:
    found = letters(word)
    return {letter: round(count / len(found), 6) for letter, count in Counter(found).items()}


def read_word(path: Path) -> dict:
    """The few plain fields of a source file: one per line, blobs as a `- label:` / `file:` list."""
    word = {"blobs": []}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("- label:"):
            word["blobs"].append({"label": stripped.split(":", 1)[1].strip()})
        elif stripped.startswith("file:"):
            word["blobs"][-1]["file"] = stripped.split(":", 1)[1].strip()
        elif not line.startswith((" ", "-")) and ":" in line and not line.startswith("blobs:"):
            key, value = line.split(":", 1)
            word[key] = value.strip()
    return word


def main(source: Path) -> None:
    notes = DECK / "notes"
    for old in notes.glob("*.yml"):
        old.unlink()
    words = sorted((read_word(p) for p in source.glob("*.yml")), key=lambda w: w["id"])

    practices: dict[str, dict[str, float]] = {}
    for w in words:
        practices[w["id"]] = {f"grc:{w['title']}": 1.0} | {f"grc:{letter}": s for letter, s in strengths(w["title"]).items()}

    root = concept_id(ROOT_NAME)
    names = sorted({name for held in practices.values() for name in held})
    for w in words:
        blobs = "".join(f"- {{label: {CARD_BLOB[b['label']]}, file: {b['file']}}}\n" for b in w["blobs"])
        concepts = "".join(f"  {cid}: {s}\n" for cid, s in sorted((concept_id(n), s) for n, s in practices[w["id"]].items()))
        tags = f"- alphabet-pronunciation\n- lang:{w['lang']}\n- no-generic-practice\n"
        text = f"id: {w['id']}\ngestalt: flashcard@1\nfront: {scalar(w['title'])}\ntags:\n{tags}blobs:\n{blobs}concepts:\n{concepts}"
        (notes / f"{w['id']}.yml").write_text(text, encoding="utf-8")
    for name in names:
        letter = len(name) == len("grc:") + 1
        text = f"id: {concept_id(name)}\ngestalt: concept@{3 if letter else 2}\nname: {scalar(name)}\n" + (f"in: {root}\n" if letter else "")
        (notes / f"{concept_id(name)}.yml").write_text(text, encoding="utf-8")
    (notes / f"{root}.yml").write_text(f"id: {root}\ngestalt: concept@2\nname: {scalar(ROOT_NAME)}\n", encoding="utf-8")

    members = [w["id"] for w in words] + [concept_id(n) for n in names] + [root]
    listing = "".join(f"- {m}\n" for m in members)
    (notes / "deck-greek-alphabet.yml").write_text(f"id: deck-greek-alphabet\ngestalt: deck@1\nname: greek-alphabet\ntitle: Ancient Greek\nmembers:\n{listing}", encoding="utf-8")
    print(f"{len(words)} exercises, {len(names) + 1} concepts")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
