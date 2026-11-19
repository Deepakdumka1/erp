#!/bin/bash
# Double-click to push EduSense AI to GitHub using this Mac's git login.
cd "$(dirname "$0")" || exit 1
REMOTE="https://github.com/Deepakdumka1/erp.git"
exec > >(tee push_log.txt) 2>&1
echo "== Pushing EduSense AI to $REMOTE =="
if ! command -v git >/dev/null 2>&1; then
  echo "RESULT: git is not installed. Run: xcode-select --install"; read -r -p "Press Enter to close."; exit 1
fi
[ -d .git ] || git init -q
git config user.name >/dev/null 2>&1 || git config user.name "Deepakdumka1"
git config user.email >/dev/null 2>&1 || git config user.email "Deepakdumka1@users.noreply.github.com"
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$REMOTE"; else git remote add origin "$REMOTE"; fi
git add -A
git rm -r -q --cached college.db instance uploads .venv __pycache__ generated_images push_log.txt commit_message.txt 2>/dev/null
git status --short | head -50
if [ -f commit_message.txt ]; then git commit -q -F commit_message.txt; else git commit -q -m "Update EduSense AI"; fi || echo "(nothing new to commit)"
git branch -M main
echo "== Checking GitHub =="
if git fetch -q origin 2>/dev/null && git rev-parse -q --verify origin/main >/dev/null; then
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "The repository already has commits; keeping them and merging."
    git merge -q --allow-unrelated-histories -X ours origin/main -m "Merge existing GitHub history" || { echo "RESULT: merge failed, see messages above."; read -r -p "Press Enter to close."; exit 1; }
  fi
fi
if git push -u origin main; then
  echo "RESULT: pushed to $REMOTE"
  echo "Commit: $(git rev-parse --short HEAD)"
else
  echo "RESULT: push failed. If it says 'Repository not found', create the empty repo at https://github.com/new (name: erp) or check you are signed in as Deepakdumka1."
fi
read -r -p "Press Enter to close this window."
