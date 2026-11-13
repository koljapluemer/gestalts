# gestalter

A personal learning and note-taking app: views as tabs, with the note views always there and others installable. A
static website (`distribution/`) on the gestalts-node on your computer ([`../node`](../node/doc/desktop.md)), whose
folder holds your notes; it opens offline once loaded (`public/sw.js`). On Android it's the page the app wraps
(`distribution-android/`, [`../node/doc/android.md`](../node/doc/android.md)).

From the repo root: `mise run gestalter:dev` (gestalter with hot reload on a dev node), `mise run gestalter:build`
(the static site in `distribution/dist`, deployed to gestalter.koljasam.com by `mise run deploy`; its origin is in the node's `ORIGINS`),
`mise run android:dev`.
