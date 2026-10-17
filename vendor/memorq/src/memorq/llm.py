"""The one place that runs a model: through a harness's CLI (harnesses.model_for), or the orq router when
ORQ_NOTES_LLM=orq; JSON back. Tests replace llm_json."""

from __future__ import annotations

import json
import os
import subprocess
import urllib.request
from typing import TYPE_CHECKING, Any

from . import embeddings, harnesses, pricing, settings

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ['llm_json', 'orq_chat']


def _cli(harness: str) -> Callable[[str, str], tuple[str, dict[str, Any], str]]:
    model = harnesses.model_for(harness)

    def call(system: str, user: str) -> tuple[str, dict[str, Any], str]:
        cmd = model.command(system)
        env = {**os.environ, 'ORQ_NOTES_CHILD': '1'}
        out = subprocess.run(cmd, input=user, capture_output=True, text=True, env=env, cwd=settings.ROOT, check=False)
        why = f'{cmd[0]} -p returned no JSON: {model.failure(out)}'
        try:
            return (*model.parse(out.stdout), why)
        except (ValueError, StopIteration, KeyError):
            return '', {}, why

    return call


def orq_chat(system: str, user: str, timeout: float = 300) -> tuple[str, dict[str, Any], str]:
    """One chat completion from the orq router: the reply text, usage with Claude's keys, and what to log if the reply
    holds no JSON."""
    if not (key := embeddings.api_key()):
        return '', {}, 'orq router returned no JSON: no key (~/.orq/api-key or ORQ_API_KEY)'
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
    body = json.dumps({'model': settings.ORQ_MODEL, 'messages': messages}).encode()
    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'x-client-type': 'memorq'}
    try:
        req = urllib.request.Request(settings.CHAT_URL, data=body, headers=headers)  # noqa: S310 (configured https URL)
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            data = json.loads(resp.read())
        u = data.get('usage') or {}
        cached = (u.get('prompt_tokens_details') or {}).get('cached_tokens') or 0
        text = data['choices'][0]['message']['content'] or ''
        usage: dict[str, Any] = {
            'input_tokens': (u.get('prompt_tokens') or 0) - cached,
            'output_tokens': u.get('completion_tokens', 0),
            'cache_read_input_tokens': cached,
            'cache_creation_input_tokens': 0,
            'cost_usd': None,
            'model': f'orq/{settings.ORQ_MODEL}',
        }
        usage['cost_usd'] = pricing.price(settings.ORQ_MODEL, usage)  # the router does not price the response
        return text, usage, f'orq router returned no JSON: {text[-300:]}'
    except (OSError, ValueError, KeyError, IndexError, TypeError) as e:
        return '', {}, f'orq router returned no JSON: {str(e)[:300]}'


def llm_json(system: str, user: str, harness: str = 'claude') -> tuple[dict[str, Any], dict[str, Any]]:
    """One headless call returning a JSON object: the orq router when ORQ_NOTES_LLM=orq, else `harness`'s model CLI
    (Claude's for one without)."""
    call = orq_chat if settings.LLM == 'orq' else _cli(harness)
    for attempt in range(2):  # the model occasionally returns malformed JSON
        text, usage, why = call(system, user)
        try:
            data, _ = json.JSONDecoder().raw_decode(text[text.index('{') :])
            return data, usage
        except ValueError:
            if attempt == 1:
                raise RuntimeError(why) from None
    raise AssertionError  # unreachable
