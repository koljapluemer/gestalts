import { describe, expect, it } from 'vitest';
import { marksOf } from './tools/script';
import { drawLine, missingMark, typingSession } from './view';

describe('the practice loop', () => {
  type W = { id: string; text: string };
  const lines: W[][] = [
    [{ id: 'a', text: 'xin' }, { id: 'b', text: 'chào' }],
    [{ id: 'c', text: 'cảm' }, { id: 'd', text: 'ơn' }],
    [{ id: 'e', text: 'tôi' }],
  ];
  const make = () => {
    const clock = { t: 0 };
    const finished: { line: string[]; value: string; ms: number }[] = [];
    let n = 0;
    const s = typingSession<W>({
      nextChunk: () => lines[n++ % lines.length],
      onLine: (line, value, ms) => finished.push({ line: line.map((w) => w.id), value, ms }),
      now: () => clock.t,
      hidden: () => false,
    });
    s.start();
    return { s, clock, finished };
  };

  it('advances once the field holds the whole line, never while composing', () => {
    const { s, finished } = make();
    expect(s.handleInput('xin ch', false)).toBe(false);
    expect(s.handleInput('xin chào', true)).toBe(false);
    expect(s.view().inputValue).toBe('xin chào');
    expect(s.handleInput('xin chào', false)).toBe(true);
    expect(finished.map((f) => f.line)).toEqual([['a', 'b']]);
    expect(s.view()).toEqual({ currentLine: lines[1], nextLine: lines[2], inputValue: '' });
  });

  it('scores every position of the line, spaces too, once it is done', () => {
    const { s } = make();
    s.handleInput('xinxchao', false);
    // 8 positions: the space and the à are wrong
    expect(s.tick().accuracy).toBe(Math.round((6 / 8) * 100));
  });

  it('counts the words typed in the current line toward WPM', () => {
    const { s, clock } = make();
    s.handleInput('x', false);
    clock.t = 30_000;
    s.handleInput('xin ch', false);
    expect(s.tick().wpm).toBe(Math.round(2 / 0.5));
  });

  it('stops the clock at the tick that finds typing idle, and gives each line its time on the clock', () => {
    const { s, clock, finished } = make();
    s.handleInput('x', false);
    clock.t = 5_000;
    s.handleInput('xin chào', false);
    // ticking every 500 ms: idle is noticed at the first tick more than 10 s after the last key
    for (clock.t = 5_500; clock.t <= 30_000; clock.t += 500) s.tick();
    expect(s.tick().elapsedSeconds).toBe(Math.round(15_500 / 1000));
    clock.t = 60_000;
    s.handleInput('c', false);
    clock.t = 62_000;
    s.handleInput('cảm ơn', false);
    // the second line: the idle tail the clock counted, then the two seconds typing it
    expect(finished.map((f) => f.ms)).toEqual([5_000, 10_500 + 2_000]);
    expect(s.tick().elapsedSeconds).toBe(Math.round(17_500 / 1000));
  });
});

describe('a typed word', () => {
  const word = (text: string) => ({ marks: marksOf(text) });

  it('lacks nothing when every mark is there, even with another letter wrong', () => {
    expect(missingMark(word('người'), 'người')).toBeUndefined();
    expect(missingMark(word('người'), 'ngươi'.slice(0, 3) + 'ời')).toBeUndefined();
  });

  it('names the first mark missing or wrong', () => {
    expect(missingMark(word('người'), 'nguoi')).toBe('ư');
    expect(missingMark(word('người'), 'ngươi')).toBe('huyền');
    expect(missingMark(word('tiếng'), 'tiềng')).toBe('sắc');
    expect(missingMark(word('đỏ'), 'dỏ')).toBe('đ');
    expect(missingMark(word('Đi'), 'Đi')).toBeUndefined();
  });

  it('counts a mark missing where nothing was typed', () => {
    expect(missingMark(word('cảm ơn'), 'cả')).toBe('ơ');
  });
});

describe('drawing a line', () => {
  const words = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

  it('draws different words, none it was told to avoid', () => {
    const line = drawLine(words, () => 1, new Set(['a', 'b']), 3, () => 0.5);
    expect(new Set(line.map((w) => w.id))).toEqual(new Set(['c', 'd', 'e']));
  });

  it('draws by weight', () => {
    const line = drawLine(words, (w) => (w.id === 'e' ? 100 : 0.001), new Set(), 1, () => 0.5);
    expect(line[0].id).toBe('e');
  });

  it('takes from every word when too few are left to avoid', () => {
    expect(drawLine(words, () => 1, new Set(['a', 'b', 'c', 'd']), 3).length).toBe(3);
  });
});
