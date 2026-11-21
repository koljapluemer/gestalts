import { AREAS, AreaLink } from './router';

/** Where to go: a card per area. */
export function Landing() {
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-6 text-2xl font-semibold">gestalts</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {AREAS.map((a) => (
          <AreaLink key={a.path} path={a.path} className="card card-border bg-base-100 transition hover:bg-base-200">
            <div className="card-body">
              <h2 className="card-title">{a.title}</h2>
              <p className="text-base-content/70">{a.about}</p>
            </div>
          </AreaLink>
        ))}
      </div>
    </main>
  );
}
