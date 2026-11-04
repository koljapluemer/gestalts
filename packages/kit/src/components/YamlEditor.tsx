import { useState } from 'react';
import { yaml } from '@codemirror/lang-yaml';
import { linter, type Diagnostic } from '@codemirror/lint';
import { Facet, type Text } from '@codemirror/state';
import type { IndexedNote } from '@gestalts/sdk';
import { CodeMirrorHost } from '../primitives';

type Props = {
  value: string;
  /** what the core makes of a text: parse error and gestalt lints are shown inline */
  inspect: (raw: string) => IndexedNote;
  onChange: (raw: string) => void;
  onSave: () => void;
  autofocus?: boolean;
};

/** Raw YAML with highlighting, parse errors and gestalt lints. */
export function YamlEditor({ value, inspect, onChange, onSave, autofocus }: Props) {
  // the editor mounts once per note, so the first `inspect` is the one
  const [extensions] = useState(() => [yaml(), inspector.of(inspect), yamlLinter]);
  return <CodeMirrorHost value={value} extensions={extensions} onChange={onChange} onSave={onSave} autofocus={autofocus} />;
}

const inspector = Facet.define<(raw: string) => IndexedNote, ((raw: string) => IndexedNote) | null>({
  combine: (values) => values[0] ?? null,
});

const yamlLinter = linter((view) => {
  const inspect = view.state.facet(inspector);
  return inspect ? diagnostics(view.state.doc, inspect(view.state.doc.toString())) : [];
}, { delay: 200 });

function diagnostics(doc: Text, n: IndexedNote): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (n.parse_error) {
    const line = doc.line(Math.min(Math.max(n.parse_error.line ?? 1, 1), doc.lines));
    const from = Math.min(line.from + Math.max((n.parse_error.column ?? 1) - 1, 0), line.to);
    out.push({ from, to: Math.max(from, line.to), severity: 'error', message: n.parse_error.message });
  }
  for (const l of n.lints) {
    const top = l.path.split('.')[0];
    const line = findKeyLine(doc, top);
    out.push({ from: line.from, to: line.to, severity: 'warning', message: `${l.gestalt}: ${l.path ? `${l.path} ` : ''}${l.message}` });
  }
  return out;
}

/** The line defining a top-level key, else the first line. */
function findKeyLine(doc: Text, key: string) {
  if (key) {
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (line.text.startsWith(`${key}:`)) return line;
    }
  }
  return doc.line(1);
}
