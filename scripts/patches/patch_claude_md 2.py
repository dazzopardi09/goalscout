#!/usr/bin/env python3
import sys, shutil
from pathlib import Path

TARGET = Path('/app/CLAUDE.md')
if not TARGET.exists():
    print(f"ERROR: {TARGET} not found."); sys.exit(1)

content = TARGET.read_text(encoding='utf-8')
original = content

OLD = """## Running scripts

The Docker image is **Node.js Alpine — no Python**. All scripts must use `node`, not `python3`.

**Preferred: run inside the already-running container** (env vars are already present):
```bash
docker cp /tmp/my-script.js goalscout:/app/my-script.js
docker exec -it goalscout node /app/my-script.js
```

**Alternative: temp container** (for scripts that need the source tree but no env):
```bash
docker run --rm -v "$(pwd)":/app -w /app goalscout-goalscout node scripts/my-script.js
```

**Do not** use `docker exec` with env vars from `docker-compose.yml` — they won't be present in a temp container unless explicitly passed."""

NEW = """## Host paths and how edits get deployed

The repo lives at `/Volumes/appdata/goalscout` on Mac and `/mnt/user/appdata/goalscout` on Unraid — same share, different mount points.

**The correct workflow for file changes is:**
1. Edit or patch files on the Mac (at `/Volumes/appdata/goalscout/...`)
2. `cd /mnt/user/appdata/goalscout && git add -A && git commit -m "..." && git push` (from Unraid)
3. Deploy with the standard docker compose sequence

**Delivering Claude-generated files to the repo:**
- Claude produces a file → user downloads it to Mac → user copies it into the repo:
  ```bash
  cp ~/Downloads/orchestrator.js /Volumes/appdata/goalscout/src/scrapers/orchestrator.js
  cp ~/Downloads/index.html /Volumes/appdata/goalscout/public/index.html
  ```
- This is the pattern used in all previous sessions. Do not deviate from it.

**Python patchers** (used when edits contain backticks/template literals that break heredocs):
- Run on the **Mac directly** — Mac has Python 3, no Docker needed:
  ```bash
  cd /Volumes/appdata/goalscout
  python3 scripts/patches/patch_orchestrator.py
  python3 scripts/patches/patch_history.py
  # etc.
  ```
- Patchers must target `/Volumes/appdata/goalscout/...` (Mac path), NOT `/mnt/user/appdata/goalscout/...` (Unraid path) and NOT `/app/...` (Docker container path).
- Never run Python patchers via `docker run python:3-alpine` or `docker exec` — unnecessary complexity.
- Never SSH into 192.168.178.5 to run patchers — you're editing the Mac-mounted share directly.

## Running scripts

The Docker image is **Node.js Alpine — no Python**. All scripts must use `node`, not `python3`.

**Preferred: run inside the already-running container** (env vars are already present):
```bash
docker cp /tmp/my-script.js goalscout:/app/my-script.js
docker exec -it goalscout node /app/my-script.js
```

**Alternative: temp container** (for Node scripts that need the source tree but no env):
```bash
docker run --rm -v "$(pwd)":/app -w /app goalscout-goalscout node scripts/my-script.js
```

**Do not** use `docker exec` with env vars from `docker-compose.yml` — they won't be present in a temp container unless explicitly passed."""

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print("✓ CLAUDE.md updated: host paths and patcher workflow documented")
else:
    print("FAILED: target section not found")
    sys.exit(1)

if content != original:
    backup = str(TARGET) + '.bak-paths'
    shutil.copy(TARGET, backup)
    TARGET.write_text(content, encoding='utf-8')
    print(f"Written: {TARGET}")
