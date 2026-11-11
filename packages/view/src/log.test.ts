import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './log';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('keeps debug and info silent', () => {
    const log = logger('test');
    log.debug('detail');
    log.info('notice');
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
  it('writes warnings and errors to the console', () => {
    const log = logger('test');
    log.warn('careful', { id: 1 });
    log.error('broken', { id: 2 });
    expect(console.warn).toHaveBeenCalledWith('[test] careful', { id: 1 });
    expect(console.error).toHaveBeenCalledWith('[test] broken', { id: 2 });
  });
  it('reports slow completed spans but not fast ones', () => {
    const fast = logger('repo').span('fast');
    vi.advanceTimersByTime(100);
    fast.end();
    expect(console.warn).not.toHaveBeenCalled();
    const slow = logger('repo').span('sync', { key: 'k' });
    vi.advanceTimersByTime(2_100);
    slow.end({ count: 2 });
    expect(console.warn).toHaveBeenCalledWith('[repo] sync: slow', { key: 'k', count: 2, ms: 2_100 });
  });
  it('reports a failed span once', () => {
    const span = logger('repo').span('write');
    const error = new Error('no');
    span.fail(error);
    span.end();
    expect(console.error).toHaveBeenCalledWith('[repo] write: failed', { error, ms: 0 });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
