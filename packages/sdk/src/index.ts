/**
 * The perspective port (`@gestalts/sdk`): what a perspective or a plugin's pane gets from the host. Built-in and
 * third-party plugins use exactly this, plus `@gestalts/kit` and `@gestalts/learning`.
 */
export { HOST_API, definePane, definePerspective, type DataSpec, type Pane, type PaneProps, type Perspective, type PerspectiveProps } from './perspective';
export { HostProvider, Slot, useHost, type Host, type NoteDraft, type SlotProps } from './host';
export { RepoProvider, useBlobUrl, useData, useNote, useQuery, useRepo, useRepoVersion, useSettings } from './react';
export { ServiceClient, type MergeResult, type Repo } from './port';
export { bib, cardId, contentHash, hashing, newId, provideNatives, stableId, stateKey, type FieldKind, type Natives, type Source, type SourceMatch, type SourceMerge } from './natives';
export { conflictRecord, conflicts, pathLabel, resolveConflict, resolveConflicts, setAt, type ConflictRecord, type PathSegment, type Resolution } from './conflicts';
export * from './fields';
export * as fold from './fold';
export type { Card, Template, Part, Hashing, FoldWrites } from './fold';
export { INLINE, inlineOutOfSync, inlineRefs, inlineTexts, syncInline, type RefsOf } from './inline';
export { CAPACITY as LOG_CAPACITY, debugLog, installGlobalCapture, logger, onDebugLog, type DebugSnapshot, type Level as LogLevel, type LogEvent, type Logger, type Span } from './log';
export type * from './types';
