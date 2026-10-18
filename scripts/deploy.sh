#!/usr/bin/env bash
# Deploy ManuDesk to the backend VM from a dev machine (Linux, macOS, Git Bash).
# Usage: scripts/deploy.sh      env: MANUDESK_HOST (default ubuntu@160.211.47.50),
#                                    MANUDESK_KEY (default ~/.ssh/manudesk_vm)
set -euo pipefail

# Git Bash (MSYS) rewrites arguments that look like POSIX paths; disable it.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HOST="${MANUDESK_HOST:-ubuntu@160.211.47.50}"
KEY="${MANUDESK_KEY:-$HOME/.ssh/manudesk_vm}"
PORT=8765

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "error: $ROOT/.env not found (copy .env.example and fill it in)" >&2; exit 1; }
[ -f deploy/manudesk.service ] || { echo "error: deploy/manudesk.service missing" >&2; exit 1; }

SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

echo "==> checking ssh to $HOST"
remote true || { echo "error: cannot ssh to $HOST (is ${KEY}.pub in the VM's authorized_keys?)" >&2; exit 1; }

echo "==> syncing repo"
remote 'mkdir -p ~/manudesk'
tar -czf - \
  --exclude=.venv --exclude=work --exclude=runs --exclude=.git \
  --exclude=__pycache__ --exclude='*.pyc' --exclude=.pytest_cache --exclude=.ruff_cache \
  --exclude=.env \
  . | remote 'tar -xzf - -C ~/manudesk'

echo "==> copying .env"
remote 'umask 077 && cat > ~/manudesk/.env && chmod 600 ~/manudesk/.env' < .env

echo "==> bootstrap + uv sync"
remote 'bash ~/manudesk/scripts/bootstrap_vm.sh'
remote 'export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  cd ~/manudesk && uv sync'

echo "==> installing service"
remote 'sudo install -m 644 ~/manudesk/deploy/manudesk.service /etc/systemd/system/manudesk.service
  sudo systemctl daemon-reload
  sudo systemctl enable manudesk >/dev/null 2>&1
  sudo systemctl restart manudesk'

echo "==> health check"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if remote "curl -fsS http://127.0.0.1:$PORT/health"; then ok=1; echo; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "error: health check failed; recent logs:" >&2
  remote 'sudo journalctl -u manudesk -n 40 --no-pager' >&2 || true
  exit 1
fi
echo "deployed. Connect clients with scripts/connect.sh (and open TCP $PORT in the Crusoe firewall)."
