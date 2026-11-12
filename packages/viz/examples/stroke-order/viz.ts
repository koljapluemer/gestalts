// The stroke order of 木 (tree): horizontal, vertical, then the left and right falling strokes.
import { clamp, dot, polyline, range, text, viz, type Vec } from '@gestalts/viz';

/** each stroke's centre line, from where the brush starts; hand-drawn in a 1×1 box, y down */
const STROKES: { name: string; points: Vec[] }[] = [
  { name: 'horizontal', points: [[0.14, 0.33], [0.5, 0.315], [0.86, 0.3]] },
  { name: 'vertical', points: [[0.5, 0.07], [0.5, 0.5], [0.5, 0.95]] },
  { name: 'left-falling', points: [[0.47, 0.35], [0.4, 0.5], [0.28, 0.65], [0.12, 0.78]] },
  { name: 'right-falling', points: [[0.53, 0.35], [0.62, 0.5], [0.75, 0.65], [0.9, 0.76]] },
];

export default viz({
  params: { stroke: range(0, STROKES.length, 0, { step: 0.01, label: 'stroke' }) },
  clock: { drives: 'stroke', duration: 5 },
  panels: { main: { x: [0, 1], y: [0, 1], yDown: true, aspect: 1, min: 220 } },
  model: ({ stroke }) => STROKES.map((s, i) => ({ ...s, done: clamp(stroke - i, 0, 1) })),
  scene: (_p, strokes) => [
    ...strokes.map((s) => polyline(s.points, { color: 'border', width: 16 })),
    ...strokes.filter((s) => s.done > 0).map((s, i) => polyline(s.points, { color: 'fg', width: 14, draw: s.done, link: `s${i}` })),
    ...strokes.flatMap((s) => (s.done > 0 && s.done < 1 ? [dot(s.points[0], { color: 'accent', r: 5 })] : [])),
    ...strokes.flatMap((s, i) => (s.done > 0
      ? [text([s.points[0][0] - 0.05, s.points[0][1] - 0.04], String(i + 1), { key: `n${i}`, transition: 300, color: 'accent', bold: true, size: 14, link: `s${i}` })]
      : [])),
  ],
  checks: [
    { name: 'four strokes', expect: (s) => s.length === 4 },
    { name: 'horizontal before vertical', expect: (s) => s[0].name === 'horizontal' && s[1].name === 'vertical' },
    { name: 'halfway through the second stroke, the first is done', params: { stroke: 1.5 }, expect: (s) => s[0].done === 1 && s[1].done === 0.5 && s[2].done === 0 },
  ],
});
