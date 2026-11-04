import { definePane, useHost } from '@gestalts/sdk';
import { SearchLayout } from '@gestalts/kit';
import { Learn } from './Learn';

/** The flashcards of every note by spaced repetition; a card's note opens in the host's editor. */
export const LearnPane = definePane({
  title: 'Learn',
  Component: () => {
    const host = useHost();
    return (
      <SearchLayout>
        <div className="h-full overflow-y-auto px-4 py-8">
          <Learn onOpen={host.openNote} />
        </div>
      </SearchLayout>
    );
  },
});
