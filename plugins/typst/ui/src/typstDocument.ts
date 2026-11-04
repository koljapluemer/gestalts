import { asMap, noteLabel, relationships, str, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';

export const DOCUMENT_OF = 'document-of';
export const CITES = 'cites';

const TEMPLATE = `#set page(paper: "a4")
#set text(lang: "en")

// images: the image tool adds them as #image("/blobs/<name>"); cite sources as @citekey
= Title
`;

/** The Typst documents (`typst-document@1`) about the note `hostId`. */
export const documentsOf = (documents: IndexedNote[], hostId: string) =>
  documents.filter((d) => relationships(d).some((r) => r.label === DOCUMENT_OF && r.target === hostId));

/** A new Typst document about `host`. */
export function createTypstDocument(repo: Repo, host: IndexedNote): Promise<IndexedNote> {
  return repo.putValue(undefined, {
    title: `${noteLabel(host)}.typ`,
    tags: ['typst'],
    source: TEMPLATE,
    relationships: [{ to: host.id, label: DOCUMENT_OF }],
  });
}

const base = (value: Json | null) => asMap(value) ?? {};
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const labelOf = (r: Json) => asMap(r)?.label;
const targetOf = (r: Json) => (typeof r === 'string' ? r : asMap(r)?.to ?? asMap(r)?.file);

/** The document's value with `source`, and a `cites` relationship to each source cited it doesn't have yet (never removed). */
export function withSource(value: Json | null, source: string, cited: string[]): Json {
  const v = base(value);
  const rels = list(v.relationships);
  const have = new Set(rels.filter((r) => labelOf(r) === CITES).map(targetOf));
  return { ...v, source, relationships: [...rels, ...cited.filter((id) => !have.has(id)).map((to) => ({ to, label: CITES }))] };
}

/** The document's value with `path` (as the source reads it, e.g. `/blobs/a.webp`) placed from blob `blob`. */
export function withAsset(value: Json | null, path: string, blob: string): Json {
  const v = base(value);
  const blobs = list(v.blobs);
  return {
    ...v,
    assets: { ...asMap(v.assets), [path]: blob },
    blobs: blobs.some((b) => targetOf(b) === blob) ? blobs : [...blobs, { file: blob, label: 'asset' }],
  };
}

/** The document's value with `blob` as its built PDF. */
export function withPdf(value: Json | null, blob: string): Json {
  const v = base(value);
  return { ...v, blobs: [...list(v.blobs).filter((b) => labelOf(b) !== 'pdf'), { file: blob, label: 'pdf' }] };
}

/** `path -> blob` of the document's assets. */
export function assetsOf(doc: IndexedNote): Record<string, string> {
  const m = asMap(doc.value ? asMap(doc.value)?.assets : null) ?? {};
  return Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

export const sourceOf = (doc: IndexedNote) => str(doc, 'source') ?? '';

/** How to cite a key: `@key` where Typst's reference syntax allows it, else `#cite(label("…"))`. */
export const citation = (key: string) => (/^[\p{L}\p{N}_][\p{L}\p{N}_\-.:]*[\p{L}\p{N}_-]$|^[\p{L}\p{N}_]$/u.test(key) ? `@${key}` : `#cite(label(${JSON.stringify(key)}))`);
