"""Adult-content check for release, torrent and file names.

Porn parodies reuse real titles and years ("The.Odyssey.XXX.Part.1.[Cosplayground.2026]"), so a name match alone
isn't enough: any of these words or studio names marks a release as adult. A term that is part of the film's
own title is allowed ("xXx: State of the Union"), and terms only count as whole words ("xxxpav69" is an
uploader tag, not porn)."""

import re
import unicodedata

_TERMS = (
    r"xxx|porn|porno|pornographic|hentai|onlyfans|milf|"
    r"brazzers|bang ?bros|reality ?kings|naughty ?america|blacked(?: ?raw)?|tushy|vixen|"
    r"nubiles|team ?skeet|mofos|digital ?playground|evil ?angel|fake ?hub|fake ?taxi|xvideos|pornhub|"
    r"cosplayground|adult ?time|private ?gold|dorcel|wicked ?pictures|jules ?jordan|new ?sensations|"
    r"tiny ?4k|pure ?taboo|family ?strokes|girls ?way|sweet ?sinner|hustler|vivid ?entertainment|"
    r"lets ?doe ?it|we ?live ?together|passion ?hd|povd|x ?art|21 ?sextury|tonights ?girlfriend"
)
_RE = re.compile(rf"(?<![a-z0-9])(?:{_TERMS})(?![a-z0-9])")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def is_adult(text: str, title: str = "") -> bool:
    """True when `text` (a release, torrent or file name) carries an adult term that isn't part of `title`."""
    allowed = {m.group(0) for m in _RE.finditer(_norm(title))}
    return any(m.group(0) not in allowed for m in _RE.finditer(_norm(text)))
