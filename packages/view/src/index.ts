/**
 * `@gestalts/view`: what a view gets from the app around it. A view is one React file that default-exports a component
 * and imports from here, `@gestalts/kit`, `@gestalts/learning`, `@gestalts/sources` and any npm package.
 */
export { useBeliefs, useBlobUrl, useBlobUrls, useCapabilities, useDoc, useHost, useLlm, useNet, useParams, useQuery, useRead, useService, useViewState, useWrite, ViewProvider, type BeliefsResult, type NetResponse, type QueryResult } from './react';
export { connect, type ViewHost } from './connection';
export { fixtureHost, type Fixture } from './fixture';
export { PROTOCOL, type Answers, type Call, type Capabilities, type FromView, type LlmReply, type LlmRequest, type NetReply, type NetRequest, type ServiceReply, type ToView, type ViewError, type ViewInit } from './protocol';
export { logger, type Logger, type Span } from './log';
export type * from './types';
