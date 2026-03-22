# Contributing to Frigate Review Accelerator

Contributions are welcome. This document covers what you need to know before opening a PR.

-----

## Read CLAUDE.md first

[`CLAUDE.md`](CLAUDE.md) is the authoritative reference for this project. It documents:

- Core architectural invariants you must not violate
- The global time invariant (`cursorTs` as single source of truth)
- The O(1) preview lookup invariant (no DB call on the scrub hot path)
- The timeline read-only invariant (no writes, no filesystem scans in GET /api/timeline)
- Canvas rendering rules for VerticalTimeline (subpixel precision, event marker dominance)
- Scroll interaction model (velocity + decay, zoom-aware sensitivity)
- The two-mode AI workflow (Claude Chat for diagnosis, Claude Code for implementation)
- All planned v3 features

**If you are making a change that touches any of the systems described in CLAUDE.md, read the relevant section before writing a line of code.**

-----

## Before opening an issue

Search existing issues first. If you have found a bug, include:

- What you expected to happen
- What actually happened
- Relevant log output (`./scripts/logs.sh --errors`)
- Browser and OS if it is a frontend issue

For significant feature work, open an issue for discussion before writing code. The architecture has deliberate constraints — some things that seem like improvements would break invariants.

-----

## Development setup

Follow the Quick Start in `README.md`. The short version:

```bash
cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd frontend && npm install
./scripts/restart.sh
```

-----

## Running tests

All PRs must pass the test suite:

```bash
cd backend && pytest
```

If your change cannot be unit tested (e.g. a React closure bug), document why in the PR and add a `# TODO: add frontend test` comment in the source. See `CLAUDE.md` — “Testing” section for test structure and mocking conventions.

Key rules:

- Never call real ffmpeg in tests — mock at `app.services.preview_generator.subprocess.run`
- Use SQLite `:memory:` for integration tests (see `backend/tests/integration/conftest.py`)
- Patch `app.services.hls.httpx.AsyncClient` when mocking Frigate reachability

-----

## Frigate API changes

Before modifying any code that depends on Frigate behavior, check the official Frigate docs first and cite the relevant page in your PR description. This applies to:

- Recording path layout — [Recording configuration](https://docs.frigate.video/configuration/record/)
- VOD / playback endpoints — [VOD API](https://docs.frigate.video/integrations/api/vod-hour-vod-year-month-day-hour-camera-name-tz-name-get/)
- Events API — [Events API](https://docs.frigate.video/integrations/api/events-events-get/)
- Snapshot/media endpoints — [Snapshot from recording API](https://docs.frigate.video/integrations/api/get-snapshot-from-recording-camera-name-recordings-frame-time-snapshot-format-get/)
- Retention and recording semantics — [HTTP API index](https://docs.frigate.video/integrations/api/frigate-http-api/)

Do not rely on memory alone for Frigate API assumptions.

-----

## PR conventions

Branch off `main`. PR titles follow Conventional Commits:

```
fix(frontend): stale closure in health poll resets selected camera
feat(backend): paginate event sync for high-volume cameras
refactor(worker): extract _process_scheduler_jobs into separate function
test(preview): add coverage for adjacent bucket fallback
chore(deps): bump hls.js to 1.6
```

Types: `fix`, `feat`, `refactor`, `test`, `chore`

Every PR must:

1. Pass `cd backend && pytest` with no new failures
1. Include test coverage for the change, or a documented reason why tests are not possible
1. Not regress any invariant documented in `CLAUDE.md`
1. Cite relevant Frigate docs if Frigate-facing behavior is touched

-----

## Architecture constraints — what not to do

These are derived directly from `CLAUDE.md`. Violating them will result in the PR being rejected:

**Never add a database call to `GET /api/preview/{camera}/{ts}`.** The preview endpoint is the scrub hot path. Every pixel of mouse movement fires a request here. It must remain O(1) pure filesystem math.

**Never add writes to `GET /api/timeline`, `/api/timeline/buckets`, or `/api/timeline/density`.** These endpoints are read-only by invariant. No preview generation, no ffprobe calls, no filesystem scans.

**Never change `cursorTs` implicitly.** Only explicit user action may modify the cursor timestamp. The camera selector, filter changes, and UI state changes must not move it.

**Never switch to a horizontal timeline layout.** The vertical orientation is a deliberate design decision, not an oversight. See `CLAUDE.md` — “Timeline orientation.”

**Never add batch frame extraction to the preview generator.** One ffmpeg subprocess per request, one output frame. No retry loops, no fallback batches.

**Never eagerly process the full segment corpus** for preview generation on startup or on any path that a normal user interaction could trigger. See `CLAUDE.md` — “Preview generation policy.”

**Never run uvicorn with `--workers > 1`.** The on-demand queue (`_demand_queue`) and HLS reachability cache (`_hls_reachable_cache`) are in-process singletons. Multiple workers would silently drop on-demand requests.

-----

## Focus areas

The areas most likely to benefit from contributions:

- **Performance** — preview cache tuning, density query optimization, VAAPI pipeline improvements
- **Timeline UX** — zoom feel, reticle behavior, density gradient rendering
- **Preview generation** — scheduler priority tuning, interaction-driven prefetch direction
- **Test coverage** — frontend has no test harness yet; React closure bugs are hard to catch

-----

## Secrets and local environment

Never commit `.env` files, RTSP credentials, camera IPs, API keys, or production configuration. Use placeholders in examples. See `CLAUDE.md` — “Secrets and local environment safety.”