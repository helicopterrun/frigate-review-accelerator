"""Admin API — exposes operational controls to the frontend.

Endpoints:
  POST /api/admin/restart   — restart backend worker (safe, no process suicide)
  POST /api/admin/update    — git pull + pip install (runs update.sh)
  GET  /api/admin/status    — structured worker status snapshot
  GET  /api/admin/logs      — Server-Sent Events stream of backend log tail

Security note: these endpoints are intended for local/homelab use only.
If exposing this service publicly, put these behind authentication.

Script execution notes:
  - Scripts run from PROJECT_ROOT (two levels up from this file)
  - stdout/stderr are merged and streamed line-by-line via SSE
  - Each script runs in a subprocess with a timeout
  - The backend process itself is NOT restarted via these endpoints —
    instead we reload the worker task, which is sufficient for config
    and code changes to preview/worker logic. Full process restart
    still requires restart.sh from the shell.
"""

import asyncio
import json
import logging
import os
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse

from app.config import settings

router = APIRouter(prefix="/api/admin", tags=["admin"])
log = logging.getLogger(__name__)


def verify_admin_secret(x_admin_secret: str | None = Header(None)) -> None:
    """FastAPI dependency — enforce X-Admin-Secret header when ADMIN_SECRET is set.

    If settings.admin_secret is empty the check is skipped (with a startup
    WARNING logged in main.py lifespan).  If it is set, any request missing
    or providing a wrong header value receives HTTP 401.
    """
    if settings.admin_secret and x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=401, detail="Unauthorized")

# Project root: backend/app/routers/ → up 3 levels
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent.resolve()
SCRIPTS_DIR = PROJECT_ROOT / "scripts"


def _script(name: str) -> Path:
    return SCRIPTS_DIR / name


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _sse(event: str, data: str) -> str:
    """Format a Server-Sent Event frame."""
    # Escape newlines in data — SSE data field must be single line per frame
    safe = data.replace("\n", "↵").replace("\r", "")
    return f"event: {event}\ndata: {safe}\n\n"


def _sse_json(event: str, payload: dict) -> str:
    return _sse(event, json.dumps(payload))


