"""memorq for Claude Code and Pi: write repository notes from past sessions, index them in the next one.

Stdlib only, Python 3.9+: hooks run with the system python3, outside this repo's environment. The loop is knowledge
notes v2 from projects/factory-memory (src/factory_memory/notes.py), copied rather than imported so the plugin installs
on its own.

  hook         [--harness NAME] [--event NAME]: run the actions of a hook event (ORQ_NOTES_ON_<EVENT>) with the
               hook's stdin JSON; print what they return for the agent's context. The event comes from --event, else
               from stdin `hook_event_name` (Claude Code sends it); the harness from --harness, else stdin `harness`.
               The harness maps native event names (none named: Claude Code's) and tells consolidation which adapter
               reads the transcript (none named: detected from the file). integrations/claude-code/hooks.json and
               integrations/pi/memorq.ts call it.
  start        `hook --event session_start`: the note index as additionalContext, a sweep of unconsolidated sessions.
  prompt       `hook --event prompt`: on the first prompt, the notes ranked for it (ORQ_NOTES_RANK).
  end          `hook --event session_end`: consolidate the session in a detached process.
  consolidate  [--key K] [--event NAME] [--cwd DIR] TRANSCRIPT...: project, redact, consolidate, review, write
               notes. --event names the trigger on the learn record; the hooks pass both.
  dream        [--key K] [--cwd DIR] [--instructions FILE...] [--dry-run|--background]: one pass over the whole
               store, and over the repository's .memorq/ (or .orq/knowledge/) of DIR (default: here). Merges lessons
               seen in two or more sessions into rule notes, retires contradicted notes, distils repeated procedures
               into skills. The `maintain` action at session start runs it detached every DREAM_SESSIONS sessions, a
               day apart at most.
  dashboard    [--root DIR] [--out FILE] [--open]: one HTML page with the statistics of every store (memorq.dashboard).
  report       Per-repository counts from log.jsonl, then this repository's index and last decisions.
  settings     [--cwd DIR]: every setting the file can hold, as JSON: its value in force and its source (env, file
               or default), plus `paused` (source: state) for the repository of DIR (default: here), if it is one.
  settings set KEY VALUE [KEY VALUE ...]: write the pairs to the settings file (memorq.settings), all or none; a
               value is parsed by its key's type (an integer, true/false, else the text as given).
  settings unset KEY [KEY ...]: remove the keys from the settings file, so the environment or the default applies.
  pause        [on|off] [--cwd DIR]: stop (on) or resume (off) learning from the repository of DIR (default: here);
               its notes are still recalled. No argument: whether it is paused.
  store        [--cwd DIR]: where each kind (notes, rules, skills) is read from and written to, as JSON.
  store set    KIND repo|machine [--cwd DIR]: keep a kind in the repository's .memorq/ (or .orq/knowledge/), so it
               is committed with the code, or on this machine. The folder is the switch: `repo` creates it (rules
               and skills already on the machine move in), `machine` removes it when it holds nothing; with files in
               it, it only reports: new ones keep landing there until the folder is moved or deleted by hand.
  promote      [--kind rules|skills|all] [--cwd DIR]: move this machine's rules and skills into the repository's
               folder, each under its own name; one the repository already holds stays. As with `store set KIND
               repo`, the folder is the switch: new rules and skills are written there from then on.
  state        [--cwd DIR] [--session ID]: what memory knows for the repository of DIR (default: here), as JSON: its
               key, note count, write folders, log, when the next review is due (or that it is running), the learns of
               session ID and the last review. Outside a repository with no ORQ_NOTES_KEY, the same keys, empty.
  notes        [--cwd DIR]: every note and rule of that repository, newest first, as JSON, with how many sessions
               read each.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn

from . import background, consolidate, dream, hooks, migrate, report, settings, state
from . import store as notes_store

__all__ = ['main']


def _hook_input() -> dict[str, Any] | None:
    """The hook's stdin JSON object (empty stdin: {}), or None after one stderr line: bad input never fails a hook."""
    try:
        hook = json.loads(sys.stdin.read() or '{}')
    except ValueError:  # not JSON, or not UTF-8
        hook = None
    if not isinstance(hook, dict):
        print('✗ hook input is not a JSON object', file=sys.stderr)
        return None
    return hook


def _fail(message: str) -> NoReturn:
    """`✗ message` on stderr and exit 2, as argparse exits on a usage error."""
    print(f'✗ {message}', file=sys.stderr)
    sys.exit(2)


def _settings(op: str | None, words: list[str], cwd: str) -> None:
    """`settings`: the effective settings as JSON, with `paused` for the repository of `cwd` when it is one;
    `settings set` / `settings unset`: change the settings file (`cwd` is not used)."""
    if op is None:
        shown: dict[str, Any] = settings.effective()
        if key := notes_store.repo_key(cwd):
            shown['paused'] = {'value': notes_store.paused(settings.ROOT / key), 'source': 'state'}
        print(json.dumps(shown, indent=1))
        return
    if op == 'set' and (not words or len(words) % 2):
        _fail('settings set takes KEY VALUE pairs')
    if op == 'unset' and not words:
        _fail('settings unset takes one or more KEYs')
    try:
        if op == 'set':
            updates = {key: settings.parse_value(key, text) for key, text in zip(words[::2], words[1::2])}
        else:
            updates = dict.fromkeys(words)
        settings.write(updates)
    except ValueError as e:
        _fail(str(e))
    for key, value in updates.items():
        print(f'✓ {key} unset' if op == 'unset' else f'✓ {key} = {json.dumps(value)}')


