#!/usr/bin/env bash
# Build the app for GitHub Pages (served from /longshadow/) and push it to the gh-pages branch.
# Usage: bash scripts/deploy-pages.sh
set -euo pipefail
REPO="$(git config --get remote.origin.url)"
NAME="$(git config user.name)"
MAIL="$(git config user.email)"
npx tsc --noEmit
npx vite build --base=/longshadow/
cp dist/index.html dist/404.html   # lets /longshadow/app and other deep links load the app
touch dist/.nojekyll
cd dist
rm -rf .git
git init -q -b gh-pages
git config user.name "$NAME"
git config user.email "$MAIL"
git config core.autocrlf false
git add -A
git commit -q -m "Publish site"
git push -q -f "$REPO" gh-pages
rm -rf .git
echo "published"
