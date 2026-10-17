"""Retrieval: which notes to show for a task. A retriever ranks notes for a query; RETRIEVERS names the built-ins.

Add one as a class with `search` and `refresh` plus a line in RETRIEVERS, or keep it outside the plugin and name it
with ORQ_NOTES_RANK=package.module:factory, where factory(store_dir) returns the retriever.
"""

from __future__ import annotations

import collections
import contextlib
import hashlib
import json
import math
import re
import sys
from typing import TYPE_CHECKING, Any, Protocol

from . import embeddings, extensions, index, settings
from . import store as notes_store  # the functions below take a `store` path, which would hide the module

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence
    from pathlib import Path

__all__ = [
    'BM25',
    'RETRIEVERS',
    'USE_RANKED',
    'Hybrid',
    'Retriever',
    'Semantic',
    'bm25',
    'configured_retriever',
    'make_retriever',
    'note_text',
    'note_vectors',
    'rank',
    'ranked',
    'rrf',
    'tokens',
]

# BM25 over title, trigger and body, optionally fused with cosine similarity of router embeddings by weighted
# reciprocal rank fusion. Constants from rohitg00/agentmemory (src/state/hybrid-search.ts).
# ponytail: no stemmer, synonyms or prefix match; add a Porter stem if BM25 misses notes that share a word's root.

USE_RANKED = (
    'Knowledge notes ranked for this task, best match first (the full index came at session start). Read the ones '
    'that apply before you start:'
)


def tokens(text: str) -> list[str]:
    return [t.strip('./-') for t in re.findall(r'[a-z0-9_./-]+', text.lower()) if t.strip('./-')]


def note_text(note: dict[str, str]) -> str:
    return f'{note["title"]}\n{note["trigger"]}\n{note["body"]}'


def bm25(docs: list[str], query: str) -> list[float]:
    """Okapi BM25 score of each document for the query."""
    toks = [tokens(d) for d in docs]
    avg = sum(map(len, toks)) / len(toks) if toks else 0
    docs_with = collections.Counter(t for ts in toks for t in set(ts))
    terms = set(tokens(query))
    scores = []
    for ts in toks:
        tf = collections.Counter(ts)
        norm = settings.BM25_K1 * (1 - settings.BM25_B + settings.BM25_B * len(ts) / (avg or 1))
        scores.append(
            sum(
                math.log(1 + (len(toks) - docs_with[t] + 0.5) / (docs_with[t] + 0.5))
                * tf[t]
                * (settings.BM25_K1 + 1)
                / (tf[t] + norm)
                for t in terms & tf.keys()
            )
        )
    return scores


def rrf(streams: list[list[str]], weights: tuple[float, ...]) -> dict[str, float]:
    """Weighted reciprocal rank fusion: each stream is a list of names, best first."""
    fused: dict[str, float] = collections.defaultdict(float)
    for stream, w in zip(streams, weights):
        for r, name in enumerate(stream):
            fused[name] += w / (settings.RRF_K + r + 1)
    return fused


# Kept for the research eval, which passes precomputed vectors.
def rank(
    notes: list[tuple[str, dict[str, str]]],
    query: str,
    vectors: dict[str, list[float]] | None = None,
    query_vector: list[float] | None = None,
) -> list[tuple[str, float]]:
    """(name, score) for every note, best first. BM25 alone without vectors; else BM25 and cosine fused by RRF.

    Notes are given newest first, so ties (no word in common, no vector) keep the age order of the index. A note
    without a vector is ranked by BM25 alone.
    """
    names = [name for name, _ in notes]
    lexical = bm25([note_text(n) for _, n in notes], query)
    by_bm25 = [names[i] for i in sorted(range(len(names)), key=lambda i: -lexical[i]) if lexical[i] > 0]
    if not (vectors and query_vector):
        scores = dict(zip(names, lexical))
    else:
        sims = {name: embeddings.cosine(query_vector, vectors[name]) for name in names if name in vectors}
        scores = rrf([by_bm25, sorted(sims, key=lambda n: -sims[n])], settings.RRF_WEIGHTS)
    return sorted(((name, scores.get(name, 0.0)) for name in names), key=lambda x: -x[1])


class Retriever(Protocol):
    def search(self, query: str, notes: Sequence[notes_store.Note], k: int) -> list[tuple[str, float]]:
        """(note name, score) of the k notes that best match the query, best first. Only notes that match (score > 0);
        ties keep the order of `notes`, which is newest first."""
        ...

    def refresh(self, notes: Sequence[notes_store.Note]) -> None:
        """After a write changed the notes: precompute what search needs. May be slow; never called in a hook."""
        ...


def _top(scored: Iterable[tuple[str, float]], k: int) -> list[tuple[str, float]]:
    """Best first, score above 0, at most k. sorted() is stable, so ties keep the input order."""
    return [(name, s) for name, s in sorted(scored, key=lambda x: -x[1]) if s > 0][:k]


class BM25:
    """Okapi BM25 over title, trigger and body. Nothing to precompute."""

    def search(self, query: str, notes: Sequence[notes_store.Note], k: int) -> list[tuple[str, float]]:
        return _top(zip((n.name for n in notes), bm25([n.text for n in notes], query)), k)

    def refresh(self, notes: Sequence[notes_store.Note]) -> None:
        pass


