# EDA essentials demo

This is a browser walkthrough of an AI agent driving the real FPGA toolchain over MCP. It runs on the `pwm_led` design, an 8-LED breathing PWM driver for the ECP5/ULX3S board.

Scenes, in order: Verilog → Icarus (fail, fix, pass) → GTKWave → Yosys → nextpnr 3D → KiCad 3D board → Results.

All tool output is real, captured locally with OSS CAD Suite. The agent lane at the top shows each scene's MCP call (data/agent-calls.json). ManuDesk's real MCP tool is `check`; the finer-grained names in the lane are the proposed surface. See THESIS.md and REAL-CODE.md for details.

To run it locally:

    cd demo/eda-essentials && python -m http.server 5174
    # open http://localhost:5174/
