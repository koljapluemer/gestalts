import { describe, expect, it } from 'vitest';
import { frameFlags } from './FrameView';

describe('view frame flags', () => {
  it('does not grant browser modals to strict or same-origin views', () => {
    expect(frameFlags().sandbox).toBe('allow-scripts allow-downloads');
    expect(frameFlags(['same-origin']).sandbox).toBe('allow-scripts allow-same-origin allow-downloads');
    expect(frameFlags().sandbox).not.toContain('allow-modals');
    expect(frameFlags(['same-origin']).sandbox).not.toContain('allow-modals');
  });
});
