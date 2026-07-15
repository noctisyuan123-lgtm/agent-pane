#!/usr/bin/env python3
"""Import a Grok CLI / Claude-import session into Agent Pane history.

Writes ~/.agent-pane/sessions/<id>/{meta.json,events.jsonl} using the same
UUID as the Grok session id so `agent-pane open <id>` works with either id.

Does NOT prompt the agent / does NOT resume live — history only.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HOME = Path.home()
GROK_ROOT = HOME / ".grok" / "sessions"
PANE_ROOT = HOME / ".agent-pane" / "sessions"


def extract_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for x in content:
            if isinstance(x, dict):
                if x.get("type") == "text" or "text" in x:
                    parts.append(str(x.get("text") or ""))
                elif x.get("type") == "summary_text":
                    parts.append(str(x.get("text") or ""))
        return "".join(parts)
    return str(content)


def reasoning_text(obj: dict[str, Any]) -> str:
    summary = obj.get("summary")
    if isinstance(summary, list):
        parts = []
        for x in summary:
            if isinstance(x, dict) and x.get("type") == "summary_text":
                parts.append(str(x.get("text") or ""))
            elif isinstance(x, dict) and "text" in x:
                parts.append(str(x.get("text") or ""))
        if parts:
            return "\n".join(parts)
    return extract_text(obj.get("content") or obj.get("text"))


def find_grok_dir(session_id: str) -> Path | None:
    if not GROK_ROOT.is_dir():
        return None
    # Typical layout: ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/
    for cwd_enc in GROK_ROOT.iterdir():
        if not cwd_enc.is_dir():
            continue
        cand = cwd_enc / session_id
        if (cand / "chat_history.jsonl").is_file():
            return cand
    # Fallback: deeper search (capped)
    for hist in GROK_ROOT.glob(f"*/{session_id}/chat_history.jsonl"):
        return hist.parent
    return None


def load_summary(grok_dir: Path) -> dict[str, Any]:
    p = grok_dir / "summary.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def is_noise_user(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if t.startswith("<local-command"):
        return True
    if t.startswith("<command-name>") or t.startswith("<command-message>"):
        return True
    return False


def trunc(s: str, n: int = 4000) -> str:
    s = s or ""
    if len(s) <= n:
        return s
    return s[: n - 20] + "\n…(truncated)"


def convert(
    session_id: str,
    grok_dir: Path,
    *,
    force: bool = False,
) -> dict[str, Any]:
    pane_dir = PANE_ROOT / session_id
    events_path = pane_dir / "events.jsonl"
    meta_path = pane_dir / "meta.json"

    if events_path.is_file() and not force:
        meta = {}
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {"sessionId": session_id}
        return {
            "ok": True,
            "skipped": True,
            "sessionId": session_id,
            "meta": meta,
            "reason": "already imported",
        }

    summary = load_summary(grok_dir)
    info = summary.get("info") if isinstance(summary.get("info"), dict) else {}
    cwd = (
        str(info.get("cwd") or summary.get("cwd") or "").strip()
        or str(HOME)
    )
    created_at = str(summary.get("created_at") or "")
    updated_at = str(summary.get("updated_at") or created_at)
    model = str(summary.get("current_model_id") or "")

    hist_path = grok_dir / "chat_history.jsonl"
    lines = hist_path.read_text(encoding="utf-8").splitlines()

    events: list[dict[str, Any]] = []
    seq = 0
    at = created_at or "1970-01-01T00:00:00.000Z"
    user_count = 0
    title = ""

    def push(ev: dict[str, Any]) -> None:
        nonlocal seq
        seq += 1
        ev = {**ev, "seq": seq, "sessionId": session_id, "at": at}
        events.append(ev)

    push(
        {
            "type": "SessionStarted",
            "cwd": cwd,
            "model": model or None,
            "providerSessionId": session_id,
            "resumed": True,
        }
    )

    open_tools: dict[str, str] = {}

    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        typ = obj.get("type")

        if typ == "user":
            text = extract_text(obj.get("content")).strip()
            if is_noise_user(text):
                continue
            user_count += 1
            if not title:
                title = text.replace("\n", " ").strip()[:80]
            push({"type": "UserMessageAppended", "text": text})

        elif typ == "reasoning":
            text = reasoning_text(obj).strip()
            if text:
                push({"type": "ThoughtChunk", "text": text})

        elif typ == "assistant":
            text = extract_text(obj.get("content")).strip()
            if text:
                push({"type": "MessageChunk", "role": "assistant", "text": text})
                push({"type": "MessageDone", "role": "assistant"})
            tool_calls = obj.get("tool_calls") or []
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    tid = str(tc.get("id") or f"tool-{seq}")
                    name = str(tc.get("name") or "tool")
                    args = tc.get("arguments")
                    if isinstance(args, (dict, list)):
                        args_s = json.dumps(args, ensure_ascii=False)
                    else:
                        args_s = str(args or "")
                    open_tools[tid] = name
                    push(
                        {
                            "type": "ToolStarted",
                            "toolId": tid,
                            "title": name,
                            "kind": name,
                            "inputSummary": trunc(args_s, 1500),
                        }
                    )

        elif typ == "tool_result":
            tid = str(obj.get("tool_call_id") or "") or f"tool-result-{seq}"
            out = extract_text(obj.get("content"))
            name = open_tools.pop(tid, "tool")
            push(
                {
                    "type": "ToolFinished",
                    "toolId": tid,
                    "outputSummary": trunc(out, 4000),
                }
            )

    if user_count == 0:
        raise SystemExit(
            f"no user messages in grok chat_history: {hist_path}"
        )

    if not title:
        title = f"Imported {session_id[:8]}"

    if not updated_at:
        updated_at = created_at or at
    if not created_at:
        created_at = updated_at

    # Stamp events with created/updated bounds (keep seq order)
    for i, ev in enumerate(events):
        if i == 0:
            ev["at"] = created_at
        elif i == len(events) - 1:
            ev["at"] = updated_at
        else:
            ev["at"] = created_at

    pane_dir.mkdir(parents=True, exist_ok=True)
    events_path.write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events),
        encoding="utf-8",
    )
    meta = {
        "sessionId": session_id,
        "cwd": cwd,
        "title": title,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "messageCount": user_count,
        "providerSessionId": session_id,
        "importedFrom": "grok",
        "sourceKind": summary.get("session_kind") or "grok",
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "skipped": False,
        "sessionId": session_id,
        "meta": meta,
        "events": len(events),
        "userMessages": user_count,
        "grokDir": str(grok_dir),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session_id", help="Grok / Claude-import session UUID")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Rewrite Pane session even if it already exists",
    )
    ap.add_argument("--json", action="store_true", help="Print result as JSON")
    args = ap.parse_args()
    sid = args.session_id.strip()
    grok_dir = find_grok_dir(sid)
    if not grok_dir:
        print(f"grok session not found: {sid}", file=sys.stderr)
        raise SystemExit(2)
    result = convert(sid, grok_dir, force=args.force)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get("skipped"):
            print(f"already imported: {sid}")
        else:
            print(
                f"imported {sid} → ~/.agent-pane/sessions/{sid}/ "
                f"({result.get('userMessages')} user msgs, {result.get('events')} events)"
            )
            print(f"title: {result['meta'].get('title')}")
            print(f"cwd:   {result['meta'].get('cwd')}")


if __name__ == "__main__":
    main()
