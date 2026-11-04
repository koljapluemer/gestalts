import type { Json } from '@gestalts/sdk';

/**
 * A canvas as the page holds it: nodes in z-order, each free Markdown text or a linked note (its id), at a flow
 * position (the node's top left). Stored as `canvas.nodes` on the note it's about (`canvas@2`).
 */
export type CanvasNode = { id: string; x: number; y: number } & ({ kind: 'text'; text: string } | { kind: 'note'; note: string });
export type CanvasDoc = { readonly nodes: readonly CanvasNode[] };
/** A node as stored: exactly one of `text` or `note`. */
export type WireNode = { id: string; x: number; y: number; text?: string; note?: string };

export type CanvasAction =
  | { type: 'add'; node: CanvasNode }
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'setText'; id: string; text: string }
  | { type: 'remove'; id: string }
  /** a removed node back where it was in the z-order */
  | { type: 'restore'; node: CanvasNode; index: number }
  | { type: 'toText'; id: string; text: string }
  | { type: 'toNote'; id: string; note: string };

const replace = (doc: CanvasDoc, id: string, change: (node: CanvasNode) => CanvasNode | null): CanvasDoc => {
  const index = doc.nodes.findIndex((node) => node.id === id);
  if (index < 0) return doc;
  const next = change(doc.nodes[index]);
  if (next === doc.nodes[index]) return doc;
  const nodes = [...doc.nodes];
  if (next) nodes[index] = next;
  else nodes.splice(index, 1);
  return { nodes };
};

/**
 * Every change to a canvas. An action naming a node that isn't there (any more) changes nothing and returns the same
 * doc, so a late async result (a conversion finishing after its node was removed) can't bring a node back or
 * duplicate one; adding or restoring an id that's there does nothing either.
 */
export function canvasReducer(doc: CanvasDoc, action: CanvasAction): CanvasDoc {
  switch (action.type) {
    case 'add':
      return doc.nodes.some((node) => node.id === action.node.id) ? doc : { nodes: [...doc.nodes, action.node] };
    case 'restore': {
      if (doc.nodes.some((node) => node.id === action.node.id)) return doc;
      const nodes = [...doc.nodes];
      nodes.splice(Math.max(0, Math.min(action.index, nodes.length)), 0, action.node);
      return { nodes };
    }
    case 'move':
      return replace(doc, action.id, (node) => (node.x === action.x && node.y === action.y ? node : { ...node, x: action.x, y: action.y }));
    case 'setText':
      return replace(doc, action.id, (node) => (node.kind !== 'text' || node.text === action.text ? node : { ...node, text: action.text }));
    case 'remove':
      return replace(doc, action.id, () => null);
    case 'toText':
      return replace(doc, action.id, ({ id, x, y }) => ({ id, x, y, kind: 'text', text: action.text }));
    case 'toNote':
      return replace(doc, action.id, ({ id, x, y }) => ({ id, x, y, kind: 'note', note: action.note }));
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The stored nodes, and what's wrong with any that aren't valid. With problems the canvas must not be written over. */
export function fromWire(stored: Json | undefined): { doc: CanvasDoc; problems: string[] } {
  if (stored === undefined || stored === null) return { doc: { nodes: [] }, problems: [] };
  if (!Array.isArray(stored)) return { doc: { nodes: [] }, problems: ['`nodes` is not a list'] };
  const nodes: CanvasNode[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  stored.forEach((raw, i) => {
    const where = `node ${i + 1}`;
    const n = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!n) return void problems.push(`${where} is not a map`);
    const { id, x, y, text, note } = n;
    if (typeof id !== 'string' || !id) return void problems.push(`${where} has no id`);
    if (ids.has(id)) return void problems.push(`${where} repeats the id ${id}`);
    if (!finite(x) || !finite(y)) return void problems.push(`${where} (${id}) needs numbers x and y`);
    if ((text === undefined) === (note === undefined)) return void problems.push(`${where} (${id}) needs exactly one of text or note`);
    if (text !== undefined && typeof text !== 'string') return void problems.push(`${where} (${id}): text is not a string`);
    if (note !== undefined && typeof note !== 'string') return void problems.push(`${where} (${id}): note is not an id`);
    ids.add(id);
    nodes.push(typeof text === 'string' ? { id, x, y, kind: 'text', text } : { id, x, y, kind: 'note', note: note as string });
  });
  return { doc: { nodes }, problems };
}

export const toWire = (doc: CanvasDoc): WireNode[] =>
  doc.nodes.map((node) => (node.kind === 'note' ? { id: node.id, x: node.x, y: node.y, note: node.note } : { id: node.id, x: node.x, y: node.y, text: node.text }));

/** Compares stored canvases regardless of how their YAML orders keys. */
export const sameNodes = (a: WireNode[], b: WireNode[]) => JSON.stringify(a) === JSON.stringify(b);

/** A node id not in the doc. */
export function nodeId(doc: CanvasDoc): string {
  const taken = new Set(doc.nodes.map((node) => node.id));
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id.length === 8 && !taken.has(id)) return id;
  }
}

/** The ids of the notes on the canvas, each once, in z-order. */
export const linkedNotes = (doc: CanvasDoc | WireNode[]) => {
  const nodes = Array.isArray(doc) ? doc : doc.nodes;
  return [...new Set(nodes.flatMap((n) => ('kind' in n ? (n.kind === 'note' ? [n.note] : []) : n.note !== undefined ? [n.note] : [])))];
};
