// The vietnamese-typing deck from the data in tools/data:
//
// - vie.json: the words and expressions to type, each with its meaning (sam-learns-things' typingpractice word list,
//   from linguanodon's typingpractice/data/vie.json);
// - phrasebook.json: pairs of a phrasebook intent and the word that mostly says it (["vie: say hello", "xin chào"]).
//
// Each word is a `typing-word@1` made by one `item-model@1`, practising its word concept `vie:<word>` a little (it is
// copied, not recalled) and the script concepts of its marks (`vie-script: sắc`, `vie-script: ơ`, …, tools/script.ts)
// by each mark's share. Words are `in` `lang: vie` and script concepts `in` `vie: script` (`concept@3`: members
// counted, not evidence); a paired intent links to its word. The phrasebook's concepts (`lang: vie`, the intents) are
// copied byte for byte from its built deck, read as data.
//
//   node plugins/vietnamese-typing-practice/tools/build-deck.ts && mise run publish-data plugins/vietnamese-typing-practice/decks/vietnamese-typing
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { keystrokes, MARK_KEYS, markShares, marksOf } from './script.ts';

const plugin = resolve(import.meta.dirname, '..');
const data = join(plugin, 'tools/data');
const deck = join(plugin, 'decks/vietnamese-typing');
const phrasebook = resolve(plugin, '../phrasebook/decks/vietnamese-for-english-speakers/notes');

const TAGS = ['vietnamese-typing-practice'];
const SOURCE = 'vietnamese-typing-practice/vietnamese-typing';
/** how much copying a word you're shown practises knowing it */
const WORD_WEIGHT = 0.2;
/** being able to say a phrase says you know the word that mostly says it; the other way round, little */
const INTENT_TO_WORD = 0.5;
const WORD_TO_INTENT = 0.1;

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/** the rule every deck names its concepts' ids by */
const conceptId = (name: string) => `concept-${sha(name)}`;
const scriptName = (key: string) => `vie-script: ${key}`;
const LANGUAGE = 'lang: vie';
/** the set of the script's marks */
const SCRIPT = 'vie: script';

const json = async <T>(f: string) => JSON.parse(await readFile(f, 'utf8')) as T;
const words = await json<Record<string, string>>(join(data, 'vie.json'));
const pairs = await json<[string, string][]>(join(data, 'phrasebook.json'));

for (const text of Object.keys(words)) {
  if (text !== text.normalize('NFC') || text !== text.trim()) throw new Error(`"${text}" is not trimmed NFC`);
  // the view compares what's typed by UTF-16 index, so every letter must be one
  if (text.length !== Array.from(text).length) throw new Error(`"${text}" has a letter outside the BMP`);
}
for (const [, word] of pairs) if (!(word in words)) throw new Error(`phrasebook.json: "${word}" is not in vie.json`);

// ---------- ymls ----------

await rm(join(deck, 'notes'), { recursive: true, force: true });
await mkdir(join(deck, 'notes'), { recursive: true });

const members: string[] = [];
const put = async (yml: { id: string } & Record<string, unknown>) => {
  await writeFile(join(deck, 'notes', `${yml.id}.yml`), stringify(yml, { lineWidth: 0 }));
  members.push(yml.id);
};
/** a concept the phrasebook deck owns, its yml as that deck has it */
const copyFromPhrasebook = async (name: string) => {
  const id = conceptId(name);
  let text: string;
  try { text = await readFile(join(phrasebook, `${id}.yml`), 'utf8'); } catch { throw new Error(`the phrasebook deck has no concept "${name}"`); }
  await writeFile(join(deck, 'notes', `${id}.yml`), text);
  members.push(id);
  return id;
};
const link = (from: string, to: string, weight: number, kind: string) => put({
  id: `link-${sha(`${from}|${to}|${SOURCE}`)}`, gestalt: 'concept-link@1', from, to, weight, kind, source: SOURCE,
});

const language = await copyFromPhrasebook(LANGUAGE);

const script = conceptId(SCRIPT);
await put({ id: script, gestalt: 'concept@2', name: SCRIPT });
for (const key of MARK_KEYS) {
  await put({ id: conceptId(scriptName(key)), gestalt: 'concept@3', name: scriptName(key), in: script });
}

const MODEL = 'item-model-vietnamese-typing-practice-type-the-word';
await put({
  id: MODEL, gestalt: 'item-model@1', name: 'type-the-word', title: 'Type the word as shown',
  engine: 'vietnamese-typing-practice/type-the-word',
  responses: Object.fromEntries(MARK_KEYS.map((k) => [k, { label: `wrong or missing ${k}`, concepts: { [conceptId(scriptName(k))]: 1 } }])),
  tags: TAGS,
});

const wordConcept = new Map<string, string>();
for (const [text, gloss] of Object.entries(words)) {
  const concept = conceptId(`vie:${text}`);
  wordConcept.set(text, concept);
  await put({ id: concept, gestalt: 'concept@3', name: `vie:${text}`, in: language });
  const shares = [...markShares(text)].map(([k, s]) => [conceptId(scriptName(k)), s] as const);
  await put({
    id: `typing-word-${sha(text)}`, gestalt: 'typing-word@1', model: MODEL, text, gloss,
    keystrokes: { telex: keystrokes(text, 'telex'), vni: keystrokes(text, 'vni') },
    marks: marksOf(text),
    concepts: Object.fromEntries([[concept, WORD_WEIGHT], ...shares].sort(([a], [b]) => a.localeCompare(b))),
    tags: TAGS,
  });
}

for (const [intent, word] of pairs) {
  const from = await copyFromPhrasebook(intent);
  await link(from, wordConcept.get(word)!, INTENT_TO_WORD, 'says');
  await link(wordConcept.get(word)!, from, WORD_TO_INTENT, 'says');
}

await put({ id: 'deck-vietnamese-typing', gestalt: 'deck@1', name: 'vietnamese-typing', title: 'Vietnamese typing', members: [...members] });
console.log(`${Object.keys(words).length} words, ${MARK_KEYS.length} script concepts, ${pairs.length} phrasebook pairs`);
