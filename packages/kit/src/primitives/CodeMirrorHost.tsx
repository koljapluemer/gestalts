import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { editorTheme } from './editorTheme';

type Props = {
  /** the document; a value other than the editor's own (a change from outside) replaces it, undoably */
  value: string;
  extensions: Extension[];
  autofocus?: boolean;
  onChange: (doc: string) => void;
  /** Mod-s */
  onSave: () => void;
  /** the editor once mounted (null on unmount), for owners that insert at the cursor */
  onView?: (view: EditorView | null) => void;
  /** line numbers in the gutter (default on) */
  gutter?: boolean;
  className?: string;
};

/** A CodeMirror editor with history, line numbers, wrapping and the daisyUI-based theme. */
export function CodeMirrorHost({ value, extensions, autofocus = false, onChange, onSave, onView, gutter = true, className = '' }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onView });
  useEffect(() => { handlers.current = { onChange, onSave, onView }; });

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          gutter ? lineNumbers() : [],
          EditorView.lineWrapping,
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          editorTheme,
          ...extensions,
          EditorView.updateListener.of((u) => { if (u.docChanged) handlers.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = editor;
    handlers.current.onView?.(editor);
    if (autofocus) editor.focus();
    return () => { view.current = null; handlers.current.onView?.(null); editor.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounted once; `value` is reconciled below
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={`rounded-box border border-base-300 focus-within:border-base-content/40 ${className}`} />;
}
