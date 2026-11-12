# vizint

Interactive visualizations, each between a short text before and after it, as a static site: the `vizint` view
(`plugins/vizint`) over the decks of the plugins in `distribution.yml`. Which viz is shown, and in what state, is in
the URL's hash. New visualizations are made in [vizint-workshop](../vizint-workshop); what one is made of is
[`@gestalts/viz`](../../packages/viz).

From the repo root: `mise run vizint:dev` (:5178, hot reload), `mise run vizint:build` (static files in `dist/`).
