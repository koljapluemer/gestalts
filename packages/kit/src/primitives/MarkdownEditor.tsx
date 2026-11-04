import { useEffect, useState } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, placeholder as placeholderText } from '@codemirror/view';
import { CodeMirrorHost } from './CodeMirrorHost';
import { referenceCompletion, referenceLinks, type ReferenceCandidate } from './markdownCompletion';

type Props = {
  value: string;
  onChange: (text: string) => void;
  /** Mod-s */
  onSave?: () => void;
  /** notes to offer after `[[` */
  search?: (query: string) => ReferenceCandidate[];
  /** a reference was Mod-clicked (or its touch button pressed): its target */
  onOpen?: (target: string) => void;
  /** a referenced note's label; null when it's missing */
  labelOf?: (target: string) => string | null;
  /** files pasted or dropped into the editor (they're not inserted as text) */
  onFiles?: (files: File[]) => void;
  onView?: (view: EditorView | null) => void;
  placeholder?: string;
  /** smallest height of the text, CSS */
  minHeight?: string;
  autofocus?: boolean;
};

/** A Markdown field: `[[` completion, references marked and openable, pasted or dropped files handed on. */
export function MarkdownEditor({ value, onChange, onSave, search, onOpen, labelOf, onFiles, onView, placeholder, minHeight = '6rem', autofocus }: Props) {
  // the extensions are made once; they reach the latest props through this holder, kept current by the effect
  const [props] = useState(() => new Latest({ search, onOpen, labelOf, onFiles }));
  useEffect(() => { props.set({ search, onOpen, labelOf, onFiles }); });
  const [extensions] = useState(() => [
    markdown(),
    EditorView.theme({ '.cm-content': { minHeight } }),
    ...(placeholder ? [placeholderText(placeholder)] : []),
    referenceCompletion((q) => props.current.search?.(q) ?? []),
    referenceLinks({
      onOpen: onOpen ? (t) => props.current.onOpen?.(t) : undefined,
      labelOf: (t) => props.current.labelOf?.(t),
    }),
    EditorView.domEventHandlers({
      paste: (e) => handFiles(e.clipboardData?.files, e, props.current.onFiles),
      drop: (e) => handFiles(e.dataTransfer?.files, e, props.current.onFiles),
    }),
  ]);
  return (
    <CodeMirrorHost value={value} extensions={extensions} onChange={onChange} onSave={onSave ?? (() => {})} onView={onView} autofocus={autofocus}
                    gutter={false} />
  );
}

/** Hands pasted or dropped files on instead of inserting them; false when there are none (or no taker). */
function handFiles(list: FileList | undefined, e: Event, onFiles: ((files: File[]) => void) | undefined) {
  const files = [...(list ?? [])];
  if (!files.length || !onFiles) return false;
  e.preventDefault();
  onFiles(files);
  return true;
}

/** The latest value of something, for callbacks made once (CodeMirror extensions). */
class Latest<T> {
  constructor(public current: T) {}
  set(value: T) { this.current = value; }
}