async def _stream_script(
    script_path: Path,
    args: list[str] | None = None,
    timeout: int = 120,
):
    """Async generator that runs a shell script and yields SSE frames.

    Yields:
      event: line   — one line of stdout/stderr output
      event: done   — script exited successfully  { "returncode": 0 }
      event: error  — script failed               { "returncode": N, "msg": "..." }
    """
    if not script_path.exists():
        yield _sse_json("error", {
            "returncode": -1,
            "msg": f"Script not found: {script_path}",
        })
        return

    cmd = ["bash", str(script_path)] + (args or [])
    log.info("Admin: running %s", " ".join(cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,  # merge stderr into stdout
            cwd=str(PROJECT_ROOT),
            env={**os.environ, "TERM": "dumb"},  # suppress colour codes
        )

        # Stream output line by line
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            # Strip ANSI colour codes for clean frontend display
            import re
            line = re.sub(r"\x1b\[[0-9;]*m", "", line)
            if line:
                yield _sse("line", line)
            await asyncio.sleep(0)  # yield control between lines

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            yield _sse_json("error", {
                "returncode": -1,
                "msg": f"Script timed out after {timeout}s",
            })
            return

        if proc.returncode == 0:
            yield _sse_json("done", {"returncode": 0})
        else:
            yield _sse_json("error", {
                "returncode": proc.returncode,
                "msg": f"Script exited with code {proc.returncode}",
            })

    except Exception as exc:
        log.exception("Admin script error: %s", exc)
        yield _sse_json("error", {"returncode": -1, "msg": str(exc)})


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/restart", dependencies=[Depends(verify_admin_secret)])
async def admin_restart():
    """Restart backend services via restart.sh --backend.

    Streams script output as SSE. The frontend should open an EventSource
    on this endpoint and display lines as they arrive.

    Note: this restarts the uvicorn process, so the SSE connection will
    drop when the server comes back up. The frontend handles this gracefully.
    """
    return StreamingResponse(
        _stream_script(_script("restart.sh"), args=["--backend"]),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


@router.post("/update", dependencies=[Depends(verify_admin_secret)])
async def admin_update():
    """Run update.sh --no-pull (deps only, assumes edits already applied).

    Streams output as SSE. Use --no-pull because the user has likely already
    edited files directly; a git pull could clobber local changes.
    After this completes, trigger a restart to apply.
    """
    return StreamingResponse(
        _stream_script(_script("update.sh"), args=["--no-pull"]),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/pull", dependencies=[Depends(verify_admin_secret)])
async def admin_pull():
    """Run git pull + update.sh (full update from remote).

    Use this when you've pushed changes to the repo and want to pull
    them down to the server without SSH-ing in.
    """
    return StreamingResponse(
        _stream_script(_script("update.sh")),  # no --no-pull = does git pull
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/status")
async def admin_status():
    """Structured worker status snapshot.

    Returns the last log line for each worker tier plus preview cache stats.
    Much cheaper than streaming full logs — suitable for polling every 10s.
    """
    log_path = PROJECT_ROOT / "logs" / "backend.log"

    def _last_match(pattern: str) -> str | None:
        """Return the last line in the log matching a pattern."""
        if not log_path.exists():
            return None
        try:
            result = subprocess.run(
                ["grep", pattern, str(log_path)],
                capture_output=True, text=True, timeout=5,
            )
            lines = result.stdout.strip().splitlines()
            return lines[-1] if lines else None
        except Exception:
            return None

    def _recent_errors(n: int = 5) -> list[str]:
        if not log_path.exists():
            return []
        try:
            result = subprocess.run(
                ["grep", "-E", "ERROR|WARNING|ImportError|Traceback", str(log_path)],
                capture_output=True, text=True, timeout=5,
            )
            lines = result.stdout.strip().splitlines()
            return lines[-n:] if lines else []
        except Exception:
            return []

    return {
        "log_file": str(log_path),
        "log_exists": log_path.exists(),
        "worker": {
            "last_index":      _last_match("Indexed.*new segments"),
            "last_recency":    _last_match("Recency pass"),
            "last_on_demand":  _last_match("On-demand pass"),
            "last_background": _last_match("Background pass"),
        },
        "recent_errors": _recent_errors(),
        "timestamp": time.time(),
    }


@router.post("/reindex", dependencies=[Depends(verify_admin_secret)])
async def admin_reindex(since_hours: float = 72.0):
    """Trigger a targeted reindex from a given number of hours ago.

    Bypasses scan_state entirely — does a full directory walk of all
    recording directories whose date/hour falls within the window.
    Streams SSE progress events: discovered, progress, done/error.
    """
    import queue
    import threading
    import datetime as _dt
    from app.services.indexer import index_segments_since

    since_ts = time.time() - (since_hours * 3600)
    progress_q: queue.Queue = queue.Queue()

    def _progress(tag, done, total, extra):
        progress_q.put({"tag": tag, "done": done, "total": total, "extra": extra})

    def _run():
        try:
            result = index_segments_since(since_ts, progress_callback=_progress)
            progress_q.put({"tag": "__done__", "result": result})
        except Exception as exc:
            log.exception("Reindex error: %s", exc)
            progress_q.put({"tag": "__error__", "msg": str(exc)})

    thread = threading.Thread(target=_run, daemon=True)

    async def _generate():
        since_label = _dt.datetime.utcfromtimestamp(since_ts).strftime('%Y-%m-%d %H:%M')
        yield _sse("line", f"Scanning last {since_hours:.0f}h "
                           f"(since {since_label} UTC)...")
        thread.start()

        while True:
            try:
                msg = progress_q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.1)
                continue

            tag = msg["tag"]

            if tag == "__discovered__":
                total = msg["total"]
                by_camera = msg["extra"]
                if total == 0:
                    yield _sse("line", "No new segments found in this time window.")
                else:
                    yield _sse("line", f"Found {total} new segments to index:")
                    for cam, count in sorted(by_camera.items()):
                        yield _sse("line", f"  {cam}: {count} segments")
                yield _sse_json("discovered", {"total": total, "by_camera": by_camera})

            elif tag == "__batch__":
                done = msg["done"]
                total = msg["total"]
                pct = int(done / total * 100) if total > 0 else 100
                yield _sse_json("progress", {"done": done, "total": total, "pct": pct})

            elif tag == "__done__":
                result = msg["result"]
                total = sum(result.values())
                yield _sse_json("done", {
                    "returncode": 0,
                    "total": total,
                    "cameras": len(result),
                })
                break

            elif tag == "__error__":
                yield _sse_json("error", {"returncode": -1, "msg": msg["msg"]})
                break

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/reset-preview-failures", dependencies=[Depends(verify_admin_secret)])
async def admin_reset_preview_failures(
    camera: str | None = None,
    since_hours: float | None = None,
):
    """Re-queue segments that failed preview generation so the worker retries them.

    Resets previews_generated=0 and clears preview_failure_reason for segments
    that were processed (previews_generated=1) but have no preview in the previews
    table — i.e., ffmpeg failed and left nothing behind.

    Query params:
      camera      — if set, only reset this camera; otherwise all cameras
      since_hours — if set, only reset segments newer than this many hours ago

    This endpoint intentionally does NOT reset segments that have a matching
    row in the previews table — those already produced a frame successfully.
    """
    from app.models.database import get_db

    since_ts = time.time() - (since_hours * 3600) if since_hours is not None else None

    async with get_db() as db:
        result = await db.execute(
            """UPDATE segments
               SET previews_generated = 0,
                   preview_failure_reason = NULL,
                   retry_count = 0
               WHERE previews_generated = 1
                 AND id NOT IN (SELECT segment_id FROM previews)
                 AND (camera = ? OR ? IS NULL)
                 AND (start_ts >= ? OR ? IS NULL)""",
            (camera, camera, since_ts, since_ts),
        )
        await db.commit()
        reset_count = result.rowcount

    log.info(
        "Admin: reset %d failed preview segments (camera=%s, since_hours=%s)",
        reset_count, camera or "all", since_hours,
    )
    return {
        "reset": reset_count,
        "camera": camera,
        "since_hours": since_hours,
        "message": f"Reset {reset_count} failed segments — worker will retry on next cycle",
    }


@router.post("/reset-scan-state", dependencies=[Depends(verify_admin_secret)])
async def admin_reset_scan_state():
    """Reset scan_state for all cameras, forcing a full rescan on next worker cycle.

    Use this if targeted reindex doesn't find expected segments.
    The next worker cycle (within scan_interval_sec seconds) will do a full
    directory walk of all recordings.

    WARNING: The full walk of 1.5M+ segments can take several minutes.
    """
    from app.models.database import get_db

    async with get_db() as db:
        await db.execute("DELETE FROM scan_state")
        await db.commit()

    log.info("Admin: scan_state reset — next worker cycle will do full rglob")
    return {"reset": True, "message": "scan_state cleared — full rescan on next worker cycle"}


@router.get("/logs/stream")
async def admin_logs_stream(
    lines: int = 50,
    filter: str = "",
):
    """Stream the backend log as SSE.

    Query params:
      lines  — how many historical lines to emit before tailing (default 50)
      filter — if set, only emit lines containing this string (case-insensitive)

    The frontend should open an EventSource on this URL. Each log line is
    emitted as:  event: line  data: <log line text>

    A keepalive ping is sent every 15s:  event: ping  data: {}
    """
    log_path = PROJECT_ROOT / "logs" / "backend.log"

    async def _generate():
        import re
        ansi_escape = re.compile(r"\x1b\[[0-9;]*m")
        filter_lower = filter.lower()

        # 1. Emit historical tail
        if log_path.exists():
            try:
                result = subprocess.run(
                    ["tail", f"-{lines}", str(log_path)],
                    capture_output=True, text=True, timeout=5,
                )
                for line in result.stdout.splitlines():
                    line = ansi_escape.sub("", line).rstrip()
                    if not line:
                        continue
                    if filter_lower and filter_lower not in line.lower():
                        continue
                    # Skip health check noise unless explicitly filtered for
                    if not filter_lower and "GET /api/health" in line:
                        continue
                    yield _sse("line", line)
            except Exception as exc:
                yield _sse_json("error", {"msg": f"Could not read log: {exc}"})

        yield _sse_json("ready", {"msg": "Historical lines complete, tailing..."})

        # 2. Tail the file
        if not log_path.exists():
            yield _sse_json("error", {"msg": "Log file does not exist — is the backend running?"})
            return

        proc = await asyncio.create_subprocess_exec(
            "tail", "-f", "-n", "0", str(log_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        assert proc.stdout is not None
        last_ping = time.time()

        try:
            while True:
                try:
                    raw = await asyncio.wait_for(proc.stdout.readline(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Send keepalive so the browser doesn't close the connection
                    yield _sse_json("ping", {})
                    last_ping = time.time()
                    continue

                if not raw:
                    break

                line = ansi_escape.sub("", raw.decode("utf-8", errors="replace")).rstrip()
                if not line:
                    continue
                if filter_lower and filter_lower not in line.lower():
                    continue
                if not filter_lower and "GET /api/health" in line:
                    continue

                yield _sse("line", line)

                # Periodic keepalive even when lines are flowing
                if time.time() - last_ping > 15:
                    yield _sse_json("ping", {})
                    last_ping = time.time()

        finally:
            proc.kill()

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
