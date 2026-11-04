/**
 * The shared components that are deliberately public (`@gestalts/kit`), built on `@gestalts/sdk` only. Layers:
 * primitives < components < widgets < views; each imports only from below.
 */
export * from './primitives';
export { GestaltBadges, Modal, NoteLine, YamlEditor } from './components';
export * from './widgets';
export { NewNote } from './views/NewNote';
export { SearchLayout } from './views/SearchLayout';
export { SearchSidebar, type NoteAction } from './views/SearchSidebar';
export { UniversalEditor } from './views/UniversalEditor';
export { setUrlParams, subscribe as subscribeUrl, useUrlList } from './views/urlState';
