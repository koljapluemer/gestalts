import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialMode, rememberMode } from './mode';

afterEach(() => vi.unstubAllGlobals());

describe('product mode', () => {
  it('starts in Learn unless Make was saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(initialMode()).toBe('learn');
    vi.stubGlobal('localStorage', { getItem: () => 'make' });
    expect(initialMode()).toBe('make');
  });

  it('falls back to Learn when storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(initialMode()).toBe('learn');
  });

  it('remembers the chosen mode', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    rememberMode('make');
    expect(setItem).toHaveBeenCalledWith('loops:mode', 'make');
  });
});
