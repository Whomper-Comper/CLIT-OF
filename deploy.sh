#!/usr/bin/env bash
# Stage and test an immutable commit while the running bot stays online.
# Usage: ./deploy.sh [full-commit-sha]  (defaults to fetched origin/main)
set -euo pipefail

SCRIPT_DIR="${BOT_DIRECTORY:-$(cd "$(dirname "${BASH_SOURCE[0]:-$PWD/deploy.sh}")" && pwd)}"
cd "$SCRIPT_DIR"
command -v pm2 >/dev/null || { echo "PM2 must be installed before deployment." >&2; exit 1; }
command -v flock >/dev/null || { echo "The flock utility is required for safe deployment." >&2; exit 1; }
mkdir -p .deploy/releases
exec 9> .deploy/deploy.lock
flock -n 9 || { echo "Another deployment is already running." >&2; exit 1; }
git fetch origin main
commit="${1:-$(git rev-parse origin/main)}"
[[ "$commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "A full commit SHA is required." >&2; exit 1; }
commit="$(git rev-parse "${commit}^{commit}")"
git merge-base --is-ancestor "$commit" origin/main || { echo "The commit is not on origin/main." >&2; exit 1; }

release="$(mktemp -d "$SCRIPT_DIR/.deploy/releases/${commit}.XXXXXXXX")"
git archive "$commit" | tar -x -C "$release"
echo "Installing and testing commit $commit before restarting the bot..."
(
  cd "$release"
  npm ci --include=dev
  DB_PATH=:memory: npm test
)

previous_release=""
previous_commit=""
if pm2 describe clit-of-bot >/dev/null 2>&1; then
  previous_release="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const e=JSON.parse(s).find(p=>p.name==="clit-of-bot")?.pm2_env;if(e)process.stdout.write(e.BOT_RELEASE_DIR||require("node:path").dirname(require("node:path").dirname(e.pm_exec_path)));})')"
  previous_commit="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).find(p=>p.name==="clit-of-bot")?.pm2_env.BOT_DEPLOY_COMMIT||""))')"
fi
export BOT_RUNTIME_DIR="$SCRIPT_DIR"
export BOT_RELEASE_DIR="$release"
export BOT_DEPLOY_COMMIT="$commit"
export BOT_HEALTH_FILE="$SCRIPT_DIR/data/bot-health.json"

rollback() {
  status=$?
  trap - ERR
  echo "Deployment failed; database files and migration backups are preserved." >&2
  if [[ -n "$previous_release" && -f "$previous_release/ecosystem.config.cjs" ]]; then
    echo "Restarting the previous bot code. No database rollback will be performed." >&2
    pm2 delete clit-of-bot >/dev/null 2>&1 || true
    BOT_RELEASE_DIR="$previous_release" BOT_DEPLOY_COMMIT="$previous_commit" \
      pm2 start "$previous_release/ecosystem.config.cjs" --update-env || true
  else
    pm2 stop clit-of-bot >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback ERR

started_at="$(node -e 'process.stdout.write(String(Date.now()))')"
# Replace the process definition so PM2 cannot retain the previous script path.
if pm2 describe clit-of-bot >/dev/null 2>&1; then pm2 delete clit-of-bot; fi
pm2 start "$release/ecosystem.config.cjs" --update-env
echo "Waiting for Discord login and readiness for commit $commit..."
healthy=false
for ((attempt=0; attempt<60; attempt++)); do
  pid="$(pm2 pid clit-of-bot)"
  if node "$release/tools/check-deployment-health.mjs" "$BOT_HEALTH_FILE" "$commit" "$pid" "$started_at"; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo "The new bot did not become ready within two minutes." >&2
  false
fi

# Registration imports command modules; keep its database isolated from the running bot.
DB_PATH=:memory: node "$release/dist/deploy-commands.js"
pm2 save
printf '%s\n' "$commit" > .deploy/current-commit
printf '%s\n' "$release" > .deploy/current-release
trap - ERR
echo "Deployment verified: Discord is ready on commit $commit (PID $pid)."

# Keep the manual update entry point current after a successful immutable deployment.
# A dirty or divergent checkout must never block or undo the already healthy release.
if checkout_status="$(git status --porcelain)" && [[ -z "$checkout_status" ]]; then
  if git merge --ff-only --no-autostash --no-overwrite-ignore "$commit"; then
    echo "Canonical checkout updated; npm run update will use the current deployment script."
  else
    echo "Warning: the canonical checkout could not fast-forward. The verified release is still running." >&2
  fi
else
  echo "Warning: the canonical checkout has local changes or could not be checked. It was left untouched; the verified release is still running." >&2
fi
