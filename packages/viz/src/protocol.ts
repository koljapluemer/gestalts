/**
 * What a built viz and the page around it say to each other with postMessage. Up (from the viz): every message has
 * `source: 'viz'`. Down: the page sends `theme` and `params`. A viz needs none of it to run on its own.
 */

export type Up =
  | { source: 'viz'; type: 'ready' }
  /** the document's height in px; the page sizes the frame to it */
  | { source: 'viz'; type: 'resize'; height: number }
  | { source: 'viz'; type: 'error'; message: string }
  /** the params someone set, encoded, only those differing from the defaults */
  | { source: 'viz'; type: 'params'; params: Record<string, string> };

export type Down =
  | { type: 'theme'; mode: 'light' | 'dark' }
  | { type: 'params'; params: Record<string, string> };

/** Marks a page as a built viz; the check looks for it. */
export const MARKER = 'data-gestalts-viz';
