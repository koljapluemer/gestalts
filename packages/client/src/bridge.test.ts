import { expect, test } from 'vitest';
import { nodeFor } from './repo';

test('backends, net and llm go to the connector, else the bridge', () => {
  expect(nodeFor({ mode: 'sync', url: null }, null)).toBeNull();
  expect(nodeFor({ mode: 'sync', url: null }, 'http://127.0.0.1:7717')).toBe('http://127.0.0.1:7717/');
  expect(nodeFor({ mode: 'sync', url: 'http://127.0.0.1:7737/' }, 'http://127.0.0.1:7717')).toBe('http://127.0.0.1:7737/');
  expect(nodeFor({ mode: 'direct', url: 'http://127.0.0.1:7737' }, null)).toBe('http://127.0.0.1:7737/');
  // a native app's node is reached by the app, not the page
  expect(nodeFor({ mode: 'paired', url: null }, 'http://127.0.0.1:7717')).toBeNull();
});
