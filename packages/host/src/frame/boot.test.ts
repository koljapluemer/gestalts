import { describe, expect, it } from 'vitest';
import { bootHtml, closedCsp } from './boot';

describe('the frame page', () => {
  it('has no policy unless given one', () => {
    expect(bootHtml()).not.toContain('Content-Security-Policy');
  });

  it('puts the policy first in its head, escaped, before any script', () => {
    const html = bootHtml(closedCsp({ scripts: ['https://lessons.example/npm/'] }));
    const at = html.indexOf('Content-Security-Policy');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('<script'));
    expect(html).not.toMatch(/content="[^"]*"[^>]*"/);
  });

  it('reaches no server, and loads scripts and media only from where it is told', () => {
    const csp = closedCsp({ scripts: ['https://lessons.example/npm/'], media: ['https://lessons.example/l/'] });
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));
    expect(directive('connect-src')).toBe("connect-src 'none'");
    expect(directive('default-src')).toBe("default-src 'none'");
    expect(directive('script-src')).toContain('https://lessons.example/npm/');
    expect(directive('script-src')).not.toContain('esm.sh');
    expect(directive('img-src')).toBe('img-src blob: data: https://lessons.example/l/');
    expect(directive('form-action')).toBe("form-action 'none'");
  });
});
