/**
 * @gestalts/viz: what a viz is written with. A viz is `viz({ params, clock, panels, model, scene, checks })`; the
 * runtime (`@gestalts/viz/mount`) owns everything else. `@gestalts/viz/tex` adds the `tex` mark.
 */
export { viz, runChecks, DEFAULT_PANELS, type Viz, type Panel, type Clock, type Ui, type Check, type CheckResult } from './def';
export { range, toggle, choice, point, points, defaults, encode, decode, encodeAll, decodeAll, type Vec, type ParamSpec, type ParamSpecs, type Values } from './params';
export {
  dot, line, arrow, polyline, path, rect, text, raster, heatmap, axis, handles, custom,
  type Mark, type Color, type Pixels, type Frame,
} from './marks';
export { rng, trajectory, rk4, lerp, lerpVec, clamp, near, ticks, partial, distToSegment } from './math';
export { MARKER, type Up, type Down } from './protocol';
