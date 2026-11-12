/**
 * The `tex` mark: LaTeX rendered to MathML with temml, laid over the panel. `\class{name}{…}` makes a part that links
 * as `name`: hovering it lights up every mark linked `name`, and those marks light it up.
 */
import temml from 'temml';
import 'temml/dist/Temml-Local.css';
import type { TexMark } from './marks';
import { registerOverlay } from './overlays';
import type { Vec } from './params';

export const tex = (at: Vec, source: string, o: Omit<TexMark, 'type' | 'at' | 'tex'> = {}): TexMark => ({ type: 'tex', at, tex: source, ...o });

registerOverlay('tex', {
  look: (m) => {
    const t = m as TexMark;
    return JSON.stringify([t.tex, t.size, t.display]);
  },
  render: (m) => {
    const t = m as TexMark;
    const el = document.createElement('div');
    el.className = 'viz-tex';
    el.style.fontSize = `${t.size ?? 18}px`;
    el.innerHTML = temml.renderToString(t.tex, {
      displayMode: t.display ?? true,
      throwOnError: false,
      trust: (c: { command: string }) => c.command === '\\class',
    });
    return el;
  },
});
