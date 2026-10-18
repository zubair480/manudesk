"""cocotb testbench for pwm_led: 8-LED phase-shifted breathing PWM driver (ECP5).

Run (Git Bash):  source /c/fpga/env.sh && .venv/Scripts/python test_pwm_led.py
"""
import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles, FallingEdge, RisingEdge

DIV = 4                 # prescaler bits -> duty steps every 2**DIV clocks
STEP = 2 ** DIV
PERIOD = 256            # PWM carrier period in clocks


async def start(dut, cycles=4):
    """Start the 25 MHz clock and hold reset for a few cycles."""
    Clock(dut.clk, 40, unit="ns").start()
    dut.rst.value = 1
    await ClockCycles(dut.clk, cycles)
    dut.rst.value = 0
    await FallingEdge(dut.clk)


@cocotb.test()
async def test_reset_clears(dut):
    """Reset drives every LED low and zeroes the duty register."""
    Clock(dut.clk, 40, unit="ns").start()
    dut.rst.value = 0
    await ClockCycles(dut.clk, 3 * STEP)          # let it run first
    dut.rst.value = 1
    await ClockCycles(dut.clk, 2)
    await FallingEdge(dut.clk)
    assert int(dut.led.value) == 0, f"led={dut.led.value}"
    assert int(dut.duty.value) == 0, f"duty={int(dut.duty.value)}"
    assert int(dut.dir.value) == 1, "dir should reset to 1 (brightening)"
    dut._log.info("reset: led=0b%s duty=%d dir=%d", dut.led.value, int(dut.duty.value), int(dut.dir.value))


@cocotb.test()
async def test_duty_ramp(dut):
    """duty climbs by exactly 1 every 2**DIV clocks while dir=1."""
    await start(dut)
    samples = []
    for _ in range(64):
        await ClockCycles(dut.clk, STEP)
        samples.append(int(dut.duty.value))
    steps = {b - a for a, b in zip(samples, samples[1:])}
    assert steps == {1}, f"non-unit duty steps: {sorted(steps)}"
    assert int(dut.dir.value) == 1
    dut._log.info("duty ramp: %d -> %d over %d clocks, step=+1 every %d clocks",
                  samples[0], samples[-1], 64 * STEP, STEP)


@cocotb.test()
async def test_led_phase_shift(dut):
    """Each LED k turns on 32*k counts ahead of LED0, with on-time ~= duty."""
    await start(dut)
    await ClockCycles(dut.clk, 128 * STEP)        # ramp to mid brightness
    duty0 = int(dut.duty.value)
    prev = int(dut.led.value)
    on = [0] * 8
    rise_cnt = [None] * 8
    for _ in range(PERIOD):
        await RisingEdge(dut.clk)
        await FallingEdge(dut.clk)
        led, cnt = int(dut.led.value), int(dut.pwm_cnt.value)
        for k in range(8):
            bit = (led >> k) & 1
            on[k] += bit
            if bit and not (prev >> k) & 1 and rise_cnt[k] is None:
                rise_cnt[k] = cnt
        prev = led
    duty1 = int(dut.duty.value)
    for k in range(8):
        assert duty0 - 2 <= on[k] <= duty1 + 2, f"led[{k}] on={on[k]} duty {duty0}..{duty1}"
        # led[k] <= (pwm_cnt + 32k) < duty  -> rises when pwm_cnt + 32k wraps to 0
        phase = (rise_cnt[k] - 1 + 32 * k) % 256
        assert phase == 0, f"led[{k}] rose at pwm_cnt={rise_cnt[k]} (phase error {phase})"
    dut._log.info("on-time per LED over 256 clks: %s (duty %d..%d)", on, duty0, duty1)
    dut._log.info("rise at pwm_cnt: %s -> 32-count phase shift confirmed", rise_cnt)


@cocotb.test()
async def test_direction_reverses(dut):
    """At full brightness dir flips to 0 and duty starts falling."""
    await start(dut)
    while int(dut.duty.value) != 255:
        await ClockCycles(dut.clk, STEP)
    await ClockCycles(dut.clk, 2 * STEP)
    assert int(dut.dir.value) == 0, "dir did not flip at duty=255"
    d_a = int(dut.duty.value)
    await ClockCycles(dut.clk, 8 * STEP)
    d_b = int(dut.duty.value)
    assert d_b < d_a, f"duty not falling: {d_a} -> {d_b}"
    dut._log.info("peak duty=255 passed; at t=%.2f us dir=0, duty falling %d -> %d",
                  cocotb.utils.get_sim_time("us"), d_a, d_b)


def test_runner():
    from cocotb_tools.runner import get_runner

    here = Path(__file__).resolve().parent
    rtl = here.parent / "rtl"
    runner = get_runner(os.getenv("SIM", "icarus"))
    runner.build(
        sources=[rtl / "pwm_led.v"],
        hdl_toplevel="pwm_led",
        parameters={"DIV": DIV},
        build_dir=here / "sim_build",
        timescale=("1ns", "1ps"),
        waves=False,
        always=True,
    )
    runner.test(
        hdl_toplevel="pwm_led",
        test_module="test_pwm_led",
        test_dir=here,
        build_dir=here / "sim_build",
        results_xml=here / "results.xml",
    )


if __name__ == "__main__":
    test_runner()