def _pause(state: str | None, cwd: str) -> None:
    """`pause on|off`: pause or resume learning from the repository of `cwd`; with neither, print whether it is."""
    if not (key := notes_store.repo_key(cwd)):
        _fail('not a git repository and ORQ_NOTES_KEY is unset')
    store = settings.ROOT / key
    if state is None:
        print(f'{key}: {"paused" if notes_store.paused(store) else "learning"}')
        return
    try:
        notes_store.set_paused(store, state == 'on')
    except notes_store.Busy:
        _busy(key)
    except (OSError, ValueError, TypeError) as err:  # a state.json this command will not write over
        _fail(f'{key}: state.json is not readable ({err}); fix or delete it')
    print(f'✓ {key} {"paused" if state == "on" else "learning"}')


def _busy(key: str) -> NoReturn:
    _fail(f'{key} is busy consolidating or dreaming; try again in a minute')


def _promoted(store: Path, cwd: str, kinds: tuple[str, ...]) -> list[Path]:
    """`promote`, or a failure naming the store when a consolidation or a dream keeps it busy."""
    try:
        return notes_store.promote(store, cwd, kinds)
    except notes_store.Busy:
        _busy(store.name)


def _repo_store(cwd: str) -> tuple[Path, Path]:
    """The machine store and the repository folder for `cwd`, or a failure naming what is missing."""
    if not (key := notes_store.repo_key(cwd)):
        _fail('not a git repository and ORQ_NOTES_KEY is unset')
    if (root := notes_store.repo_root(cwd)) is None:
        _fail('not a git repository')
    return settings.ROOT / key, root


def _store(op: str | None, kind: str | None, where: str | None, cwd: str) -> None:
    """`store`: where each kind is read and written, as JSON; `store set KIND repo|machine`: choose by creating or
    removing the repository's folder for the kind."""
    if op is None:
        if not (key := notes_store.repo_key(cwd)):
            _fail('not a git repository and ORQ_NOTES_KEY is unset')
        shown = {}
        for k in notes_store.KINDS:
            d = notes_store.dirs(settings.ROOT / key, cwd, k)
            shown[k] = {'reads': [str(p) for p in d.reads], 'write': str(d.write)}
        print(json.dumps(shown, indent=1))
        return
    if kind is None or where is None:
        _fail('store set takes KIND (notes, rules or skills) and repo or machine')
    store, root = _repo_store(cwd)
    folder = root / kind
    if where == 'repo':
        notes_store.keep_dir(folder)
        if kind != 'notes':
            _promoted(store, cwd, (kind,))
        print(f'✓ {kind} → {folder}\n{_committed(kind)}')
        return
    held = [p for p in folder.iterdir() if p.name != '.gitkeep'] if folder.is_dir() else []
    if held:  # the folder is the switch, and it is not empty: its files stay where they are read
        print(
            f'{len(held)} {kind} stay in {folder} and new ones keep landing there · move or delete the folder to switch back'
        )
        return
    if folder.is_dir():
        (folder / '.gitkeep').unlink(missing_ok=True)
        folder.rmdir()
        if root.name == '.memorq' and not any(root.iterdir()):  # an empty .memorq would hide a later .orq/knowledge
            root.rmdir()
    print(f'✓ {kind} → {store / kind}')


def _committed(kind: str) -> str:
    """What `store set KIND repo` and `promote` say once the repository's folder for `kind` exists: the folder is the
    switch, so every new one of that kind lands in it."""
    return f'new {kind} will be committed with your code · check them before you push'


