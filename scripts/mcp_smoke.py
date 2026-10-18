"""Talk to a running ManuDesk server over real MCP: list tools, list designs, get one, check its start file.

    uv run python scripts/mcp_smoke.py [url]      (default http://127.0.0.1:8765/mcp, token from .env)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
from dotenv import load_dotenv
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main(url: str) -> int:
    load_dotenv()
    headers = {"Authorization": f"Bearer {os.environ['MANUDESK_TOKEN']}"}
    async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(300)) as http:
        async with streamable_http_client(url, http_client=http) as (read, write, *_):
            async with ClientSession(read, write) as s:
                await s.initialize()
                tools = await s.list_tools()
                print("tools:", [t.name for t in tools.tools])
                designs = json.loads((await s.call_tool("list_designs", {})).content[0].text)
                print("designs:", [d["name"] for d in designs])
                d = json.loads((await s.call_tool("get_design", {"name": "popcount"})).content[0].text)
                print("get_design keys:", sorted(d))
                r = (await s.call_tool("check", {"name": "popcount", "verilog": d["verilog"]})).content[0].text
                print("check:", r, f"({len(r)} chars)")
                return 0 if json.loads(r).get("pass") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/mcp")))
