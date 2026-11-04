import { definePane } from '@gestalts/sdk';
import { GreekAlphabet } from './GreekAlphabet';

/** The letters of the deck, practised by FSRS. */
export const PracticePane = definePane({
  title: 'Greek alphabet',
  Component: () => (
    <div className="h-full overflow-y-auto px-4 py-8">
      <GreekAlphabet deckTag="greek-alphabet" />
    </div>
  ),
});
