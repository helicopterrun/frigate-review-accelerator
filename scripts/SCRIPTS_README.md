# Scripts

Utility scripts for managing the Frigate Review Accelerator.

Make them executable after cloning:
```bash
chmod +x scripts/*.sh
```

---

## update.sh

Pull latest changes and install/update dependencies.

```bash
./scripts/update.sh              # pull + update everything
./scripts/update.sh --no-pull   # skip git pull (edits already applied locally)
./scripts/update.sh --backend   # backend deps only
./scripts/update.sh --frontend  # frontend deps only
```

Always run `restart.sh` after `update.sh` to apply changes.

---

## restart.sh

Stop and restart backend and/or frontend. Logs go to `logs/`, PIDs tracked in `.pids/`.

```bash
./scripts/restart.sh             # restart everything
./scripts/restart.sh --backend  # backend only
./scripts/restart.sh --frontend # frontend only
./scripts/restart.sh --stop     # stop everything without restarting
```

Automatically clears `__pycache__` before restarting the backend, which prevents stale `.pyc` import errors after file changes.

---

## logs.sh

Tail and filter logs with colour-coded output.

```bash
./scripts/logs.sh                # tail both logs (last 50 lines)
./scripts/logs.sh --backend      # backend only
./scripts/logs.sh --frontend     # frontend only
./scripts/logs.sh --previews     # preview worker activity only
./scripts/logs.sh --errors       # errors and warnings only
./scripts/logs.sh --lines 200    # show last 200 lines before tailing
./scripts/logs.sh --no-follow    # print and exit, don't tail
./scripts/logs.sh --status       # worker status snapshot + cache stats
```

### --status output example

```
── Worker Status Snapshot ──

Last index run:
  Indexed 12 new segments across 3 cameras

Last recency pass:
  Recency pass: generated previews for 100 segments (last 48h)

Last on-demand pass:
  On-demand pass: generated previews for 18 segments

Last background pass:
  Background pass: generated previews for 20 segments

Recent errors:
  (none)

Preview cache stats:
  {
    "cache_size": 142,
    "max_size": 500,
    "hits": 3821,
    "misses": 209,
    "hit_rate_pct": 94.8
  }
```

### Colour coding

| Colour | Meaning |
|---|---|
| Green | Recency pass / new segments indexed |
| Cyan | On-demand pass (user-triggered) |
| Magenta | Background crawl pass |
| Yellow | Warnings |
| Red | Errors |
| Dim | Health check noise (filtered by default) |

---

## Typical workflow

```bash
# First time setup
git clone <repo>
cd frigate-review-accelerator
chmod +x scripts/*.sh
cp backend/.env.example backend/.env
# edit backend/.env with your paths
./scripts/update.sh
./scripts/restart.sh

# After pulling new changes
./scripts/update.sh && ./scripts/restart.sh

# Debug preview generation
./scripts/logs.sh --previews

# Quick health check
./scripts/logs.sh --status
```
