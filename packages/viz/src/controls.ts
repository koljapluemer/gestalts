/**
 * The controls, made from the params: native inputs only, one look in every viz. The clock's param becomes the
 * scrubber next to play, reset and speed; points are dragged in their panel instead.
 */
import type { Clock } from './def';
import type { ParamSpec, ParamSpecs } from './params';

export type ControlEvents = {
  set: (name: string, value: unknown) => void;
  play: () => void;
  pause: () => void;
  reset: () => void;
  speed: (s: number) => void;
};

export type Controls = { el: HTMLElement; sync: (values: Record<string, unknown>, playing: boolean, speed: number) => void };

export const SPEEDS = [0.25, 0.5, 1, 2, 4];

const show = (spec: ParamSpec, v: unknown): string => {
  if (typeof v !== 'number') return String(v);
  const step = spec.kind === 'range' ? spec.step : undefined;
  const digits = step ? Math.max(0, Math.ceil(-Math.log10(step))) : 2;
  return v.toFixed(Math.min(digits, 4)).replace('-', '−');
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export function makeControls(specs: ParamSpecs, clock: Clock<ParamSpecs> | undefined, on: ControlEvents): Controls {
  const root = el('div', { className: 'viz-controls' });
  const syncs: ((values: Record<string, unknown>) => void)[] = [];

  function rangeInput(name: string, spec: Extract<ParamSpec, { kind: 'range' }>) {
    const input = el('input', { type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step ?? (spec.max - spec.min) / 1000) });
    input.setAttribute('aria-label', spec.label ?? name);
    const out = el('output');
    input.addEventListener('input', () => on.set(name, Number(input.value)));
    syncs.push((v) => {
      if (document.activeElement !== input || input.value !== String(v[name])) input.value = String(v[name]);
      out.textContent = show(spec, v[name]);
    });
    return { input, out };
  }

  let playButton: HTMLButtonElement | undefined;
  let speedSelect: HTMLSelectElement | undefined;
  if (clock) {
    const spec = specs[clock.drives];
    if (spec?.kind === 'range') {
      playButton = el('button', { type: 'button' });
      playButton.addEventListener('click', () => (playButton!.dataset.playing === '1' ? on.pause() : on.play()));
      const reset = el('button', { type: 'button', textContent: '↺', title: 'Reset' });
      reset.setAttribute('aria-label', 'Reset');
      reset.addEventListener('click', on.reset);
      speedSelect = el('select', { title: 'Speed' });
      speedSelect.setAttribute('aria-label', 'Speed');
      for (const s of SPEEDS) speedSelect.append(el('option', { value: String(s), textContent: `${s}×` }));
      speedSelect.addEventListener('change', () => on.speed(Number(speedSelect!.value)));
      const { input, out } = rangeInput(clock.drives, spec);
      const row = el('div', { className: 'viz-clock' }, playButton, reset);
      if (spec.label) row.append(el('span', { textContent: spec.label }));
      row.append(input, out, speedSelect);
      root.append(row);
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    if (spec.control === false || name === clock?.drives || spec.kind === 'point' || spec.kind === 'points') continue;
    const label = el('label', {}, el('span', { textContent: spec.label ?? name }));
    if (spec.kind === 'range') {
      const { input, out } = rangeInput(name, spec);
      label.append(input, out);
    } else if (spec.kind === 'toggle') {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => on.set(name, input.checked));
      syncs.push((v) => { input.checked = v[name] === true; });
      label.prepend(input);
    } else {
      const select = el('select');
      for (const o of spec.options) select.append(el('option', { value: o, textContent: o }));
      select.addEventListener('change', () => on.set(name, select.value));
      syncs.push((v) => { select.value = String(v[name]); });
      label.append(select);
    }
    root.append(label);
  }

  return {
    el: root,
    sync(values, playing, speed) {
      for (const s of syncs) s(values);
      if (playButton) {
        playButton.dataset.playing = playing ? '1' : '0';
        playButton.textContent = playing ? '❚❚' : '▶';
        playButton.title = playing ? 'Pause' : 'Play';
        playButton.setAttribute('aria-label', playButton.title);
      }
      if (speedSelect) speedSelect.value = String(speed);
    },
  };
}
