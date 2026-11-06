/**
 * The shared components that are deliberately public (`@gestalts/kit`), built on `@gestalts/sdk` only. Layers:
 * primitives < components < widgets < note < views; each imports only from below.
 */
export * from './primitives';
export { Modal, NoteGist, NoteLine, YamlEditor, useGistParts, useNoteGist, useNoteLine } from './components';
export * from './widgets';
export * from './note';
export { SearchLayout } from './views/SearchLayout';
export { SearchSidebar, type NoteAction } from './views/SearchSidebar';
export { setUrlParams, subscribe as subscribeUrl, useUrlList } from './views/urlState';
