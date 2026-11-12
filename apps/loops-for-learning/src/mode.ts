export type Mode = 'learn' | 'make';

const MODE = 'loops:mode';

export function initialMode(): Mode {
  try {
    return localStorage.getItem(MODE) === 'make' ? 'make' : 'learn';
  } catch {
    return 'learn';
  }
}

export function rememberMode(mode: Mode): void {
  try { localStorage.setItem(MODE, mode); } catch { /* not remembered */ }
}
