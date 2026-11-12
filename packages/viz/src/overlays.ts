/**
 * Marks drawn as HTML over a panel's canvas (`tex`), rendered by a module the viz imports, so a viz without them
 * doesn't carry their code. The runtime positions the element at the mark's `at` and reuses it while it looks the same.
 */
import type { Mark } from './marks';

export type Overlay = {
  /** the element for a mark; called again only when `look` changes */
  render: (m: Mark) => HTMLElement;
  /** what decides whether the element can be reused */
  look: (m: Mark) => string;
};

const overlays = new Map<string, Overlay>();

export function registerOverlay(type: Mark['type'], o: Overlay): void {
  overlays.set(type, o);
}

export const overlayFor = (type: Mark['type']): Overlay | undefined => overlays.get(type);
