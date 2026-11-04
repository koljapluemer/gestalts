//! Bibliographic sources (`source@1`) and BibTeX: reading `.bib` text into sources, writing sources as biblatex,
//! finding which existing source an entry probably is, merging an entry into a source, and the keys a Typst
//! document cites.
//!
//! A source is a note's map (`title`, `citekey`, `entrytype`, the biblatex fields, `bib_extra`). Values are plain
//! text: LaTeX is decoded on reading, except that braces are kept where BibTeX protects case (`{NASA}`), and
//! math as `$…$`. Fields this model has no place for are kept in `bib_extra` and written back.

use std::collections::{BTreeMap, BTreeSet};

use biblatex::{Bibliography, Chunk, ChunksExt, EntryType, Person, Spanned};
use serde::Serialize;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

/// Entry types and the fields shown for each by default (anything else is added on demand).
pub const ENTRY_TYPES: &[(&str, &[&str])] = &[
    ("article", &["author", "journaltitle", "date", "volume", "number", "pages", "doi", "url", "urldate"]),
    ("book", &["author", "date", "edition", "volume", "series", "publisher", "location", "isbn", "doi", "url"]),
    ("incollection", &["author", "booktitle", "editor", "date", "publisher", "location", "pages", "doi", "url"]),
    ("inproceedings", &["author", "booktitle", "editor", "date", "publisher", "location", "pages", "doi", "url"]),
    ("thesis", &["author", "type", "institution", "date", "location", "doi", "url", "urldate"]),
    ("report", &["author", "type", "number", "institution", "date", "location", "url", "urldate"]),
    ("online", &["author", "date", "organization", "url", "urldate"]),
    ("software", &["author", "date", "version", "publisher", "doi", "url", "urldate"]),
    ("misc", &["author", "date", "type", "url", "urldate"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    /// a list of names: `family, given`, `family, suffix, given`, or one name without a comma
    Names,
    /// a list of strings
    List,
    /// `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a range `a/b`
    Date,
    /// written as it is (urls, identifiers)
    Verbatim,
    Literal,
}

/// The biblatex fields of a source, in the order they're shown and written.
pub const FIELDS: &[(&str, FieldKind)] = &[
    ("author", FieldKind::Names),
    ("editor", FieldKind::Names),
    ("date", FieldKind::Date),
    ("urldate", FieldKind::Date),
    ("journaltitle", FieldKind::Literal),
    ("booktitle", FieldKind::Literal),
    ("series", FieldKind::Literal),
    ("type", FieldKind::Literal),
    ("number", FieldKind::Literal),
    ("volume", FieldKind::Literal),
    ("edition", FieldKind::Literal),
    ("version", FieldKind::Literal),
    ("pages", FieldKind::Literal),
    ("publisher", FieldKind::List),
    ("institution", FieldKind::List),
    ("organization", FieldKind::List),
    ("location", FieldKind::List),
    ("doi", FieldKind::Verbatim),
    ("isbn", FieldKind::Verbatim),
    ("eprint", FieldKind::Verbatim),
    ("eprinttype", FieldKind::Literal),
    ("url", FieldKind::Verbatim),
];

pub const EXTRA: &str = "bib_extra";

fn kind(field: &str) -> Option<FieldKind> {
    FIELDS.iter().find(|(f, _)| *f == field).map(|(_, k)| *k)
}

/// legacy BibTeX type -> (biblatex type, a `type` it implies)
const TYPE_ALIASES: &[(&str, &str, Option<&str>)] = &[
    ("conference", "inproceedings", None),
    ("electronic", "online", None),
    ("www", "online", None),
    ("phdthesis", "thesis", Some("phdthesis")),
    ("mastersthesis", "thesis", Some("mathesis")),
    ("techreport", "report", Some("techreport")),
];

/// legacy BibTeX field -> biblatex field
const FIELD_ALIASES: &[(&str, &str)] =
    &[("journal", "journaltitle"), ("address", "location"), ("school", "institution"), ("archiveprefix", "eprinttype")];

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// --- reading ---------------------------------------------------------------------------------------------------

/// A source read from BibTeX, and what couldn't be read into the model.
#[derive(Debug, Clone, Serialize)]
pub struct Parsed {
    pub source: Map<String, Value>,
    pub warnings: Vec<String>,
}

/// The entries of a `.bib` text as sources. An error when it holds none, or doesn't parse.
pub fn parse(text: &str) -> Result<Vec<Parsed>, String> {
    let bib = Bibliography::parse(text).map_err(|e| format!("not BibTeX: {e}"))?;
    let out: Vec<_> = bib.iter().map(convert).collect();
    if out.is_empty() {
        return Err("no BibTeX entries found".into());
    }
    Ok(out)
}

fn convert(entry: &biblatex::Entry) -> Parsed {
    let mut warnings = Vec::new();
    let mut source = Map::new();
    let key: String = entry.key.chars().map(|c| if is_key_char(c) { c } else { '_' }).collect();
    let raw_type = match &entry.entry_type {
        EntryType::Unknown(t) => t.to_lowercase(),
        t => t.to_string(),
    };
    let (mut entrytype, implied) = TYPE_ALIASES
        .iter()
        .find(|(from, _, _)| *from == raw_type)
        .map(|(_, to, implied)| (to.to_string(), *implied))
        .unwrap_or((raw_type.clone(), None));
    if !ENTRY_TYPES.iter().any(|(t, _)| *t == entrytype) {
        warnings.push(format!("entry type `{entrytype}` read as misc"));
        entrytype = "misc".into();
    }

    let mut fields: BTreeMap<String, &[Spanned<Chunk>]> = BTreeMap::new();
    for (name, chunks) in &entry.fields {
        let name = name.to_lowercase();
        let name = FIELD_ALIASES.iter().find(|(from, _)| *from == name).map_or(name.clone(), |(_, to)| to.to_string());
        fields.insert(name, chunks);
    }

    if let Some(title) = fields.remove("title") {
        source.insert("title".into(), Value::String(text_of(title)));
    }
    source.insert("citekey".into(), Value::String(if key.is_empty() { "source".into() } else { key }));
    source.insert("entrytype".into(), Value::String(entrytype));

    let year = fields.remove("year").map(text_of);
    let month = fields.remove("month").map(text_of);
    if !fields.contains_key("date")
        && let Some(year) = year
    {
        let month = month.as_deref().and_then(month_number);
        let date = match month {
            Some(m) if year.len() == 4 && year.bytes().all(|c| c.is_ascii_digit()) => format!("{year}-{m:02}"),
            _ => year,
        };
        source.insert("date".into(), Value::String(date));
    }
    if let Some(t) = implied {
        source.insert("type".into(), Value::String(t.into()));
    }
    // howpublished holding only a URL is really the URL
    if !fields.contains_key("url")
        && let Some(url) = fields.get("howpublished").map(|c| text_of(c)).and_then(|h| url_only(&h))
    {
        fields.remove("howpublished");
        source.insert("url".into(), Value::String(url));
    }

    let mut extra = Map::new();
    for (name, chunks) in fields {
        let value = match kind(&name) {
            Some(FieldKind::Names) => match chunks.parse::<Vec<Person>>() {
                Ok(people) => Value::Array(people.iter().map(|p| Value::String(join_name(p))).collect()),
                Err(e) => {
                    warnings.push(format!("{name}: {e}"));
                    continue;
                }
            },
            Some(FieldKind::List) => {
                Value::Array(split_and(&text_of(chunks)).into_iter().map(Value::String).collect())
            }
            Some(FieldKind::Date) => {
                let d = text_of(chunks);
                if !crate::gestalt::is_partial_date_range(&d) {
                    warnings.push(format!("{name}: `{d}` isn't a date, kept in {EXTRA}"));
                    extra.insert(name, Value::String(d));
                    continue;
                }
                Value::String(d)
            }
            Some(FieldKind::Verbatim) => Value::String(chunks.format_verbatim()),
            Some(FieldKind::Literal) => Value::String(text_of(chunks)),
            None => {
                extra.insert(name, Value::String(text_of(chunks)));
                continue;
            }
        };
        if source.contains_key(&name) {
            continue; // `type` implied by the entry type, `url` from howpublished: the explicit field wins below
        }
        source.insert(name, value);
    }
    if !extra.is_empty() {
        source.insert(EXTRA.into(), Value::Object(extra));
    }
    Parsed { source, warnings }
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_:.-/+".contains(c)
}

/// The chunks as plain text: protected parts in braces, math in dollars.
fn text_of(chunks: &[Spanned<Chunk>]) -> String {
    let mut s = String::new();
    for c in chunks {
        match &c.v {
            Chunk::Normal(t) => s.push_str(t),
            Chunk::Verbatim(t) => {
                s.push('{');
                s.push_str(t);
                s.push('}');
            }
            Chunk::Math(t) => {
                s.push('$');
                s.push_str(t);
                s.push('$');
            }
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn month_number(m: &str) -> Option<u32> {
    let m = m.trim().to_lowercase();
    if let Ok(n) = m.parse::<u32>() {
        return (1..=12).contains(&n).then_some(n);
    }
    MONTHS.iter().position(|x| m.starts_with(x)).map(|i| i as u32 + 1)
}

fn url_only(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s.strip_prefix("\\url{").and_then(|r| r.strip_suffix('}')).unwrap_or(s);
    let s = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')).unwrap_or(s);
    ((s.starts_with("http://") || s.starts_with("https://")) && !s.contains(char::is_whitespace)).then(|| s.to_owned())
}

fn split_and(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut current = String::new();
    let words: Vec<&str> = s.split(' ').collect();
    for (i, w) in words.iter().enumerate() {
        if depth == 0 && *w == "and" && i > 0 {
            out.push(std::mem::take(&mut current));
            continue;
        }
        depth += w.matches('{').count() as i32 - w.matches('}').count() as i32;
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(w);
    }
    out.push(current);
    out.into_iter().map(|s| unwrap_group(s.trim()).to_owned()).filter(|s| !s.is_empty()).collect()
}

/// `{Smith and Sons}` (braced only so BibTeX doesn't split it) as `Smith and Sons`.
fn unwrap_group(s: &str) -> &str {
    let Some(inner) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) else { return s };
    let mut depth = 0;
    for c in inner.chars() {
        depth += match c {
            '{' => 1,
            '}' => -1,
            _ => 0,
        };
        if depth < 0 {
            return s;
        }
    }
    if depth == 0 { inner } else { s }
}

/// `family, given` (the prefix part of the family), `family, suffix, given`, or the family alone.
fn join_name(p: &Person) -> String {
    let family = [p.prefix.trim(), p.name.trim()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let given = p.given_name.trim();
    if family.is_empty() || given.is_empty() {
        return if family.is_empty() { given.into() } else { family };
    }
    if p.suffix.trim().is_empty() { format!("{family}, {given}") } else { format!("{family}, {}, {given}", p.suffix.trim()) }
}

// --- writing ---------------------------------------------------------------------------------------------------

/// Sources as biblatex, sorted by citekey. Text is UTF-8; `& % # _` are escaped outside verbatim fields.
pub fn write(sources: &[Map<String, Value>]) -> String {
    let mut sorted: Vec<_> = sources.iter().collect();
    sorted.sort_by_key(|s| str_of(s, "citekey").unwrap_or_default());
    let mut out = String::new();
    for s in sorted {
        let Some(key) = str_of(s, "citekey") else { continue };
        let entrytype = str_of(s, "entrytype").unwrap_or_else(|| "misc".into());
        out.push_str(&format!("@{entrytype}{{{key},\n"));
        let mut field = |name: &str, value: String| out.push_str(&format!("  {name} = {{{value}}},\n"));
        if let Some(t) = str_of(s, "title") {
            field("title", escape(&t));
        }
        for (name, kind) in FIELDS {
            let Some(v) = s.get(*name).filter(|v| !v.is_null()) else { continue };
            let value = match kind {
                FieldKind::Names => strings(v).iter().map(|n| write_name(n)).collect::<Vec<_>>().join(" and "),
                FieldKind::List => strings(v).iter().map(|x| protect(&escape(x))).collect::<Vec<_>>().join(" and "),
                FieldKind::Verbatim => scalar(v),
                FieldKind::Date | FieldKind::Literal => escape(&scalar(v)),
            };
            field(name, value);
        }
        if let Some(Value::Object(extra)) = s.get(EXTRA) {
            for (name, v) in extra {
                field(name, scalar(v));
            }
        }
        out.push_str("}\n\n");
    }
    out
}

fn str_of(s: &Map<String, Value>, field: &str) -> Option<String> {
    s.get(field).map(scalar).filter(|v| !v.is_empty())
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn strings(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().map(scalar).filter(|s| !s.is_empty()).collect(),
        other => vec![scalar(other)],
    }
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev = '\0';
    for c in s.chars() {
        if matches!(c, '&' | '%' | '#' | '_') && prev != '\\' {
            out.push('\\');
        }
        out.push(c);
        prev = c;
    }
    out
}

/// A name or list item BibTeX would otherwise split, in braces.
fn protect(s: &str) -> String {
    let splits = s.contains(',') || s.split_whitespace().any(|w| w.eq_ignore_ascii_case("and"));
    if splits { format!("{{{s}}}") } else { s.to_owned() }
}

fn write_name(name: &str) -> String {
    let parts: Vec<&str> = name.split(',').map(str::trim).collect();
    match parts.as_slice() {
        // one name never split: an organisation
        [one] => {
            if one.contains(' ') { format!("{{{}}}", escape(one)) } else { protect(&escape(one)) }
        }
        parts => parts.iter().map(|p| protect(&escape(p))).collect::<Vec<_>>().join(", "),
    }
}

// --- matching --------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Same,
    Likely,
    Possible,
}

#[derive(Debug, Clone, Serialize)]
pub struct Match {
    /// the note key of the existing source
    pub key: String,
    pub level: Level,
    pub reasons: Vec<String>,
}

/// The sources that may be `entry`, best first, at most `limit`. A shared DOI, ISBN or eprint decides; without one,
/// title, first author and year are compared loosely (a shortened title or one without its subtitle, a year off by
/// one); a field missing on either side counts neither way.
pub fn matches(entry: &Map<String, Value>, sources: &[(String, Map<String, Value>)], limit: usize) -> Vec<Match> {
    let mut found: Vec<(Match, f64)> = sources
        .iter()
        .filter_map(|(key, other)| compare(entry, other).map(|(level, reasons, score)| (Match { key: key.clone(), level, reasons }, score)))
        .collect();
    found.sort_by(|a, b| a.0.level.cmp(&b.0.level).then(b.1.total_cmp(&a.1)));
    found.into_iter().take(limit).map(|(m, _)| m).collect()
}

fn compare(entry: &Map<String, Value>, other: &Map<String, Value>) -> Option<(Level, Vec<String>, f64)> {
    let mut reasons = Vec::new();
    let mut conflict = false;
    type Id = fn(&Map<String, Value>) -> String;
    let ids: [(&str, Id); 3] =
        [("DOI", |s| norm_doi(&field(s, "doi"))), ("ISBN", |s| norm_isbn(&field(s, "isbn"))), ("eprint", norm_eprint)];
    for (label, get) in ids {
        let (a, b) = (get(entry), get(other));
        if !a.is_empty() && !b.is_empty() {
            if a == b {
                return Some((Level::Same, vec![label.into()], 1.0));
            }
            conflict = true;
            reasons.push(format!("≠{label}"));
        }
    }
    let (ta, tb) = (field(entry, "title"), field(other, "title"));
    let score = title_similarity(&ta, &tb);
    let (fa, fb) = (families(entry), families(other));
    let first = fa.is_empty() || fb.is_empty() || fa[0] == fb[0];
    let overlap = fa.iter().any(|f| fb.contains(f));
    let (ya, yb) = (year(entry), year(other));
    let near = match (ya, yb) {
        (Some(a), Some(b)) => a.abs_diff(b) <= 1,
        _ => true,
    };
    let ua = norm_url(&field(entry, "url"));
    let same_url = !ua.is_empty() && ua == norm_url(&field(other, "url"));

    if score >= 0.75 {
        reasons.push(format!("title {}%", (score * 100.0).round()));
    }
    if !fa.is_empty() && !fb.is_empty() && (first || overlap) {
        reasons.push("author".into());
    }
    if let (Some(a), Some(b)) = (ya, yb)
        && a != b
    {
        reasons.push(format!("{a}≠{b}"));
    }
    if same_url {
        reasons.insert(0, "URL".into());
    }
    let mut level = if fold(&ta) == fold(&tb) && !fa.is_empty() && !fb.is_empty() && fa[0] == fb[0] && ya.is_some() && ya == yb {
        Level::Same
    } else if same_url || (score >= 0.9 && first && near) {
        Level::Likely
    } else if score >= 0.75 {
        Level::Possible
    } else {
        return None;
    };
    if conflict {
        level = Level::Possible;
    }
    Some((level, reasons, score))
}

fn field(s: &Map<String, Value>, name: &str) -> String {
    s.get(name).map(scalar).unwrap_or_default()
}

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with", "der", "die", "das",
    "ein", "eine", "und", "von", "zu", "im", "mit", "fur", "auf", "uber", "le", "la", "les", "un", "une", "des", "du", "et", "en",
];

/// Lowercase words without accents or punctuation, single-spaced.
pub fn fold(s: &str) -> String {
    let plain: String = s.nfkd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect::<String>().to_lowercase();
    plain.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

fn norm_doi(v: &str) -> String {
    let s = v.trim().to_lowercase();
    let s = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(&s);
    let s = s.strip_prefix("dx.").unwrap_or(s);
    let s = s.strip_prefix("doi.org/").unwrap_or(s);
    let s = s.strip_prefix("doi:").unwrap_or(s);
    s.trim().to_owned()
}

/// ISBN-13 digits; an ISBN-10 is converted.
fn norm_isbn(v: &str) -> String {
    let mut s: String = v.to_uppercase().chars().filter(|c| c.is_ascii_digit() || *c == 'X').collect();
    if s.len() == 10 {
        s = format!("978{}", &s[..9]);
        let sum: u32 = s.chars().enumerate().map(|(i, d)| d.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 }).sum();
        s.push(char::from_digit((10 - sum % 10) % 10, 10).unwrap());
    }
    if s.len() == 13 && s.bytes().all(|c| c.is_ascii_digit()) { s } else { String::new() }
}

fn norm_eprint(s: &Map<String, Value>) -> String {
    let e = field(s, "eprint").trim().to_lowercase();
    if e.is_empty() {
        return e;
    }
    let e = e.strip_prefix("arxiv:").unwrap_or(&e);
    let e = match e.rfind('v') {
        Some(i) if i + 1 < e.len() && e[i + 1..].bytes().all(|c| c.is_ascii_digit()) => &e[..i],
        _ => e,
    };
    let ty = field(s, "eprinttype").trim().to_lowercase();
    format!("{}:{e}", if ty.is_empty() { "arxiv" } else { &ty })
}

fn norm_url(v: &str) -> String {
    let s = v.trim().to_lowercase();
    let s = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(&s);
    let s = s.split('#').next().unwrap_or("");
    s.strip_prefix("www.").unwrap_or(s).trim_end_matches('/').to_owned()
}

/// The title before its subtitle.
fn main_title(t: &str) -> &str {
    let mut end = t.len();
    for pat in [":", " - ", " – ", " — ", ". "] {
        if let Some(i) = t.find(pat) {
            end = end.min(i);
        }
    }
    &t[..end]
}

fn title_similarity(a: &str, b: &str) -> f64 {
    let (fa, fb) = (fold(a), fold(b));
    if fa.is_empty() || fb.is_empty() {
        return 0.0;
    }
    let mut best = ratio(&fa, &fb).max(ratio(&fold(main_title(a)), &fold(main_title(b))));
    let words = |s: &str| s.split(' ').filter(|w| !STOPWORDS.contains(w)).map(str::to_owned).collect::<BTreeSet<_>>();
    let (wa, wb) = (words(&fa), words(&fb));
    let (short, long) = if wa.len() <= wb.len() { (&wa, &wb) } else { (&wb, &wa) };
    if short.len() >= 2 && short.is_subset(long) {
        best = best.max(0.95);
    }
    best
}

/// difflib's `SequenceMatcher.ratio`: twice the matched characters (longest common blocks, recursively) over both lengths.
fn ratio(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    fn matched(a: &[char], b: &[char]) -> usize {
        let (mut best, mut at_a, mut at_b) = (0, 0, 0);
        let mut prev = vec![0usize; b.len() + 1];
        for (i, ca) in a.iter().enumerate() {
            let mut row = vec![0usize; b.len() + 1];
            for (j, cb) in b.iter().enumerate() {
                if ca == cb {
                    row[j + 1] = prev[j] + 1;
                    if row[j + 1] > best {
                        (best, at_a, at_b) = (row[j + 1], i + 1 - row[j + 1], j + 1 - row[j + 1]);
                    }
                }
            }
            prev = row;
        }
        if best == 0 {
            return 0;
        }
        best + matched(&a[..at_a], &b[..at_b]) + matched(&a[at_a + best..], &b[at_b + best..])
    }
    2.0 * matched(&a, &b) as f64 / (a.len() + b.len()) as f64
}

/// The folded family names of the authors, else the editors, without `others`.
fn families(s: &Map<String, Value>) -> Vec<String> {
    let names = s.get("author").map(strings).filter(|v| !v.is_empty()).or_else(|| s.get("editor").map(strings)).unwrap_or_default();
    names
        .iter()
        .filter_map(|name| {
            let family = if let Some((family, _)) = name.split_once(',') {
                let mut words: Vec<&str> = family.split_whitespace().collect();
                while words.len() > 1 && words[0].starts_with(char::is_lowercase) {
                    words.remove(0);
                }
                fold(&words.join(" "))
            } else {
                fold(name).rsplit(' ').next().unwrap_or("").to_owned()
            };
            (!family.is_empty() && family != "others").then_some(family)
        })
        .collect()
}

fn year(s: &Map<String, Value>) -> Option<u32> {
    let d = field(s, "date");
    d.get(..4).filter(|y| y.bytes().all(|c| c.is_ascii_digit())).and_then(|y| y.parse().ok())
}

// --- merging ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Conflict {
    pub field: String,
    pub current: Value,
    pub incoming: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct Merged {
    pub source: Map<String, Value>,
    /// fields the source lacked, filled in
    pub filled: Vec<String>,
    /// fields it has otherwise, not in `take`
    pub conflicts: Vec<Conflict>,
}

/// `current` updated from `incoming` (as read from BibTeX): every field it lacks filled in, every one it has
/// otherwise replaced when named in `take` (else listed as a conflict). `entrytype: misc` counts as none. Other
/// keys of `current` (the note's own) stay. `bib_extra` merges per field, as `bib_extra.<field>`.
pub fn merge(current: &Map<String, Value>, incoming: &Map<String, Value>, take: &[String]) -> Merged {
    let mut source = current.clone();
    let (mut filled, mut conflicts) = (Vec::new(), Vec::new());
    let present = |v: Option<&Value>| v.is_some_and(|v| !v.is_null() && v != &Value::String(String::new()) && v != &Value::Array(vec![]));
    let mut apply = |name: String, cur: Option<&Value>, new: &Value, set: &mut dyn FnMut(Value)| {
        let cur = cur.filter(|v| present(Some(v)) && !(name == "entrytype" && *v == "misc"));
        if (name == "entrytype" && new == "misc") || cur == Some(new) {
            return;
        }
        match cur {
            None => filled.push(name),
            Some(c) if !take.contains(&name) => {
                conflicts.push(Conflict { field: name, current: c.clone(), incoming: new.clone() });
                return;
            }
            Some(_) => {}
        }
        set(new.clone());
    };
    for name in ["title", "citekey", "entrytype"].into_iter().chain(FIELDS.iter().map(|(f, _)| *f)) {
        if let Some(new) = incoming.get(name).filter(|v| present(Some(v))) {
            let cur = current.get(name).cloned();
            apply(name.to_owned(), cur.as_ref(), new, &mut |v| {
                source.insert(name.to_owned(), v);
            });
        }
    }
    if let Some(Value::Object(extra)) = incoming.get(EXTRA) {
        let mut merged = match current.get(EXTRA) {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let before = merged.clone();
        for (k, new) in extra {
            apply(format!("{EXTRA}.{k}"), before.get(k), new, &mut |v| {
                merged.insert(k.clone(), v);
            });
        }
        if !merged.is_empty() {
            source.insert(EXTRA.into(), Value::Object(merged));
        }
    }
    Merged { source, filled, conflicts }
}

/// `key`, or `key-2`, `key-3`, … when another source has it.
pub fn unique_citekey(key: &str, taken: &BTreeSet<String>) -> String {
    if !taken.contains(key) {
        return key.to_owned();
    }
    (2..).map(|n| format!("{key}-{n}")).find(|k| !taken.contains(k)).unwrap()
}

// --- citations in Typst ----------------------------------------------------------------------------------------

/// The keys a Typst document cites (`@key`, `#cite(<key>)`, `#cite(label("key"))`), each once, in order. Strings
/// and comments are skipped, roughly; a key found where it isn't a citation only matters when a source has it.
pub fn cited_keys(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut found: Vec<(usize, String)> = Vec::new();
    let mut blank = vec![false; n];
    let at = |i: usize, s: &str| s.chars().enumerate().all(|(k, c)| chars.get(i + k) == Some(&c));
    let skip_ws = |mut i: usize| {
        while i < n && chars[i].is_whitespace() {
            i += 1;
        }
        i
    };
    let mut i = 0;
    while i < n {
        if at(i, "cite(") {
            let j = skip_ws(i + 5);
            if at(j, "label(") {
                let k = skip_ws(j + 6);
                if chars.get(k) == Some(&'"') {
                    let end = (k + 1..n).find(|&e| chars[e] == '"' || chars[e] == '\n' || chars[e] == '\\');
                    if let Some(e) = end.filter(|&e| chars[e] == '"') {
                        found.push((i, chars[k + 1..e].iter().collect()));
                        blank[i..=e].iter_mut().for_each(|b| *b = true);
                        i = e + 1;
                        continue;
                    }
                }
            }
        }
        match chars[i] {
            '"' => {
                let mut e = i + 1;
                while e < n && chars[e] != '"' && chars[e] != '\n' {
                    e += if chars[e] == '\\' { 2 } else { 1 };
                }
                if e < n && chars[e] == '"' {
                    blank[i..=e].iter_mut().for_each(|b| *b = true);
                    i = e + 1;
                    continue;
                }
            }
            '/' if at(i, "/*") => {
                let e = (i + 2..n.saturating_sub(1)).find(|&e| at(e, "*/")).map_or(n, |e| e + 2);
                blank[i..e].iter_mut().for_each(|b| *b = true);
                i = e;
                continue;
            }
            '/' if at(i, "//") => {
                let e = (i..n).find(|&e| chars[e] == '\n').unwrap_or(n);
                blank[i..e].iter_mut().for_each(|b| *b = true);
                i = e;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut refs: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    while i < n {
        if blank[i] {
            i += 1;
            continue;
        }
        if chars[i] == '@' && (i == 0 || (!word(chars[i - 1]) && chars[i - 1] != '@')) {
            let mut e = i + 1;
            while e < n && !blank[e] && (word(chars[e]) || "-.:".contains(chars[e])) {
                e += 1;
            }
            while e > i + 1 && ".:".contains(chars[e - 1]) {
                e -= 1;
            }
            if e > i + 1 {
                refs.push((i, chars[i + 1..e].iter().collect()));
            }
            i = e.max(i + 1);
            continue;
        }
        if at(i, "cite(") {
            let j = skip_ws(i + 5);
            if chars.get(j) == Some(&'<')
                && let Some(e) = (j + 1..n).find(|&e| chars[e] == '>' || chars[e].is_whitespace())
                && chars[e] == '>'
                && e > j + 1
            {
                refs.push((i, chars[j + 1..e].iter().collect()));
                i = e + 1;
                continue;
            }
        }
        i += 1;
    }
    refs.extend(found);
    refs.sort_by_key(|(at, _)| *at);
    let mut out: Vec<String> = refs.into_iter().map(|(_, k)| k).collect();
    let mut seen = BTreeSet::new();
    out.retain(|k| seen.insert(k.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn legacy_bibtex_is_read_into_the_model() {
        let [s] = parse(r#"@article{Foo:2020,
            author={M{\"u}ller, Hans and {Some Corp} and van der Berg, Jan},
            title={A {T}itle}, journal={J}, year=2020, month=jan, volume={3}, weird={x}}"#)
        .unwrap()
        .try_into()
        .unwrap();
        let s = s.source;
        assert_eq!(s["citekey"], "Foo:2020");
        assert_eq!(s["entrytype"], "article");
        assert_eq!(s["journaltitle"], "J");
        assert_eq!(s["date"], "2020-01");
        assert_eq!(s["volume"], "3");
        assert_eq!(s["title"], "A {T}itle", "case protection is kept");
        assert_eq!(s["author"], json!(["Müller, Hans", "Some Corp", "van der Berg, Jan"]));
        assert_eq!(s[EXTRA], json!({"weird": "x"}));
    }

    #[test]
    fn legacy_types() {
        let p = parse(
            "@phdthesis{t, author={X, Y}, school={U}, year=2001}\n@conference{c, title={C}}\n@misc{m, howpublished={\\url{http://a.b/c}}}",
        )
        .unwrap();
        let (a, b, c) = (&p[0].source, &p[1].source, &p[2].source);
        assert_eq!((a["entrytype"].clone(), a["type"].clone(), a["institution"].clone()), (json!("thesis"), json!("phdthesis"), json!(["U"])));
        assert_eq!(b["entrytype"], "inproceedings");
        assert_eq!(c["url"], "http://a.b/c");
        assert!(!c.contains_key(EXTRA));
    }

    #[test]
    fn not_bibtex() {
        assert!(parse("just some text").is_err());
    }

    #[test]
    fn write_reads_back() {
        let s = map(json!({"title": "Deep {NASA} & friends", "citekey": "k_1", "entrytype": "article",
            "author": ["van Beethoven, Ludwig", "World Health Organization", "Doe, Jr., John"], "date": "2017-06",
            "url": "https://a.b/c_d%20e", "publisher": ["Smith and Sons"], "bib_extra": {"keywords": "x, y"}}));
        let text = write(&[s.clone()]);
        assert!(text.contains("url = {https://a.b/c_d%20e}"), "{text}");
        assert!(text.contains("{World Health Organization}"), "{text}");
        let back = parse(&text).unwrap().remove(0).source;
        for f in ["title", "citekey", "entrytype", "author", "date", "url", "publisher", EXTRA] {
            assert_eq!(back[f], s[f], "{f} in\n{text}");
        }
    }

    #[test]
    fn matching() {
        let existing = vec![
            ("a".to_string(), map(json!({"title": "Attention Is All You Need", "author": ["Vaswani, Ashish"], "date": "2017"}))),
            ("b".to_string(), map(json!({"title": "Something else entirely", "doi": "10.1/x"}))),
            ("c".to_string(), map(json!({"title": "Attention is all you need: a retrospective", "author": ["Other, A"], "date": "2023"}))),
        ];
        let m = matches(&map(json!({"title": "Attention is all you need", "author": ["Vaswani, A."], "date": "2017-06"})), &existing, 3);
        assert_eq!((m[0].key.as_str(), m[0].level), ("a", Level::Same));
        let m = matches(&map(json!({"title": "Unrelated", "doi": "https://doi.org/10.1/X"})), &existing, 3);
        assert_eq!((m[0].key.as_str(), m[0].level), ("b", Level::Same));
        assert_eq!(norm_isbn("0-306-40615-2"), "9780306406157");
        assert!(ratio("abcd", "abcd") == 1.0 && ratio("abcd", "wxyz") == 0.0);
    }

    #[test]
    fn merging() {
        let current = map(json!({"title": "T", "citekey": "k", "entrytype": "misc", "date": "2020", "main": "my notes"}));
        let incoming = map(json!({"title": "T", "citekey": "k", "entrytype": "article", "date": "2021", "doi": "10.1/x", "bib_extra": {"note": "n"}}));
        let m = merge(&current, &incoming, &[]);
        assert_eq!(m.filled, vec!["entrytype", "doi", "bib_extra.note"]);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.source["date"], "2020");
        assert_eq!(m.source["main"], "my notes");
        let m = merge(&current, &incoming, &["date".into()]);
        assert_eq!(m.source["date"], "2021");
        assert_eq!(unique_citekey("k", &["k".to_string(), "k-2".to_string()].into()), "k-3");
    }

    #[test]
    fn citations() {
        let text = "See @vaswani2017. And #cite(<smith:2023>) or #cite(label(\"odd key\")).\n\
            // @commented\n\"@inastring\" /* @blocked */ mail me@example.com, @a-b.";
        assert_eq!(cited_keys(text), vec!["vaswani2017", "smith:2023", "odd key", "a-b"]);
    }
}
