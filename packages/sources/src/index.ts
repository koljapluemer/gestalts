/**
 * Bibliographic sources for views (`@gestalts/sources`): the biblatex model of `source@1`, BibTeX in and out, finding
 * the existing source a pasted one may be, and merging a source with a newer version of it. Pure: no data access.
 */
export {
  DATE_RE, ENTRY_TYPES, FIELD_NAMES, FIELDS, KEY_RE, ValidationError, bareDoi, bibOf, isEntryType, isbn13, joinName, normalise, slug,
  splitName, uniqueKey, type Bib, type EntryType, type FieldName, type FieldType, type FieldValue, type NameParts,
} from './fields';
export { bibtexName, convert, decodeLatex, parseBibtex, readEntries, type RawEntry } from './bibtex-import';
export { BIB_HEADER, escapeLatex, renderBibtex, renderEntry } from './bibtex-export';
export {
  LEVELS, compare, doiKey, eprintKey, families, fold, isbnKey, match, ratio, titleSimilarity, titleWords, urlKey, year,
  type Candidate, type Comparable, type Level,
} from './match';
export { mergeSource, type MergeConflict, type MergeResult } from './merge';
