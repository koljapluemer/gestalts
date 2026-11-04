declare module 'virtual:gestalts-plugins' {
  import type { Distribution, PluginEntry } from '@gestalts/ui/host';

  /** this app's `distribution.yml` */
  export const distribution: Distribution;
  /** its `@gestalts-plugin/*` dependencies, built in (see `@gestalts/vite`) */
  export const plugins: PluginEntry[];
}
