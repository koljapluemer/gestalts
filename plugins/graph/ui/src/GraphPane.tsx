import { useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Pin } from 'lucide-react';
import { definePane, definePerspective, type Query } from '@gestalts/sdk';
import { SearchLayout } from '@gestalts/kit';
import { GraphCanvas } from './GraphCanvas';
import { SCOPE } from './graph';
import { SEARCH_PIN_DEPTH, useGraph } from './useGraph';

/**
 * Pinned notes and their relationships on a canvas, with the search beside it: a result's pin button pins it (with two
 * hops around it), and while the search filters, the toolbar can pin one of its results at random or all of them.
 */
const Graph = definePerspective<{ notes: Query }>({
  id: 'graph',
  title: 'Graph',
  data: { notes: SCOPE },
  Component: ({ data, repo }) => {
    const g = useGraph(repo, data.notes);
    const [results, setResults] = useState<string[] | null>(null);
    return (
      <SearchLayout openKeys={[...g.pins.keys()]} onResults={setResults} actions={[{
        icon: <Pin className="size-3.5" />,
        title: 'Pin on the graph',
        run: (key) => g.pin(key, SEARCH_PIN_DEPTH),
        applies: (n) => g.view.notes.has(n.key),
      }]}>
        <div className="relative h-full min-h-[24rem] w-full">
          <ReactFlowProvider>
            <GraphCanvas repo={repo} g={g} searchResults={results} />
          </ReactFlowProvider>
        </div>
      </SearchLayout>
    );
  },
});

export const GraphPane = definePane({ title: 'Graph', Component: () => <Graph /> });
