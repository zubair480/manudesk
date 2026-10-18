#!/usr/bin/env bash
# Run on the backend VM: verify the chip toolchain and create the scratch dir.
set -euo pipefail

TOOLS="${MANUDESK_TOOLS:-/opt/fpga/oss-cad-suite/bin}"
WORK="${MANUDESK_WORK:-/var/tmp/manudesk}"

missing=0
for tool in yosys nextpnr-ecp5 iverilog vvp verilator_bin; do
  if [ -x "$TOOLS/$tool" ]; then
    echo "ok       $TOOLS/$tool"
  else
    echo "MISSING  $TOOLS/$tool" >&2
    missing=1
  fi
done

mkdir -p "$WORK"
echo "work dir $WORK ready"

if [ "$missing" -ne 0 ]; then
  echo "bootstrap failed: toolchain incomplete" >&2
  exit 1
fi
echo "bootstrap ok"
