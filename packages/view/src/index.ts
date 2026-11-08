/**
 * `@gestalts/view`: what a view gets from the app around it. A view is one React file that default-exports a component
 * and imports from here, `@gestalts/kit`, `@gestalts/learning` and any npm package.
 */
export { useBlobUrl, useBlobUrls, useDoc, useHost, useQuery, useService, useViewState, useWrite, ViewProvider, type QueryResult } from './react';
export { connect, type ViewHost } from './connection';
export { fixtureHost, type Fixture } from './fixture';
export { PROTOCOL, type Answers, type Call, type FromView, type ServiceReply, type ToView, type ViewError, type ViewInit } from './protocol';
export { CAPACITY as LOG_CAPACITY, debugLog, installGlobalCapture, logger, onDebugLog, type DebugSnapshot, type Level as LogLevel, type LogEvent, type Logger, type Span } from './log';
export type * from './types';
