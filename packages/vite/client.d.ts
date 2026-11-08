/** `"types": ["@gestalts/vite/client"]` in an app's tsconfig. */
declare module 'virtual:gestalts-plugins' {
  export const registry: import('@gestalts/host').Registry;
}
