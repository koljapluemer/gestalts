import { autocompletion, startCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { mathAt } from './markdown';

/**
 * CodeMirror helpers for a Markdown field (one using `@codemirror/lang-markdown`): `[[` completes note targets,
 * references are marked and open on Mod-click (on touch screens, from a button above the one under the cursor).
 */

/** A note offered after `[[`: `target` is what's inserted (its id), `label` what's shown. */
export type ReferenceCandidate = { target: string; label: string; detail?: string };

const REF = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'CodeMark']);

/** Whether `pos` is inside code (by the Markdown syntax tree) or math, where `[[` is no reference. */
export function inCodeOrMath(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (CODE.has(node.name)) return true;
  }
  const text = state.doc.toString();
  for (let i = text.indexOf('$'); i >= 0 && i < pos; i = text.indexOf('$', i + 1)) {
    if (i > 0 && text[i - 1] === '\\') continue;
    const m = mathAt(text, i);
    if (!m) continue;
    if (pos > m.from && pos < m.to) return true;
    i = m.to - 1;
  }
  return false;
}

/** Completes note targets after `[[` (not after `![[`, which names a blob), outside code and math. */
export function referenceCompletion(search: (query: string) => ReferenceCandidate[]): Extension {
  return autocompletion({
    override: [(context: CompletionContext): CompletionResult | null => {
      const before = context.matchBefore(/!?\[\[[^\]|\n]*/);
      if (!before || before.text.startsWith('!') || inCodeOrMath(context.state, before.from)) return null;
      return {
        from: before.from + 2,
        validFor: /^[^\]|\n]*$/,
        filter: false,
        options: search(before.text.slice(2)).map((c) => ({
          label: c.label,
          detail: c.detail,
          apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
            const suffix = view.state.sliceDoc(to, to + 2);
            const close = suffix.startsWith(']]') || suffix.startsWith('|') ? '' : ']]';
            view.dispatch({ changes: { from, to, insert: c.target + close }, selection: { anchor: from + c.target.length + close.length } });
          },
        })),
      };
    }],
  });
}

/** Inserts `[[` (a selection becomes the label: `[[|selection]]`) and opens the completion. */
export function insertReference(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({ changes: { from, to, insert: selected ? `[[|${selected}]]` : '[[' }, selection: { anchor: from + 2 } });
  view.focus();
  return startCompletion(view);
}

/** The note reference (not embed) covering `pos`, if any. */
export function referenceAt(state: EditorState, pos: number): { from: number; to: number; target: string } | null {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(REF)) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return m[1] ? null : { from, to, target: m[2].trim() };
  }
  return null;
}

type LinkOptions = {
  onOpen?: (target: string) => void;
  /** the referenced note's label, shown as the reference's tooltip; null when there's no such note */
  labelOf?: (target: string) => string | null | undefined;
};

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Marks references (struck through when the note is missing) and opens them on Mod-click or the touch button. */
export function referenceLinks({ onOpen, labelOf }: LinkOptions): Extension {
  const marks = (view: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      for (const m of text.matchAll(REF)) {
        const start = from + m.index;
        if (m[1]) { b.add(start, start + m[0].length, Decoration.mark({ class: 'cm-embed' })); continue; }
        const label = labelOf?.(m[2].trim());
        b.add(start, start + m[0].length, Decoration.mark({
          class: label === null ? 'cm-ref cm-ref-missing' : 'cm-ref',
          attributes: { title: label === null ? 'no such note' : `${label ?? m[2]}${onOpen ? ' (Ctrl/⌘-click to open)' : ''}` },
        }));
      }
    }
    return b.finish();
  };
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = marks(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = marks(u.view); }
  }, { decorations: (v) => v.decorations });

  const out: Extension[] = [plugin, theme];
  if (onOpen) {
    out.push(EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const ref = pos === null ? null : referenceAt(view.state, pos);
        if (!ref) return false;
        e.preventDefault();
        onOpen(ref.target);
        return true;
      },
    }));
    if (coarse()) out.push(openButton(onOpen));
  }
  return out;
}

/** On touch screens: an "open" button above the reference the cursor is in. */
function openButton(onOpen: (target: string) => void) {
  const tooltip = (state: EditorState): Tooltip | null => {
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const ref = referenceAt(state, sel.head);
    if (!ref) return null;
    return {
      pos: ref.from,
      above: true,
      create: () => {
        const dom = document.createElement('button');
        dom.type = 'button';
        dom.className = 'btn btn-xs';
        dom.textContent = 'Open';
        dom.addEventListener('mousedown', (e) => e.preventDefault());
        dom.addEventListener('click', () => onOpen(ref.target));
        return { dom };
      },
    };
  };
  return StateField.define<Tooltip | null>({
    create: tooltip,
    update: (value, tr) => (tr.docChanged || tr.selection ? tooltip(tr.state) : value),
    provide: (f) => showTooltip.from(f),
  });
}

const theme = EditorView.baseTheme({
  '.cm-ref': { color: 'var(--color-primary)', textDecoration: 'underline', textDecorationStyle: 'dotted' },
  '.cm-ref-missing': { color: 'color-mix(in oklab, var(--color-base-content) 50%, transparent)', textDecoration: 'line-through' },
  '.cm-embed': { color: 'var(--color-secondary)' },
});
