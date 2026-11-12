let's add a view (both to core gestalter and to loops-for-learning) for generic SR flashcard practice, and one neat single-screen view (for now optional gestalter only) to CRUD manage these flashcards.
Flashcards are their own gestalt, with the primary props of md-rendered `front` and `back`.
They have 0 or 1 attached fsrs-data ymls attached.

Currently, `concept` has a practiced-by prop (I think it's called that). Let's get rid of that, and instead map it reverse, flashcards (as well as more bespoke types, as I believe we are using for alphabet practice, although worth thinking about migrating that to flashcards as well, no?) can have a prop `concepts`, where they link to concepts with a float from 0 to 1.

This float for now is a generic modifier signifying "how much" this flashcad practices this concept.
We will use this as follows: Concepts then may have a list of concept-practice-event ymls, which have an origin note (e.g. a flashcard), a timestamp and an int from the set [-2, -1, 0, 1, 2]. 
This can then be used to log stuff like "was practiced and the user did extremely well/rated it easy" (rating 2) or "this concept came up without any score attached" (rating 0).
Later then (not yet implemented), we can then hopefully build predictive models based on a Bayesian interpretation of these events.

For the flashcard view, do the platonic SR flow (show front+reveal, after reveal also show back and score buttons). Prefer a due seen flashcard over a new one stochastically 90% of the time.

Feel free to add optional other props to flashcards also, I think image attachment for front and back makes sense, tags definitely, aliases[] also in case we want to internalyl ref the flashcad somehow...maybe I'm missing something.
