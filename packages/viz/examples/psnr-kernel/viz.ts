// PSNR's mean squared error, collected pixel by pixel: a 1×1 kernel moves over the original and the compressed image.
import { heatmap, near, range, raster, rect, text, viz, type Pixels } from '@gestalts/viz';
import original from './files/original.png?pixels';
import compressed from './files/compressed.png?pixels';

const W = original.width, H = original.height, N = W * H;

/** squared difference at pixel i, averaged over R, G and B */
const sq = (a: Pixels, b: Pixels, i: number) => {
  let s = 0;
  for (let c = 0; c < 3; c++) s += (a.data[i * 4 + c] - b.data[i * 4 + c]) ** 2;
  return s / 3;
};
const ERRORS = Array.from({ length: N }, (_, i) => sq(original, compressed, i));
const MAX_ERROR = Math.max(...ERRORS);
const RECENT = 10;
const img = { x: [0, W], y: [0, H], yDown: true, aspect: 1, min: 120 } as const;

export default viz({
  params: { pixel: range(0, N - 1, 0, { step: 1, label: 'pixel' }) },
  clock: { drives: 'pixel', duration: 30 },
  panels: {
    original: img,
    compressed: img,
    error: img,
    list: { x: [0, 1], y: [0, RECENT + 2.5], yDown: true, aspect: 0.75, min: 120 },
  },
  model: ({ pixel }) => {
    const seen = ERRORS.slice(0, pixel + 1);
    const sum = seen.reduce((a, b) => a + b, 0);
    return {
      values: ERRORS.map((e, i) => (i <= pixel ? e : null)),
      recent: seen.slice(-RECENT).map((e, k, all) => ({ i: pixel - all.length + 1 + k, e })),
      mse: sum / seen.length,
    };
  },
  scene: ({ pixel }, m, ui) => {
    const at = [pixel % W, Math.floor(pixel / W)] as const;
    const cursor = (panel: string) => rect(at, [1, 1], { panel, color: 'accent', width: 2 });
    const hovered = ui.hover?.startsWith('px:') ? Number(ui.hover.slice(3)) : null;
    return [
      raster([0, 0], [W, H], original, { panel: 'original', link: 'px' }),
      raster([0, 0], [W, H], compressed, { panel: 'compressed', link: 'px' }),
      heatmap({ panel: 'error', at: [0, 0], size: [W, H], cols: W, rows: H, values: m.values, domain: [0, MAX_ERROR], link: 'px' }),
      cursor('original'), cursor('compressed'), cursor('error'),
      ...m.recent.map((r, k) => text([0.95, k + 0.6], r.e.toFixed(1), {
        panel: 'list', align: 'end', mono: true, color: r.i === pixel ? 'accent' : 'muted',
      })),
      ...(hovered !== null && hovered <= pixel
        ? [text([0.05, RECENT + 0.6], `(${hovered % W}, ${Math.floor(hovered / W)}): ${ERRORS[hovered].toFixed(1)}`, { panel: 'list', align: 'start', mono: true, size: 12 })]
        : []),
      text([0.95, RECENT + 1.8], `MSE ${m.mse.toFixed(2)}`, { panel: 'list', align: 'end', mono: true, bold: true, size: 15 }),
    ];
  },
  checks: [
    {
      name: 'at the last pixel the MSE is the whole image\'s',
      params: { pixel: N - 1 },
      expect: (m) => near(m.mse, ERRORS.reduce((a, b) => a + b, 0) / N),
    },
    { name: 'the images differ, so the error is positive', params: { pixel: N - 1 }, expect: (m) => m.mse > 0 },
    { name: 'only collected pixels are colored', params: { pixel: 5 }, expect: (m) => m.values[5] !== null && m.values[6] === null },
  ],
});
