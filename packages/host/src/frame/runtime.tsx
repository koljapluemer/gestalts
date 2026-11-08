/**
 * What every view's frame runs: built into one script and handed over by the app. Everything here is available to a
 * view by importing it.
 */
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as lucide from 'lucide-react';
import * as view from '@gestalts/view';
import * as kit from '@gestalts/kit';
import * as learning from '@gestalts/learning';
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { ViewError, ViewHost, ViewInit } from '@gestalts/view';

const modules: Record<string, unknown> = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'lucide-react': lucide,
  '@gestalts/view': view,
  '@gestalts/kit': kit,
  '@gestalts/learning': learning,
};

class Boundary extends Component<{ host: ViewHost; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.host.report(describe('render', Object.assign(new Error(error.message), { stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` })));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" className="alert alert-error m-4 font-mono text-sm whitespace-pre-wrap">{this.state.error.message}</div>;
  }
}

function describe(kind: ViewError['kind'], e: unknown): ViewError {
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
  return { kind, message: err.message, stack: err.stack, at: new Date().toISOString() };
}

function mount(View: ComponentType, port: MessagePort, init: ViewInit) {
  const host = view.connect(port);
  addEventListener('error', (e) => host.report(describe('error', e.error ?? e.message)));
  addEventListener('unhandledrejection', (e) => host.report(describe('rejection', e.reason)));
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleError(...args);
    host.report(describe('console', args.map(String).join(' ')));
  };
  ReactDOMClient.createRoot(document.getElementById('view')!).render(
    <Boundary host={host}>
      <view.ViewProvider host={host} init={init}><View /></view.ViewProvider>
    </Boundary>,
  );
}

(globalThis as unknown as { __gestaltsRuntime: unknown }).__gestaltsRuntime = { modules, mount };
