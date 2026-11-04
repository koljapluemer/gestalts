import type { ComponentType, ReactNode } from 'react';
import { useData, useRepo } from './react';
import type { Repo, ServiceClient } from './port';
import type { IndexedNote, Query } from './types';

/** The version of this port. A host refuses plugins built for one it doesn't support. */
export const HOST_API = 1;

/** What a perspective works with: named queries, resolved to notes and kept current. */
export type DataSpec = Record<string, Query>;

export type PerspectiveProps<D extends DataSpec> = {
  data: { [K in keyof D]: IndexedNote[] };
  repo: Repo;
};

type ServiceSpec = Record<string, string>;

type Definition<D extends DataSpec, P extends object, S extends ServiceSpec> = {
  id: string;
  title: string;
  /** may depend on the perspective's own props */
  data: D | ((props: P) => D);
  services?: S;
  Component: (props: P & PerspectiveProps<D> & { services: { [K in keyof S]: ServiceClient | undefined } }) => ReactNode;
};

export type Perspective<P extends object> = ComponentType<P> & { id: string; title: string };

/**
 * A perspective: a self-contained view on notes, the unit of the contract and of reuse. Its ports are
 * - `data`: the notes it reads, declared up front (by gestalt and tags)
 * - `repo`: writes (and blob access)
 * - its own props: inputs and events
 * - `useHost()`: what it may ask of the host (open a note, pick one, navigate)
 */
export function definePerspective<D extends DataSpec, P extends object = object, S extends ServiceSpec = Record<string, never>>(def: Definition<D, P, S>): Perspective<P> {
  const { Component } = def;
  function Host(props: P) {
    const repo = useRepo();
    const spec = typeof def.data === 'function' ? def.data(props) : def.data;
    const data = useData(spec) as PerspectiveProps<D>['data'];
    const services = Object.fromEntries(Object.entries(def.services ?? {}).map(([name, id]) => [name, repo.service(id)])) as { [K in keyof S]: ServiceClient | undefined };
    return <Component {...props} data={data} repo={repo} services={services} />;
  }
  Host.displayName = `Perspective(${def.id})`;
  return Object.assign(Host, { id: def.id, title: def.title });
}

/** A pane gets its own settings (`params`, from its `pane@1` note) and nothing else. */
export type PaneProps = { params: Record<string, string> };

export type Pane = ComponentType<PaneProps> & { title: string };

/**
 * A pane: the unit of installing, of opening and closing, and (later) of isolation. A plugin's pane composes the
 * plugin's own perspectives; it composes with other plugins only through notes and host capabilities.
 */
export function definePane(def: { title: string; Component: ComponentType<PaneProps> }): Pane {
  const { Component } = def;
  const P = (props: PaneProps) => <Component {...props} />;
  P.displayName = `Pane(${def.title})`;
  return Object.assign(P, { title: def.title });
}
