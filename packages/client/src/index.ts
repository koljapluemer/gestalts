/**
 * The host's side of the core (`@gestalts/client`): the wasm-backed `Repo`, opening and syncing it. Everything a
 * perspective uses comes from `@gestalts/sdk`, re-exported here for the host's own code.
 */
export * from '@gestalts/sdk';
export { Repo, nodeHealth, type DeckSource, type NodeHealth, type NotesIn, type RepoSource, type ConnectorStatus, type ServiceStatus } from './repo';
export { useConnector, useHostRepo, useOpenRepo, useServices } from './react';
