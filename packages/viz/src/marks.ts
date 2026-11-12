/**
 * What a scene is made of: plain objects, in the coordinates of their panel. A scene returns a fresh list on every
 * frame; the runtime draws it, so marks hold no state. A mark with a `key` is the same thing across frames (it moves
 * smoothly when it has a `transition`); one with a `link` lights up together with every other mark of that link while
 * the pointer is over any of them.
 */
import type { Vec } from './params';

/**
 * A theme color (`fg`, `muted`, `accent`, `border`, `surface`), the n-th series color, or any CSS color (which then
 * looks the same in both themes, so mostly for data: a pixel's own color).
 */
export type Color = 'fg' | 'muted' | 'accent' | 'border' | 'surface' | number | (string & {});

type Base = {
  /** the panel it's drawn in; the first panel by default */
  panel?: string;
  key?: string;
  link?: string;
  /** ms to move from its last state to this one; needs `key` */
  transition?: number;
  opacity?: number;
};

type Stroked = { color?: Color; width?: number; dash?: readonly number[] };

export type PointMark = Base & { type: 'point'; at: Vec; r?: number; color?: Color };
export type LineMark = Base & Stroked & { type: 'line'; from: Vec; to: Vec };
export type ArrowMark = Base & Stroked & { type: 'arrow'; from: Vec; to: Vec; head?: number };
/** `draw` from 0 to 1: how much of it is drawn, from its first point (stroke order, a path being traced) */
export type PolylineMark = Base & Stroked & { type: 'polyline'; points: readonly Vec[]; closed?: boolean; fill?: Color; draw?: number };
/** SVG path data, in panel coordinates */
export type PathMark = Base & Stroked & { type: 'path'; d: string; fill?: Color; draw?: number };
export type RectMark = Base & Stroked & { type: 'rect'; at: Vec; size: Vec; fill?: Color };
export type TextMark = Base & {
  type: 'text'; at: Vec; text: string; color?: Color; size?: number; mono?: boolean; bold?: boolean;
  align?: 'start' | 'middle' | 'end'; baseline?: 'top' | 'middle' | 'bottom';
  /** wraps at this width, in panel units; lines go down from `at` */
  wrap?: number;
};
/** RGBA pixels, row by row */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
/** an image covering `at`..`at + size`; hovering a pixel reports `<link>:<index>` */
export type RasterMark = Base & { type: 'raster'; at: Vec; size: Vec; image: Pixels; smooth?: boolean };
/** a grid of values, row by row, colored from `domain` (low to high); `null` cells are empty */
export type HeatmapMark = Base & {
  type: 'heatmap'; at: Vec; size: Vec; cols: number; rows: number; values: ArrayLike<number | null>; domain?: Vec;
};
export type AxisMark = Base & { type: 'axis'; side: 'bottom' | 'left'; ticks?: number; label?: string; format?: (v: number) => string };
/** draggable points for a `point` or `points` param */
export type HandlesMark = Base & { type: 'handles'; param: string; color?: Color };
/** LaTeX; `\class{name}{…}` makes a part that links as `name` */
export type TexMark = Base & { type: 'tex'; at: Vec; tex: string; size?: number; align?: 'start' | 'middle' | 'end'; display?: boolean };
/** anything else, drawn by hand on the panel's canvas */
export type CustomMark = Base & { type: 'custom'; draw: (ctx: CanvasRenderingContext2D, frame: Frame) => void };

/** what a custom mark gets: the panel's size in px, its coordinates and the theme */
export type Frame = {
  width: number;
  height: number;
  px: (p: Vec) => Vec;
  color: (c: Color) => string;
};

export type Mark = PointMark | LineMark | ArrowMark | PolylineMark | PathMark | RectMark | TextMark | RasterMark
  | HeatmapMark | AxisMark | HandlesMark | TexMark | CustomMark;

type Opts<M> = Omit<M, 'type'>;
type Without<M, K extends keyof M> = Omit<M, 'type' | K>;

export const dot = (at: Vec, o: Without<PointMark, 'at'> = {}): PointMark => ({ type: 'point', at, ...o });
export const line = (from: Vec, to: Vec, o: Without<LineMark, 'from' | 'to'> = {}): LineMark => ({ type: 'line', from, to, ...o });
export const arrow = (from: Vec, to: Vec, o: Without<ArrowMark, 'from' | 'to'> = {}): ArrowMark => ({ type: 'arrow', from, to, ...o });
export const polyline = (pts: readonly Vec[], o: Without<PolylineMark, 'points'> = {}): PolylineMark => ({ type: 'polyline', points: pts, ...o });
export const path = (d: string, o: Without<PathMark, 'd'> = {}): PathMark => ({ type: 'path', d, ...o });
export const rect = (at: Vec, size: Vec, o: Without<RectMark, 'at' | 'size'> = {}): RectMark => ({ type: 'rect', at, size, ...o });
export const text = (at: Vec, s: string, o: Without<TextMark, 'at' | 'text'> = {}): TextMark => ({ type: 'text', at, text: s, ...o });
export const raster = (at: Vec, size: Vec, image: Pixels, o: Without<RasterMark, 'at' | 'size' | 'image'> = {}): RasterMark =>
  ({ type: 'raster', at, size, image, ...o });
export const heatmap = (o: Opts<HeatmapMark>): HeatmapMark => ({ type: 'heatmap', ...o });
export const axis = (side: AxisMark['side'], o: Without<AxisMark, 'side'> = {}): AxisMark => ({ type: 'axis', side, ...o });
export const handles = (param: string, o: Without<HandlesMark, 'param'> = {}): HandlesMark => ({ type: 'handles', param, ...o });
export const custom = (draw: CustomMark['draw'], o: Without<CustomMark, 'draw'> = {}): CustomMark => ({ type: 'custom', draw, ...o });
