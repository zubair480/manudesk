# Connecting to ManuDesk

ManuDesk is an MCP server (streamable HTTP, bearer-token auth) that exposes
`list_designs`, `get_design` and `check(name, verilog)`. It serves MCP at
`/mcp` and an unauthenticated `GET /health` on port 8765.

## 1. Prerequisites

- The server is deployed (`scripts/deploy.sh`) and `/health` answers.
- **TCP 8765 is open** in the Crusoe Cloud firewall / security group for the VM
  (inbound, from the clients that need access). Crusoe blocks it by default, so
  without this every remote client times out even though the service is healthy.
- You have the token (`MANUDESK_TOKEN` in the repo's `.env`).

## 2. Health check

```bash
curl http://160.211.47.50:8765/health
```

Expect a 200 with a small JSON/OK body. No token is needed.

## 3. Claude Code

```bash
export MANUDESK_TOKEN='<token from .env>'
claude mcp add --transport http manudesk http://160.211.47.50:8765/mcp \
  --header "Authorization: Bearer $MANUDESK_TOKEN"
```

`scripts/connect.sh` prints this command (token masked; `--show` prints it, and
`--host` overrides the address). Verify with `claude mcp list` or `/mcp` inside
Claude Code; `manudesk` should show as connected with three tools.

## 4. Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "manudesk": {
      "url": "http://160.211.47.50:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Reload Cursor, then enable `manudesk` under Settings, MCP.
Don't commit this file if it contains the real token.

## 5. Deploying

```bash
scripts/deploy.sh                 # uses ~/.ssh/manudesk_vm and ubuntu@160.211.47.50
MANUDESK_HOST=ubuntu@other-host scripts/deploy.sh
```

It copies the repo and `.env` (mode 600), installs `uv` if missing, runs
`uv sync`, installs `deploy/manudesk.service`, restarts it, and curls
`/health` on the VM. Logs: `sudo journalctl -u manudesk -f`.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Permission denied (publickey)` on deploy | Add `~/.ssh/manudesk_vm.pub` to `~/.ssh/authorized_keys` on the VM. |
| `/health` works on the VM but times out remotely | TCP 8765 not open in the Crusoe firewall. |
| `401 Unauthorized` from `/mcp` | Token mismatch; the client header must be exactly `Authorization: Bearer <MANUDESK_TOKEN>`. After changing `.env`, redeploy or `sudo systemctl restart manudesk`. |
| Client says connected but no tools | Use `--transport http` (not `sse`) and the `/mcp` path. |
| `check` reports tool not found | Run `scripts/bootstrap_vm.sh` on the VM; confirm `MANUDESK_TOOLS=/opt/fpga/oss-cad-suite/bin`. |
| Service restarts in a loop | `sudo journalctl -u manudesk -n 100`; common causes are a missing `.env` or `uv sync` not having run. |
| `.env` values with `$` or `/` break | Single-quote them, e.g. `MANUDESK_TOKEN='abc$def'`. |
| Git Bash mangles paths in deploy | The script sets `MSYS_NO_PATHCONV=1`; if you run ssh by hand, set it too. |
