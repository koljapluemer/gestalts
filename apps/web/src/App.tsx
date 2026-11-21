import { Learn } from './learn/Learn';
import { Make } from './make/Make';
import { Make as MakeViz } from './make-viz/Make';
import { Notes } from './notes/Notes';
import { HomeProvider } from './home';
import { useArea } from './router';
import { Teach } from './teach/App';
import { Viz } from './viz/Viz';

/**
 * The one app: each area is a path. Notes, learning and visualizations share the home store (opened once, kept open);
 * the workshops share their drafts; each lesson draft is its own store, synced with the teacher server.
 */
export function App() {
  const area = useArea();
  return (
    <HomeProvider>
      {area === '/notes' && <Notes />}
      {area === '/learn' && <Learn />}
      {area === '/viz' && <Viz />}
      {area === '/make' && <Make />}
      {area === '/make-viz' && <MakeViz />}
      {area === '/teach' && <Teach />}
    </HomeProvider>
  );
}
