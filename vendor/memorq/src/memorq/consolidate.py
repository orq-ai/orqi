"""Consolidation: the unseen part of each transcript, read into a Session, is written to the memory and logged."""

from __future__ import annotations

import contextlib
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from . import harnesses, memory, settings, transcripts
from . import store as notes_store  # the functions below take a `store` path, which would hide the module

__all__ = ['_transcript_key', 'consolidate', 'consolidate_one']


def consolidate_one(
    store_dir: Path,
    transcript: Path,
    mem: memory.Memory | None = None,
    harness: str | None = None,
    event: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any] | None:
    """Give the part of one transcript not yet written to `mem` (default: ORQ_NOTES_MEMORY) and log what it returns.

    `harness` names the harness that wrote the transcript (default: detected from the file). `event`, the neutral event
    that asked for the learn, is logged on the record when given; `cwd` goes to the memory with the session. The caller
    holds the store lock. Returns the log record, or None when the transcript has nothing new.

    While the store is paused nothing reaches `mem`: the record says `skipped: paused` and the cursor moves to the
    transcript's end, so the paused span is never learnt.
    """
    h = harnesses.detect(transcript, harness)
    session = h.transcripts.session_id(transcript)
    state = notes_store.load_state(store_dir)
    pending = state.setdefault('pending', {})  # start of a part that was skipped, so a later run still sees it
    cursor = state['sessions'].get(session, 0)
    unseen, seen_to = h.transcripts.read(transcript, cursor)
    if not unseen:
        # Lines without steps (Claude Code appends ai-title, mode, cost-state after a session ends) are seen: move the
        # cursor past them, or the file stays bigger than its cursor and every sweep picks it again. Not when a named
        # harness fell back to detection (not registered here): the file may be in a format no harness here reads, and
        # moving its cursor would hide the session from that harness once it is registered.
        if seen_to > cursor and (harness is None or h.name == harness):
            state['sessions'][session] = seen_to
            notes_store.save_state(store_dir, state)
        return None
    if notes_store.paused(store_dir):  # read here, under the lock: a learn spawned before `pause on` sees it too
        # What ran while paused is never learnt: the cursor moves past it and a part skipped earlier is dropped, so
        # resuming starts from the next new line. The session still counts toward the next dream.
        skip: dict[str, Any] = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'session': session}
        if event:
            skip['event'] = event
        skip['skipped'] = 'paused'
        pending.pop(session, None)
        notes_store.append_log(store_dir, skip)
        state['sessions'][session] = seen_to
        notes_store.save_state(store_dir, state)
        return skip
    start = pending.get(session, cursor)
    steps, end = h.transcripts.read(transcript, start)
    whole = steps if start == 0 else h.transcripts.read(transcript, 0)[0]
    record: dict[str, Any] = {
        'ts': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'session': session,
        'agent': h.name,
        'transcript': str(transcript),
        'bytes': [start, end],  # ponytail: the harness's cursor; for ATIF it counts steps, not bytes
        'tool_calls': len(transcripts.tool_call_inputs(steps)),
        'session_tool_calls': len(transcripts.tool_call_inputs(whole)),
    }
    if event:
        record['event'] = event
    mem = memory.make_memory(store_dir.parent) if mem is None else mem
    record.update(mem.write(memory.Session(store_dir.name, session, h.name, steps, whole, cwd)))
    if 'skipped' in record:
        pending.setdefault(session, start)
    else:
        pending.pop(session, None)
    notes_store.append_log(store_dir, record)
    state['sessions'][session] = end
    notes_store.save_state(store_dir, state)
    return record


def consolidate(
    key: str | None,
    transcripts: list[Path],
    mem: memory.Memory | None = None,
    harness: str | None = None,
    event: str | None = None,
    cwd: str | None = None,
) -> None:
    """Write each transcript's unseen part to `mem` (default: ORQ_NOTES_MEMORY, built once for the call), read as
    `harness` wrote it (default: detected from each file). `event` and `cwd` go to consolidate_one."""
    # `transcripts` is the public keyword (`consolidate(key, transcripts=[...])`); it hides the module, unused here.
    # A bad ORQ_NOTES_MEMORY raises here, uncaught: this is a background run, and its traceback goes to hook.log.
    mem = memory.make_memory() if mem is None else mem
    for transcript in transcripts:
        k = key
        try:  # one bad transcript (an outside harness that raises, say) must not stop the others
            k = key or _transcript_key(transcript)
            if not k:
                print(f'✗ no repository for {transcript}', file=sys.stderr)
                continue
            with notes_store.locked(settings.ROOT / k):
                record = consolidate_one(settings.ROOT / k, transcript, mem, harness, event, cwd)
        except Exception as e:  # its cursor stays where it was; stderr goes to hook.log in background runs
            print(f'✗ {k or "?"} {transcript}: {type(e).__name__}: {e}', file=sys.stderr)
            traceback.print_exc()
            continue
        if record:
            print(_progress(k, record))


def _progress(key: str, record: dict[str, Any]) -> str:
    """One line per consolidated part. The counts are the notes memory's; another memory's record may have none."""
    counts = ''
    if 'candidates' in record or 'written' in record:
        counts = f': {len(record.get("candidates", []))} candidates, {len(record.get("written", []))} written'
    return (
        f'✓ {key} {record["session"]}{counts} {record.get("skipped", "")}{str(record.get("error", ""))[:200]}'.rstrip()
    )


def _transcript_key(transcript: Path) -> str | None:
    for line in transcript.open():
        with contextlib.suppress(ValueError):
            if isinstance(d := json.loads(line), dict) and (cwd := d.get('cwd')) and Path(cwd).is_dir():
                return notes_store.repo_key(cwd)
    return None
