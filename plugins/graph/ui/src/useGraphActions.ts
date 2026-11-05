import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react';
import type { OnConnectEnd, OnConnectStart } from '@xyflow/react';
import { addRelation, relabelRelation, removeRelation } from '@gestalts/kit';
import { asMap, relationships, withTag, type Json, type Repo } from '@gestalts/sdk';
import { HIDE_TAG, type GraphEdge } from './graph';
import { EXPAND_PIN_DEPTH } from './hiddenRelations';
import { IDLE, connectionTarget, type ConnectingInteraction, type Interaction } from './interaction';
import { CREATED_PIN_DEPTH, MANUAL_PIN_DEPTH, SEARCH_PIN_DEPTH, type UseGraph } from './useGraph';
import type { ViewCallbacks } from './viewModel';

type JsonMap = { [key: string]: Json };

export type UndoAction = { message: string; perform: () => Promise<void> };

const UNDO_TIMEOUT_MS = 8000;

/** Changes the value of the note `key`; refused when its YAML doesn't parse. */
async function write(repo: Repo, key: string, change: (v: JsonMap) => JsonMap): Promise<void> {
  const n = repo.get(key);
  const v = asMap(n?.value);
  if (!n || !v) throw new Error(n ? `${key} doesn't parse; fix its YAML first.` : `No note ${key}`);
  const next = change(v);
  if (next !== v) await repo.putValue(key, next);
}

/**
 * Every handler that changes notes from the canvas, and the gestures that start a new note, a connection or the
 * right-click search. The interaction itself is held by the caller, so the layout can read it. Deleting a note, hiding
 * it and removing a relationship can be undone from a toast, the last one only.
 */
