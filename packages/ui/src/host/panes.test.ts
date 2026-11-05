import { describe, expect, it } from 'vitest';
import { paneSupport } from './panes';

describe('pane support', () => {
  const requires = { requires: { services: ['typst@1'] } };

  it('needs nothing without requirements', () => {
    expect(paneSupport({}, new Map())).toEqual({ state: 'ok' });
  });

  it('assumes support while the services are unknown', () => {
    expect(paneSupport(requires, undefined)).toEqual({ state: 'ok' });
  });

  it('tells a missing service from one that is not running', () => {
    expect(paneSupport(requires, new Map())).toEqual({ state: 'missing', services: ['typst@1'] });
    expect(paneSupport(requires, new Map([['typst@1', false]]))).toEqual({ state: 'unavailable', services: ['typst@1'] });
    expect(paneSupport(requires, new Map([['typst@1', true]]))).toEqual({ state: 'ok' });
  });
});