def _promote(kind: str, cwd: str) -> None:
    """`promote`: move the machine's rules or skills (or both) into the repository's folder; print where each went,
    then, once per kind moved, that new ones of that kind now land there too."""
    store, _ = _repo_store(cwd)
    moved = _promoted(store, cwd, ('rules', 'skills') if kind == 'all' else (kind,))
    # each moved path is <root>/rules/<name>.md or <root>/skills/<slug>: its parent names the kind, in order
    kinds = dict.fromkeys(p.parent.name for p in moved)
    print('\n'.join([*map(str, moved), *map(_committed, kinds)]) or 'nothing to promote')


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    h = sub.add_parser('hook')
    h.add_argument(
        '--harness', help='whose event names these are (default: claude), and which harness reads the transcript'
    )
    h.add_argument(
        '--event', help='a neutral event (session_start, prompt, compact, session_end, manual) or a native one'
    )
    sub.add_parser('start')
    sub.add_parser('end')
    sub.add_parser('prompt')
    sub.add_parser('report')
    c = sub.add_parser('consolidate')
    c.add_argument('--key')
    c.add_argument('--harness', help='which harness wrote the transcripts (default: detected from each file)')
    c.add_argument('--event', help='the trigger that asked for the learn, logged on its record')
    c.add_argument('--cwd', help='the working directory of the hook that asked for the learn')
    c.add_argument('transcripts', nargs='+', type=Path)
    d = sub.add_parser('dream')
    d.add_argument('--key')
    d.add_argument(
        '--cwd',
        help='the directory the pass is for (default: here): its store, instruction files and repository folder',
    )
    d.add_argument('--instructions', nargs='*', type=Path, default=None)
    d.add_argument('--dry-run', action='store_true')
    d.add_argument('--background', action='store_true', help='spawn the pass detached and return (for /memorq:dream)')
    sub.add_parser('dashboard', add_help=False)  # everything after `dashboard` is passed to memorq.dashboard
    st = sub.add_parser('settings')
    st.add_argument('--cwd', help='the repository whose pause state is shown (default: here)')
    st.add_argument('op', nargs='?', choices=('set', 'unset'))
    st.add_argument('words', nargs='*', metavar='KEY [VALUE]')
    pa = sub.add_parser('pause')
    pa.add_argument('state', nargs='?', choices=('on', 'off'))
    pa.add_argument('--cwd', help='the repository to pause or resume (default: here)')
    so = sub.add_parser('store')
    so.add_argument('op', nargs='?', choices=('set',))
    so.add_argument('kind', nargs='?', choices=notes_store.KINDS)
    so.add_argument('where', nargs='?', choices=('repo', 'machine'))
    so.add_argument('--cwd', help='the repository whose folders are shown or chosen (default: here)')
    pr = sub.add_parser('promote')
    pr.add_argument('--kind', choices=('rules', 'skills', 'all'), default='all')
    pr.add_argument('--cwd', help='the repository to move them into (default: here)')
    sa = sub.add_parser('state')
    sa.add_argument('--cwd', help='the repository whose memory is shown (default: here)')
    sa.add_argument('--session', help='the session whose learns are listed')
    no = sub.add_parser('notes')
    no.add_argument('--cwd', help='the repository whose notes are listed (default: here)')
    args, rest = parser.parse_known_args(argv)
    if rest and args.cmd != 'dashboard':
        parser.error(f'unrecognized arguments: {" ".join(rest)}')
    migrate.move_root()  # once per process, before any store access
    if args.cmd in {'hook', 'start', 'end', 'prompt'} and (hook := _hook_input()) is None:
        return
    if args.cmd == 'hook':
        event = args.event or hook.get('hook_event_name')
        harness = args.harness or hook.get('harness')
        if isinstance(event, str) and event:
            out = hooks.handle(hook, event, harness if isinstance(harness, str) and harness else None)
            if out:
                print(out)
    elif args.cmd in {'start', 'end', 'prompt'}:
        if args.cmd in {'start', 'prompt'} and (out := (hooks.start if args.cmd == 'start' else hooks.prompt)(hook)):
            print(out)
        elif args.cmd == 'end':
            hooks.end(hook)
    elif args.cmd == 'consolidate':
        consolidate.consolidate(args.key, args.transcripts, harness=args.harness, event=args.event, cwd=args.cwd)
    elif args.cmd == 'dream':
        cwd = args.cwd or str(Path.cwd())  # as the hook's pass: the key, the instruction files, the repository folder
        key = args.key or notes_store.repo_key(cwd)
        if not key:
            sys.exit('✗ not a git repository and ORQ_NOTES_KEY is unset')
        files = args.instructions if args.instructions is not None else dream.instruction_files(cwd)
        if args.background:
            instructions = ['--instructions', *map(str, files)] if files else []
            background.spawn(['dream', '--key', key, '--cwd', cwd, *instructions])
            print(f'Dream started for {key} in the background. `/memorq:notes` shows the result in a minute or two.')
        else:
            r = dream.dream(key, files, dry_run=args.dry_run, cwd=cwd)
            print(
                f'✓ {key} dream: {len(r.get("written", []))} rules, {len(r.get("skills", []))} skills, '
                f'{len(r.get("superseded", [])) + len(r.get("retired", []))} moved aside {r.get("error", "")[:200]}'.rstrip()
            )
    elif args.cmd == 'dashboard':
        from . import dashboard  # imported here: the hooks never need it

        dashboard.main(rest)
    elif args.cmd == 'settings':
        _settings(args.op, args.words, args.cwd or str(Path.cwd()))
    elif args.cmd == 'pause':
        _pause(args.state, args.cwd or str(Path.cwd()))
    elif args.cmd == 'store':
        _store(args.op, args.kind, args.where, args.cwd or str(Path.cwd()))
    elif args.cmd == 'promote':
        _promote(args.kind, args.cwd or str(Path.cwd()))
    elif args.cmd == 'state':
        print(json.dumps(state.snapshot(args.cwd or str(Path.cwd()), args.session), indent=1, allow_nan=False))
    elif args.cmd == 'notes':
        print(json.dumps(state.notes(args.cwd or str(Path.cwd())), indent=1, allow_nan=False))
    else:
        print(report.report(str(Path.cwd())))