export function useGraphActions({ repo, g, setInteraction, markInteraction, onOpen }: {
  repo: Repo;
  g: UseGraph;
  setInteraction: Dispatch<SetStateAction<Interaction>>;
  /** makes the note the next layout anchor */
  markInteraction: (key: string) => void;
  /** the host's editor */
  onOpen?: (key: string) => void;
}) {
  const { pin, unpin, unpinOthers, setDepth, pinAtLeast } = g;
  const [undo, setUndo] = useState<UndoAction | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  // not state: start and end come in one gesture, with nothing to render between
  const connectingFrom = useRef<string | null>(null);
  const onConnectStart: OnConnectStart = useCallback((_e, { nodeId }) => { connectingFrom.current = nodeId; }, []);
  const onConnectEnd: OnConnectEnd = useCallback((_e, state) => {
    const source = connectingFrom.current;
    connectingFrom.current = null;
    if (!source) return;
    const target = connectionTarget(state.toNode);
    // dropped on the canvas: a new note, related from the dragged one
    setInteraction(target && target !== source ? { type: 'connecting', source, target } : { type: 'create', source });
  }, [setInteraction]);

  const onPaneDoubleClick = useCallback((e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setInteraction({ type: 'create', source: null });
  }, [setInteraction]);
  const onPaneContextMenu = useCallback((e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault();
    setInteraction({ type: 'search', screenPosition: { x: e.clientX, y: e.clientY } });
  }, [setInteraction]);
  const addNote = useCallback(() => setInteraction({ type: 'create', source: null }), [setInteraction]);
  const cancel = useCallback(() => setInteraction(IDLE), [setInteraction]);

  /** A note made in the new-note form: related from the note it was dragged out of, and pinned as its own root. */
  const onCreated = useCallback(async (key: string, source: string | null) => {
    setInteraction(IDLE);
    const made = repo.get(key);
    if (source && made) await write(repo, source, (v) => addRelation(v, made.id, null));
    pin(key, CREATED_PIN_DEPTH);
  }, [repo, pin, setInteraction]);

  const onDelete = useCallback(async (key: string, pinDepth: number | null) => {
    const note = repo.get(key);
    if (!note) return;
    // what a delete can take along: the note, and notes that die with it (they relate to it)
    const before = new Map([[key, note.raw]]);
    for (const n of repo.query({})) if (relationships(n).some((r) => repo.keyOf(r.target) === key)) before.set(n.key, n.raw);
    const gone = await repo.delete(key);
    unpin(key);
    setUndo({
      message: gone.length > 1 ? `Note deleted, with ${gone.length - 1} that went with it.` : 'Note deleted.',
      perform: async () => {
        // writing a deleted note again brings it back
        for (const k of gone) {
          const raw = before.get(k);
          if (raw !== undefined) await repo.putRaw(k, raw);
        }
        if (pinDepth !== null) pin(key, pinDepth);
      },
    });
  }, [repo, pin, unpin]);

  const onHide = useCallback(async (key: string, pinDepth: number | null) => {
    await write(repo, key, (v) => withTag(v, HIDE_TAG, true) as JsonMap);
    unpin(key);
    setUndo({
      message: 'Note hidden from the graph.',
      perform: async () => {
        await write(repo, key, (v) => withTag(v, HIDE_TAG, false) as JsonMap);
        if (pinDepth !== null) pin(key, pinDepth);
      },
    });
  }, [repo, pin, unpin]);

  const onConfirmConnection = useCallback(async ({ source, target }: ConnectingInteraction, label: string | null) => {
    const other = repo.get(target);
    if (!other) throw new Error(`No note ${target}`);
    await write(repo, source, (v) => addRelation(v, other.id, label));
    markInteraction(target);
    setInteraction(IDLE);
  }, [repo, markInteraction, setInteraction]);

  const onRelabel = useCallback(async (r: GraphEdge, next: string | null) => {
    await write(repo, r.source, (v) => relabelRelation(v, r.via, r.label, next));
  }, [repo]);

  const onDeleteRelation = useCallback(async (r: GraphEdge) => {
    await write(repo, r.source, (v) => removeRelation(v, r.via, r.label));
    setUndo({ message: 'Relationship removed.', perform: () => write(repo, r.source, (v) => addRelation(v, r.via, r.label)) });
  }, [repo]);

  // an inline relationship is edited in its note's text
  const onOpenInline = useMemo(() => onOpen && ((r: GraphEdge) => onOpen(r.source)), [onOpen]);

  // a badge was clicked: pin its note deep enough for its direct relations, and place what appears next to it
  const onExpandHiddenRelations = useCallback((key: string) => {
    markInteraction(key);
    pinAtLeast(key, EXPAND_PIN_DEPTH);
  }, [markInteraction, pinAtLeast]);

  const performUndo = useCallback(() => {
    if (!undo) return;
    setUndo(null);
    undo.perform().catch((e: unknown) => setUndo({ message: `Not undone: ${e instanceof Error ? e.message : String(e)}`, perform: async () => {} }));
  }, [undo]);

  const callbacks = useMemo<ViewCallbacks>(() => ({
    onOpen,
    onPin: (key) => pin(key, MANUAL_PIN_DEPTH),
    onUnpin: unpin,
    onUnpinOthers: unpinOthers,
    onChangeDepth: setDepth,
    onHide,
    onDelete,
    onRelabel,
    onDeleteRelation,
    onOpenInline,
    onConfirmConnection,
    onCancelInteraction: cancel,
    onExpandHiddenRelations,
  }), [onOpen, pin, unpin, unpinOthers, setDepth, onHide, onDelete, onRelabel, onDeleteRelation, onOpenInline, onConfirmConnection, cancel, onExpandHiddenRelations]);

  return {
    callbacks,
    undo,
    performUndo,
    dismissUndo: useCallback(() => setUndo(null), []),
    onConnectStart,
    onConnectEnd,
    onPaneDoubleClick,
    onPaneContextMenu,
    addNote,
    cancel,
    onCreated,
    /** the right-click search keeps open after a pick, so one search can pin several notes */
    pinFromSearch: useCallback((key: string) => pin(key, SEARCH_PIN_DEPTH), [pin]),
  };
}
