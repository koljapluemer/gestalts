import { LlmSettings } from './LlmSettings';
import { Settings } from './Settings';

/** gestalts-node's own page: what the node does for the apps that use it. */
export function App() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">gestalts-node</h1>
        <p className="text-sm text-base-content/70">Keeps your ymls in a folder on this computer, syncs them with your
          paired devices and runs plugin workers, for the apps you use it with.</p>
      </header>
      <Settings />
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">LLM providers</h2>
        <LlmSettings />
      </section>
    </main>
  );
}
