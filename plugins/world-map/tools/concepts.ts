// The rule every deck builder touching a country's place shares (world-map's, flags-practice's), so decks holding one
// country's concept hold the same yml: its id comes from its code in the map's geometry (Natural Earth's `adm0_a3`),
// so renaming a country keeps its id, and its name from that geometry's name.
import { createHash } from 'node:crypto';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** the id of the concept "where this country is", by its code in the map's geometry */
export const geographyConcept = (code: string) => `concept-${sha(`geography:${code}`)}`;
/** that concept's name, from the geometry's name for the country */
export const geographyName = (name: string) => `geography: ${name}`;

/** the set every country's place is `in`: a concept counting the countries known, never evidence about them */
export const COUNTRIES = { id: `concept-${sha('geography: countries')}`, gestalt: 'concept@2', name: 'geography: countries' };
/** the concept "where this country is", as every deck holding it writes it: a `concept@3` `in` {@link COUNTRIES} */
export const geographyYml = (code: string, name: string) => ({ id: geographyConcept(code), gestalt: 'concept@3', name: geographyName(name), in: COUNTRIES.id });
