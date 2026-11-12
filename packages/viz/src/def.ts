/**
 * A viz: params, at most one clock, a pure model of the params, and a scene drawn from both. Everything else
 * (controls, time, layout, theme, drawing, dragging, hover) is the runtime's.
 */
import type { Mark } from './marks';
import { defaults, type ParamSpecs, type RangeParam, type Values } from './params';

/** A panel's coordinates: `x` and `y` ranges, y pointing up unless `yDown`. */
export type Panel = {
  x: readonly [number, number];
  y: readonly [number, number];
  /** width / height; by default whatever keeps one unit as long across as up */
  aspect?: number;
  yDown?: boolean;
  /** narrowest it gets before the panels wrap to the next row, in px (default 200) */
  min?: number;
  /** its share of a row's width (default 1) */
  grow?: number;
  /** px of room around the coordinates, for axes and labels (default 8, or 32 left and bottom with axes) */
  pad?: number | { top?: number; right?: number; bottom?: number; left?: number };
};

type RangeKeys<S extends ParamSpecs> = { [K in keyof S]: S[K] extends RangeParam ? K : never }[keyof S] & string;

/** Time is one range param moving from its min to its max: play, pause, speed and reset are the runtime's. */
export type Clock<S extends ParamSpecs> = {
  drives: RangeKeys<S>;
  /** seconds from min to max at speed 1 (default 5) */
  duration?: number;
  loop?: boolean;
  /** starts playing (default false) */
  autoplay?: boolean;
};

/** What the scene knows besides params and model: what the pointer is over, and other variants of the model. */
export type Ui<M> = {
  /** the `link` under the pointer (a raster or heatmap adds `:<cell index>`), or null */
  hover: string | null;
  /** the model with a named variant's params on top of the current ones */
  variant: (name: string) => M;
};

/** One expectation about the model, checked at build time: return true (or nothing), or false or why not. */
export type Check<S extends ParamSpecs, M> = {
  name: string;
  params?: Partial<Values<S>>;
  expect: (model: M, params: Values<S>) => boolean | string | void;
};

export type Viz<S extends ParamSpecs, M> = {
  params: S;
  clock?: Clock<S>;
  /**
   * by name, in order; one panel `main` from 0 to 1 both ways by default. A function: coordinates that follow the
   * params or the model (a chart's axes); it must return the same names every time.
   */
  panels?: Record<string, Panel> | ((params: Values<S>, model: NoInfer<M>) => Record<string, Panel>);
  /** named param overrides the scene can compare side by side (`ui.variant(name)`) */
  variants?: Record<string, Partial<Values<S>>>;
  model: (params: Values<S>) => M;
  scene: (params: Values<S>, model: NoInfer<M>, ui: Ui<NoInfer<M>>) => Mark[];
  checks?: Check<S, NoInfer<M>>[];
};

export const DEFAULT_PANELS: Record<string, Panel> = { main: { x: [0, 1], y: [0, 1] } };

/**
 * Declares a viz; its params' types flow into `model`, and the model's into `panels`, `scene` and `checks`. Write
 * `model` before any of those: TypeScript infers the model's type from the first function that mentions it.
 */
export function viz<S extends ParamSpecs, M>(def: Viz<S, M>): Viz<S, M> {
  return def;
}

export type CheckResult = { name: string; ok: boolean; message?: string };

/** Every check of `def`, and the scene once at the defaults, so a scene that throws fails the build. */
export function runChecks<S extends ParamSpecs, M>(def: Viz<S, M>): CheckResult[] {
  const out: CheckResult[] = [];
  const base = defaults(def.params);
  const variant = (p: Values<S>) => (name: string) => def.model({ ...p, ...def.variants?.[name] });
  try {
    const m = def.model(base);
    if (typeof def.panels === 'function') def.panels(base, m);
    def.scene(base, m, { hover: null, variant: variant(base) });
    out.push({ name: 'model and scene at the defaults', ok: true });
  } catch (e) {
    out.push({ name: 'model and scene at the defaults', ok: false, message: String(e instanceof Error ? e.stack ?? e.message : e) });
  }
  for (const c of def.checks ?? []) {
    try {
      const p = { ...base, ...c.params } as Values<S>;
      const r = c.expect(def.model(p), p);
      out.push(r === true || r === undefined ? { name: c.name, ok: true } : { name: c.name, ok: false, message: r === false ? 'expectation not met' : r });
    } catch (e) {
      out.push({ name: c.name, ok: false, message: String(e instanceof Error ? e.message : e) });
    }
  }
  return out;
}
