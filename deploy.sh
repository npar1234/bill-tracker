#!/bin/bash
# SimpleLedger → GitHub deploy script
# Usage: bash deploy.sh "your commit message"

set -e

MSG="${1:-Update SimpleLedger}"
REPO="https://github.com/npar1234/bill-tracker.git"
BRANCH="main"

# Init git if needed
if [ ! -d .git ]; then
  git init
  git remote add origin "$REPO"
  echo "Initialized git repo and added remote."
fi

# Make sure we're on the right branch
git checkout -B "$BRANCH" 2>/dev/null || true

# ── Guard: the SW precaches EXACT urls, so sw.js must carry the same ?v= as
# index.html or the precache misses and the first launch after a deploy is slow.
for f in app.js style.css; do
  IDX=$(grep -oE "$f\?v=[0-9]+" index.html | head -1)
  SW=$(grep -oE "$f\?v=[0-9]+" sw.js | head -1)
  if [ "$IDX" != "$SW" ]; then
    echo "✗ version mismatch: index.html has '$IDX', sw.js has '$SW'"
    echo "  Bump both (and the CACHE const in sw.js) before deploying."
    exit 1
  fi
done
CACHE_V=$(grep -oE "simpleledger-v[0-9]+" sw.js | head -1)
echo "✓ asset versions consistent (sw CACHE: $CACHE_V)"

# Stage all app files (skip .DS_Store, node_modules)
git add app.js style.css index.html manifest.json sw.js icon.svg icon-60.png icon-192.png icon-512.png
git add netlify.toml netlify/functions/ package.json package-lock.json deploy.sh .gitignore

# Commit and push
git commit -m "$MSG"
git push -u origin "$BRANCH"

echo ""
echo "✅ Pushed to GitHub. Netlify will auto-deploy in ~30 seconds."
echo "   https://github.com/npar1234/i-swear-i-paid-that"
