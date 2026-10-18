#!/usr/bin/env bash
# Print client setup commands for the ManuDesk MCP server.
# Usage: scripts/connect.sh [--show] [--host HOST]
#   Token is read from .env and masked unless --show is given.
set -euo pipefail

SHOW=0
HOST="${MANUDESK_PUBLIC_HOST:-160.211.47.50}"
while [ $# -gt 0 ]; do
  case "$1" in
    --show) SHOW=1 ;;
    --host) HOST="${2:?--host needs a value}"; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN="${MANUDESK_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ROOT/.env" ]; then
  TOKEN="$(sed -n -E "s/^MANUDESK_TOKEN=//p" "$ROOT/.env" | head -n1 | sed -E "s/^['\"]//; s/['\"]\$//")"
fi
[ -n "$TOKEN" ] || { echo "error: MANUDESK_TOKEN not found in environment or $ROOT/.env" >&2; exit 1; }

URL="http://$HOST:8765/mcp"
if [ "$SHOW" -eq 1 ]; then
  SHOWN="$TOKEN"
else
  SHOWN='$MANUDESK_TOKEN'
fi

echo "# Claude Code"
if [ "$SHOW" -eq 1 ]; then
  echo "claude mcp add --transport http manudesk $URL --header \"Authorization: Bearer $SHOWN\""
else
  echo "# (export MANUDESK_TOKEN first, or rerun with --show to print the real value)"
  echo "claude mcp add --transport http manudesk $URL --header \"Authorization: Bearer $SHOWN\""
fi
echo
echo "# Cursor: add to ~/.cursor/mcp.json"
cat <<JSON
{
  "mcpServers": {
    "manudesk": {
      "url": "$URL",
      "headers": { "Authorization": "Bearer $SHOWN" }
    }
  }
}
JSON
echo
echo "# Health check (no auth)"
echo "curl http://$HOST:8765/health"
