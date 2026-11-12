import { Learn } from './app/Learn';

export function App() {
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <span className="font-semibold">Loops for learning</span>
      </header>
      <div className="min-h-0 flex-1"><Learn /></div>
    </div>
  );
}