class Semantic:
    """Cosine similarity of router embeddings. Note vectors live in `cache` (the store's vectors.json), keyed by a
    digest of the note's text so an unchanged note is never embedded twice. `refresh` embeds the missing ones; `search`
    embeds only the query, so a note written since the last refresh is not found until the next one.
    """

    def __init__(self, cache: Path) -> None:
        self.cache = cache

    def vectors(self, notes: Sequence[notes_store.Note], *, compute: bool = False) -> dict[str, list[float]]:
        """Vector per note name, from the cache; `compute` first embeds the notes missing from it."""
        cache: dict[str, Any] = {}
        with contextlib.suppress(OSError, ValueError):
            cache = json.loads(self.cache.read_text())
        cached = cache.get('vectors', {}) if cache.get('model') == settings.EMBED_MODEL else {}
        digests = {n.name: hashlib.sha256(n.text.encode()).hexdigest()[:16] for n in notes if n.title}
        missing = [n for n in notes if n.name in digests and digests[n.name] not in cached]
        if compute and missing and (vecs := embeddings.embed([n.text for n in missing])):
            cached.update({digests[n.name]: v for n, v in zip(missing, vecs)})
            keep = set(digests.values())
            vectors = {d: v for d, v in cached.items() if d in keep}
            self.cache.write_text(json.dumps({'model': settings.EMBED_MODEL, 'vectors': vectors}))
        return {name: cached[d] for name, d in digests.items() if d in cached}

    def search(self, query: str, notes: Sequence[notes_store.Note], k: int) -> list[tuple[str, float]]:
        vectors = self.vectors(notes)
        if not vectors or not query.strip() or not (q := embeddings.embed([query], timeout=5)):
            return []
        return _top(((n.name, embeddings.cosine(q[0], vectors[n.name])) for n in notes if n.name in vectors), k)

    def refresh(self, notes: Sequence[notes_store.Note]) -> None:
        self.vectors(notes, compute=True)


class Hybrid:
    """Two retrievers fused by weighted reciprocal rank fusion: BM25 and Semantic by default (RRF_WEIGHTS)."""

    def __init__(self, first: Retriever, second: Retriever, weights: tuple[float, float] | None = None) -> None:
        self.first, self.second, self.weights = first, second, weights

    def search(self, query: str, notes: Sequence[notes_store.Note], k: int) -> list[tuple[str, float]]:
        streams = [[name for name, _ in r.search(query, notes, len(notes))] for r in (self.first, self.second)]
        fused = rrf(streams, self.weights or settings.RRF_WEIGHTS)
        return _top(((n.name, fused.get(n.name, 0.0)) for n in notes), k)

    def refresh(self, notes: Sequence[notes_store.Note]) -> None:
        self.first.refresh(notes)
        self.second.refresh(notes)


RETRIEVERS: dict[str, Callable[[Path], Retriever]] = {
    'bm25': lambda store_dir: BM25(),  # noqa: ARG005
    'semantic': lambda store_dir: Semantic(store_dir / 'vectors.json'),
    'hybrid': lambda store_dir: Hybrid(BM25(), Semantic(store_dir / 'vectors.json')),
}


def make_retriever(spec: str, store_dir: Path) -> Retriever | None:
    """The retriever `spec` names (a RETRIEVERS key or package.module:factory), built for one store; None for 'off'."""
    return None if spec == 'off' else extensions.resolve(spec, RETRIEVERS)(store_dir)


def configured_retriever(store_dir: Path, spec: str | None = None) -> Retriever | None:
    """make_retriever for ORQ_NOTES_RANK (or `spec`), in a hook: a bad setting prints one line and ranks nothing."""
    spec = settings.RANK if spec is None else spec
    try:
        return make_retriever(spec, store_dir)
    except Exception as e:  # a bad setting, or an outside factory that raises, never breaks a hook
        print(f'✗ ORQ_NOTES_RANK={spec}: {e}', file=sys.stderr)
        return None


def note_vectors(store_dir: Path, *, compute: bool = False) -> dict[str, list[float]]:
    """The semantic retriever's vectors for a store's notes. Kept for the tests and the research eval."""
    return Semantic(store_dir / 'vectors.json').vectors(notes_store.read_notes(store_dir), compute=compute)


def ranked(store_dir: Path, query: str, spec: str | None = None, cwd: str | None = None) -> str:
    """The top notes for a task as full index lines, or '' when ranking is off, the query is empty, or nothing matches.
    The notes come from the machine store and `cwd`'s repository folder (`store.paths`); vectors.json stays on the
    machine, keyed by note name."""
    if not query.strip() or not (retriever := configured_retriever(store_dir, spec)):
        return ''
    notes = notes_store.read_notes(store_dir, cwd)
    top = retriever.search(query, notes, settings.RANK_TOP)
    where = notes_store.paths(store_dir, cwd) if top else {}
    lines = []
    for name, _ in top:
        if path := where.get(name):  # an outside retriever may return a name that is not a note
            with contextlib.suppress(OSError):  # deleted since read_notes (the search may take seconds)
                lines.append(index.index_line(path, notes_store.parse_note(path.read_text())))  # sightings, verify
    return '\n'.join([USE_RANKED, '', *lines]) if lines else ''
