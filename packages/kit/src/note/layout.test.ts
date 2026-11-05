import { describe, expect, it } from 'vitest';
import type { FieldRule, GestaltDef, Lint } from '@gestalts/sdk';
import { inferType, layoutOf } from './layout';

const rule = (type: FieldRule['type'], required = false): FieldRule => ({ type, required, min: null, max: null, one_of: null, fields: {}, items: null, values: null });
const def = (name: string, fields: Record<string, FieldRule>): GestaltDef => ({
  name, version: 1, description: null, requires_tags: [name], trigger_fields: [], fields, blobs: {}, relationships: {},
});
const lint = (gestalt: string, path: string): Lint => ({ gestalt, path, message: 'missing' });

const defs = [
  def('appointment', { title: rule('string'), date: rule('partial_date', true) }),
  def('source', { title: rule('string', true), date: rule('partial_date'), citekey: rule('string', true), author: rule('string_list') }),
  def('quote', { main: rule('text', true), attribution: rule('string') }),
];

describe('layoutOf', () => {
  it('shows a field two gestalts claim once, at the first, claimed by both', () => {
    const { sections } = layoutOf({
      value: { title: 'x', date: '2026', citekey: 'k' }, lints: [],
      gestalts: [{ id: 'appointment@1', has: true }, { id: 'source@1', has: true }], defs, lenses: [],
    });
    expect(sections.map((s) => [s.id, s.fields.map((f) => f.path)])).toEqual([['appointment@1', ['date']], ['source@1', ['citekey', 'author']]]);
    expect(sections[0].fields[0].claimedBy).toEqual(['appointment@1', 'source@1']);
  });

  it('puts focused lenses first, then by priority, then had before candidates, then by name', () => {
    const order = (focus: string[], priority = 0) => layoutOf({
      value: {}, lints: [lint('appointment@1', 'date')],
      gestalts: [{ id: 'quote@1', has: true }, { id: 'appointment@1', has: false }], defs,
      lenses: [{ gestalt: 'appointment@1', priority }], focus,
    }).sections.map((s) => s.id);
    expect(order([])).toEqual(['quote@1', 'appointment@1']);
    expect(order([], 1)).toEqual(['appointment@1', 'quote@1']);
    expect(order(['appointment@1'])).toEqual(['appointment@1', 'quote@1']);
  });

  it('marks a candidate\'s missing required field, with its lint', () => {
    const { sections } = layoutOf({ value: { title: 'x' }, lints: [lint('appointment@1', 'date')], gestalts: [{ id: 'appointment@1', has: false }], defs, lenses: [] });
    expect(sections[0]).toMatchObject({ has: false, fields: [{ path: 'date', set: false, required: true, lints: [lint('appointment@1', 'date')] }] });
  });

  it('offers the fields the lens names for the note', () => {
    const { sections } = layoutOf({
      value: { entrytype: 'book' }, lints: [], gestalts: [{ id: 'source@1', has: true }], defs,
      lenses: [{ gestalt: 'source@1', offered: (v) => (v.entrytype === 'book' ? ['author'] : []) }],
    });
    expect(sections[0].fields.map((f) => [f.path, f.offered])).toEqual([['date', false], ['citekey', false], ['author', true]]);
  });

  it('leaves the body to the body, with its lints, and skips a lens with nothing else', () => {
    const { sections, bodyLints } = layoutOf({ value: {}, lints: [lint('quote@1', 'main')], gestalts: [{ id: 'quote@1', has: false }], defs, lenses: [{ gestalt: 'quote@1', fields: { attribution: { hidden: true } } }] });
    expect(sections).toEqual([]);
    expect(bodyLints).toEqual([lint('quote@1', 'main')]);
  });

  it('orders and labels a lens\'s fields as it says, and lists unclaimed fields last', () => {
    const { sections } = layoutOf({
      value: { citekey: 'k', weird: 3, tags: ['x'] }, lints: [], gestalts: [{ id: 'source@1', has: true }], defs,
      lenses: [{ gestalt: 'source@1', title: 'Source', fields: { author: { order: 0, label: 'Authors' } } }],
    });
    expect(sections.map((s) => [s.title, s.fields.map((f) => f.label)])).toEqual([['Source', ['Authors', 'date', 'citekey']], ['Other', ['weird']]]);
  });
});

describe('inferType', () => {
  it('reads a type off a value', () => {
    expect([inferType('a'), inferType('a\nb'), inferType(2), inferType(2.5), inferType(true), inferType(['a']), inferType([{}]), inferType({}), inferType(undefined)])
      .toEqual(['string', 'text', 'integer', 'number', 'bool', 'string_list', 'list', 'map', 'any']);
  });
});
