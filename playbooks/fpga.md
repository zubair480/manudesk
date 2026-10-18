# FPGA playbook (ECP5-85F, speed 6)
Starter heuristics, not yet backed by ManuDesk measurements. The reflector replaces them with measured rules.

1. Put wide multiplies on DSPs: split operands into 18-bit limbs and use mul18x18_reg (latency 2) for each partial product; never write a raw 32x32 `*` in one cycle.
2. Register the operands before a multiplier and the partial products after it; add the partials in a separate registered stage.
3. Split carry chains wider than about 32 bits: add the low half, register its carry, add the high half next cycle, and delay the other half to match.
4. Popcount, XOR/CRC and wide adds: use a balanced reduction tree with a register every 1-2 levels, not a linear loop.
5. LATENCY bookkeeping: every input-to-output path must cross the same number of registers; delay side signals (valid, low halves, sign bits) to match, then set `localparam LATENCY` to that count and stay within latency_budget.
6. An accumulator recurrence (acc <= acc + x) must stay one register: pipeline everything that feeds x, never the loop itself, or the sum changes.
