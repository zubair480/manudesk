// sim_main.cpp - cycle-accurate C++ harness for the Verilated pwm_led model.
// Resets the design, runs N clock cycles, counts LED0 on-cycles and reports speed.
#include "Vpwm_led.h"
#include "verilated.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>

static inline unsigned pop8(unsigned v) {
    v = v - ((v >> 1) & 0x55u);
    v = (v & 0x33u) + ((v >> 2) & 0x33u);
    return (v + (v >> 4)) & 0x0Fu;
}

// legacy time hook verilated.cpp links against (normally provided by verilated.mk's defaults)
double sc_time_stamp() { return 0; }

int main(int argc, char** argv) {
    VerilatedContext* ctx = new VerilatedContext;
    ctx->commandArgs(argc, argv);
    uint64_t cycles = 20000000ULL;  // default 20 M cycles
    for (int i = 1; i < argc; ++i)
        if (argv[i][0] != '+') cycles = std::strtoull(argv[i], nullptr, 10);

    Vpwm_led* top = new Vpwm_led{ctx};
    // reset: 4 clock edges with rst high (same as the testbench)
    top->rst = 1;
    for (int i = 0; i < 4; ++i) { top->clk = 0; top->eval(); top->clk = 1; top->eval(); }
    top->rst = 0;

    uint64_t on0 = 0, ledHigh = 0;
    auto t0 = std::chrono::steady_clock::now();
    for (uint64_t c = 0; c < cycles; ++c) {
        top->clk = 0; top->eval();
        top->clk = 1; top->eval();
        on0 += top->led & 1u;
        ledHigh += pop8(top->led);
    }
    auto t1 = std::chrono::steady_clock::now();
    double sec = std::chrono::duration<double>(t1 - t0).count();

    std::printf("cycles       %llu\n", (unsigned long long)cycles);
    std::printf("led0_on      %llu (%.2f%% duty, avg)\n", (unsigned long long)on0, 100.0 * on0 / cycles);
    std::printf("led_on_total %llu (all 8 LEDs)\n", (unsigned long long)ledHigh);
    std::printf("wall_s       %.3f\n", sec);
    std::printf("cycles_per_s %.0f\n", cycles / sec);
    std::printf("sim_time     %.3f s of 25 MHz hardware\n", cycles / 25e6);
    top->final();
    delete top;
    delete ctx;
    return 0;
}
