# CLAUDE.md — GoalScout Project Instructions

## Response style
- Always provide the **full updated file** when making code changes — never snippets or diffs only.
- This is a continuation project. Assume prior context from the conversation and project knowledge.

## Deploy sequence (never deviate)
1. `docker compose down`
2. `docker rmi goalscout goalscout-goalscout 2>/dev/null || true`
3. `docker builder prune -f`
4. `docker compose up --build -d`
5. `docker logs -f goalscout`

Never run `docker build` separately. Compose builds its own image named `goalscout-goalscout`.

## Running commands
Run file edits and scripts inside a temp container against the running image — plain `python` or `node` on the host won't work:

```bash
docker run --rm -v /mnt/user/appdata/goalscout:/app goalscout-goalscout node /app/src/some-script.js
```

For Python edits (e.g. multi-line replacements):
```bash
docker run --rm -v /mnt/user/appdata/goalscout:/app goalscout-goalscout python3 /app/scripts/fix.py
```