# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml==6.0.3"]
# ///
"""Rewrites every deck under decks/ from tools/phrases/<language>.yml: flashcards, concepts, concept links, the source
they are adapted from, the deck yml and its LICENSE.md.

Each phrase is an intent, one concept (`vie: ask how someone is`) that every variant practises fully. Variants add what
they practise beyond it (a pronoun, a register) at their own weights. The concepts no language owns (`function: greet`,
`situation: restaurant`, `social: politeness`) are named the same in every deck, so they are one concept across decks,
and each deck's links to them are its own claims (`source` is the deck). Nothing here is a hierarchy: an intent links to
every function it serves and situation it's used in, and languages link their own concepts as they see fit.

Usage: uv run tools/build_phrase_decks.py   then   mise run publish-data plugins/phrasebook/decks/<deck>
"""

import hashlib
from pathlib import Path

import yaml

TOOLS = Path(__file__).resolve().parent
PLUGIN = TOOLS.parent
INTENT_TO_FUNCTION = 0.5
INTENT_TO_SITUATION = 0.3
TO_LANGUAGE = 0.2
# a situation every phrase may come up in says nothing
NO_SITUATION = "anywhere"
TAGS = ["phrasebook", "native:eng", "no-generic-practice"]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def concept_id(name: str) -> str:
    """The same rule as every deck's builder: `concept-` and the first 16 hex digits of the name's sha256."""
    return "concept-" + sha(name)


def write(notes: Path, value: dict) -> str:
    (notes / f"{value['id']}.yml").write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=1000), encoding="utf-8")
    return value["id"]


def license_text(d: dict, src: dict) -> str:
    return f"""# {d['title']}

Adapted from [{src['title']}]({src['url']}) on Wikivoyage, by [its authors]({src['history']}), retrieved
{src['urldate']}, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The page is partly based on
CC BY-SA 3.0 work from other websites.

Changes: phrases selected and reformatted as flashcards, with context notes, and linked to concepts. Cards without a
`sources` credit were written for this deck and are not from Wikivoyage; they still need a native speaker's check.

This deck, as adapted material, is under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) too.
"""


def build(path: Path) -> None:
    d = yaml.safe_load(path.read_text(encoding="utf-8"))
    lang, src = d["lang"], d["source"]
    deck_dir = PLUGIN / "decks" / d["deck"]
    notes = deck_dir / "notes"
    notes.mkdir(parents=True, exist_ok=True)
    for old in notes.glob("*.yml"):
        old.unlink()
    claim = f"phrasebook/{d['deck']}"
    members: list[str] = []
    names: dict[str, list[str]] = {}
    links: dict[str, dict] = {}

    def concept(name: str, alias: str | None = None) -> str:
        names.setdefault(name, [])
        if alias and alias not in names[name]:
            names[name].append(alias)
        return concept_id(name)

    def link(source: str, target: str, weight: float, kind: str) -> None:
        a, b = concept(source), concept(target)
        lid = "link-" + sha(f"{a}|{b}|{claim}")
        if lid in links:
            raise SystemExit(f"{path.name}: two links from {source} to {target}")
        links[lid] = {"id": lid, "gestalt": "concept-link@1", "from": a, "to": b, "weight": weight, "kind": kind, "source": claim}

    source_id = f"source-{src['key']}"
    members.append(write(notes, {
        "id": source_id, "gestalt": "source@1", "key": src["key"], "entrytype": "online", "title": src["title"],
        "organization": ["Wikivoyage"], "urldate": str(src["urldate"]), "url": src["url"], "license": "CC-BY-SA-4.0",
        "extra": f"Authors: {src['history']}. Partly based on CC BY-SA 3.0 work from other websites.",
    }))

    language = f"lang: {lang}"
    concept(language, d["language"])
    for phrase in d["phrases"]:
        intent = f"{lang}: {phrase['intent']}"
        for f in phrase["functions"]:
            link(intent, f"function: {f}", INTENT_TO_FUNCTION, "serves")
        for s in phrase["situations"]:
            if s != NO_SITUATION:
                link(intent, f"situation: {s}", INTENT_TO_SITUATION, "used in")
        for v in phrase["variants"]:
            practised = {concept(intent): 1.0}
            for name, weight in (v.get("concepts") or {}).items():
                practised[concept(name)] = weight
            card = {
                "id": "card-" + sha(f"{d['deck']}|{phrase['intent']}|{v['back']}|{v.get('context', '')}"),
                "gestalt": "flashcard@1",
                "front": v["front"],
                **({"context": v["context"]} if v.get("context") else {}),
                "back": v["back"],
                **({"extra": v["extra"]} if v.get("extra") else {}),
                "tags": [*TAGS, f"lang:{lang}"],
                "concepts": dict(sorted(practised.items())),
                **({} if v.get("own") else {"sources": [{"to": source_id, "label": "adapted from"}]}),
            }
            if card["id"] in members:
                raise SystemExit(f"{path.name}: {phrase['intent']} has the same variant twice")
            members.append(write(notes, card))
    for source, target, weight, kind in d.get("links", []):
        link(source, target, weight, kind)
    # everything this language owns is part of it
    for name in list(names):
        if name.startswith(f"{lang}: "):
            link(name, language, TO_LANGUAGE, "part-of")

    for name, aliases in sorted(names.items()):
        members.append(write(notes, {"id": concept_id(name), "gestalt": "concept@2", "name": name, **({"aliases": aliases} if aliases else {})}))
    for value in links.values():
        members.append(write(notes, value))
    deck_id = f"deck-{d['deck']}"
    write(notes, {"id": deck_id, "gestalt": "deck@1", "name": d["deck"], "title": d["title"], "members": members})
    (deck_dir / "LICENSE.md").write_text(license_text(d, src), encoding="utf-8")
    cards = sum(len(p["variants"]) for p in d["phrases"])
    print(f"{d['deck']}: {cards} cards, {len(names)} concepts, {len(links)} links")


def main() -> None:
    for path in sorted((TOOLS / "phrases").glob("*.yml")):
        build(path)


if __name__ == "__main__":
    main()
