import { describe, expect, it } from 'vitest';
import { citation, withAsset, withPdf, withSource } from './typstDocument';

describe('typst documents', () => {
  it('adds cites once and never removes them', () => {
    const v = withSource({ source: 'x', relationships: [{ to: 'h', label: 'document-of' }, { to: 'a', label: 'cites' }] }, 'y', ['a', 'b']);
    expect(v).toEqual({ source: 'y', relationships: [{ to: 'h', label: 'document-of' }, { to: 'a', label: 'cites' }, { to: 'b', label: 'cites' }] });
    expect(withSource(v, 'z', [])).toMatchObject({ relationships: (v as { relationships: unknown[] }).relationships });
  });

  it('keeps one pdf and lists assets as blobs', () => {
    const a = withAsset(withAsset({}, '/blobs/x.png', 'x.png'), '/images/y.png', 'x.png');
    expect(a).toEqual({ assets: { '/blobs/x.png': 'x.png', '/images/y.png': 'x.png' }, blobs: [{ file: 'x.png', label: 'asset' }] });
    expect(withPdf(withPdf(a, 'p1.pdf'), 'p2.pdf')).toMatchObject({ blobs: [{ file: 'x.png', label: 'asset' }, { file: 'p2.pdf', label: 'pdf' }] });
  });

  it('cites keys Typst can and cannot write as references', () => {
    expect(citation('vaswani2017')).toBe('@vaswani2017');
    expect(citation('smith:2023')).toBe('@smith:2023');
    expect(citation('odd key')).toBe('#cite(label("odd key"))');
    expect(citation('ends.')).toBe('#cite(label("ends."))');
  });
});
