"""Embeddings from the orq router, for the semantic and hybrid retrievers: the API key, the call, cosine similarity.

Never raises into a hook: without a key or on any error, `embed` returns None and the retrievers rank without vectors.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import sys
import urllib.request

from . import settings

__all__ = ['api_key', 'cosine', 'embed']


def api_key() -> str | None:
    """The orq key from ~/.orq/api-key (`ORQ_API_KEY=<key>` or a bare key), else $ORQ_API_KEY.

    The file comes first: it is what the orq CLI writes, and a shell can carry a stale exported key. Not with
    ORQ_NOTES_LLM=orq: the harness that chose the router (orqi) exports the key its own session was accepted with.
    """
    if settings.LLM == 'orq' and (key := os.getenv('ORQ_API_KEY')):
        return key
    with contextlib.suppress(OSError):
        if key := re.sub(r'^(export )?ORQ_API_KEY=', '', settings.API_KEY_FILE.read_text().strip()).strip('\'" \n'):
            return key
    return os.getenv('ORQ_API_KEY')


def embed(texts: list[str], timeout: float = 30) -> list[list[float]] | None:
    """Embeddings from the orq router, or None without a key or on any error (never raised into a hook)."""
    if not texts or not (key := api_key()):
        return None
    body = json.dumps({'model': settings.EMBED_MODEL, 'input': [t[: settings.EMBED_CHARS] for t in texts]}).encode()
    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    try:
        req = urllib.request.Request(settings.EMBED_URL, data=body, headers=headers)  # noqa: S310 (fixed https URL)
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return [d['embedding'] for d in json.loads(resp.read())['data']]  # in input order
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f'✗ embed: {str(e)[:200]}', file=sys.stderr)
        return None


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
    return dot / norm if norm else 0.0
