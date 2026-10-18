-- Seed md_designs from designs/*/spec.json + start.v (tb.v and spec mutants are never stored).
INSERT INTO public.md_designs (name, top, summary, baseline_mhz, target_mhz, latency_budget, resource_budget, start_verilog) VALUES
  ($md$add64cmp$md$, $md$add64cmp$md$, $md$s = a + b + c (three 64-bit operands, 66-bit result) and gt = (a + b + c) > d, registered.$md$, 85.7, 149, 6, $md${"FF": 2000, "LUT": 3000}$md$::jsonb, $md$// add64cmp: s = a + b + c (64-bit operands, 66-bit result) and gt = s > d. Naive: both adds and the compare in one cycle.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module add64cmp (
    input  wire        clk,
    input  wire        rst,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [63:0] c,
    input  wire [65:0] d,
    output wire [65:0] s,
    output wire        gt
);
    localparam LATENCY = 2;
    reg [63:0] a_r, b_r, c_r;
    reg [65:0] d_r, s_r;
    reg gt_r;
    wire [65:0] sum = {2'b0, a_r} + {2'b0, b_r} + {2'b0, c_r};
    always @(posedge clk) begin
        if (rst) begin
            a_r <= 0; b_r <= 0; c_r <= 0; d_r <= 0; s_r <= 0; gt_r <= 0;
        end else begin
            a_r <= a; b_r <= b; c_r <= c; d_r <= d;
            s_r <= sum;
            gt_r <= sum > d_r;
        end
    end
    assign s = s_r;
    assign gt = gt_r;
endmodule
$md$),
  ($md$crc32$md$, $md$crc32$md$, $md$CRC-32 (reflected polynomial 0xEDB88320) over 64 data bits per cycle, LSB first, state reset to 0xFFFFFFFF, raw state output.$md$, 61.1, 104, 6, $md${"FF": 1000, "LUT": 4000}$md$::jsonb, $md$// crc32: CRC-32 (reflected poly 0xEDB88320), 64 data bits per cycle, LSB first, state reset to 0xFFFFFFFF, raw state out. Naive: whole update in one cycle.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module crc32 (
    input  wire        clk,
    input  wire        rst,
    input  wire [63:0] data,
    output wire [31:0] crc
);
    localparam LATENCY = 2;
    reg [63:0] data_r;
    reg [31:0] crc_r;

    function [31:0] next_crc(input [31:0] c, input [63:0] d);
        integer k;
        reg [31:0] r;
        begin
            r = c;
            for (k = 0; k < 64; k = k + 1)
                r = (r >> 1) ^ (32'hEDB88320 & {32{r[0] ^ d[k]}});
            next_crc = r;
        end
    endfunction

    always @(posedge clk) begin
        if (rst) begin
            data_r <= 0;
            crc_r  <= 32'hFFFFFFFF;
        end else begin
            data_r <= data;
            crc_r  <= next_crc(crc_r, data_r);
        end
    end
    assign crc = crc_r;
endmodule
$md$),
  ($md$fir8$md$, $md$fir8$md$, $md$8-tap FIR, signed 16-bit samples, fixed symmetric signed 16-bit coefficients, full-precision 35-bit output.$md$, 66.4, 107, 8, $md${"DSP": 16, "FF": 2000, "LUT": 4000}$md$::jsonb, $md$// fir8: 8-tap FIR, signed 16-bit samples, fixed signed 16-bit coefficients. Naive: all products and the adder tree in one cycle.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module fir8 (
    input  wire               clk,
    input  wire               rst,
    input  wire signed [15:0] x,
    output wire signed [34:0] y
);
    localparam LATENCY = 2;
    localparam signed [15:0] C0 = 16'sd1201,  C1 = -16'sd3407, C2 = 16'sd9876,  C3 = 16'sd21011;
    localparam signed [15:0] C4 = 16'sd21011, C5 = 16'sd9876,  C6 = -16'sd3407, C7 = 16'sd1201;
    reg signed [15:0] t0, t1, t2, t3, t4, t5, t6, t7;
    reg signed [34:0] y_r;
    always @(posedge clk) begin
        if (rst) begin
            t0 <= 0; t1 <= 0; t2 <= 0; t3 <= 0; t4 <= 0; t5 <= 0; t6 <= 0; t7 <= 0; y_r <= 0;
        end else begin
            t0 <= x; t1 <= t0; t2 <= t1; t3 <= t2; t4 <= t3; t5 <= t4; t6 <= t5; t7 <= t6;
            y_r <= t0 * C0 + t1 * C1 + t2 * C2 + t3 * C3 + t4 * C4 + t5 * C5 + t6 * C6 + t7 * C7;
        end
    end
    assign y = y_r;
endmodule
$md$),
  ($md$mac$md$, $md$mac$md$, $md$32x32 unsigned multiply-accumulate into a 64-bit accumulator. acc <= acc + a*b every cycle, synchronous active-high reset.$md$, 74.4, 138, 8, $md${"DSP": 8, "FF": 1200, "LUT": 2000}$md$::jsonb, $md$// mac: 32x32 unsigned multiply-accumulate. acc <= acc + a*b every cycle. Naive: multiply and add in one stage.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module mac (
    input  wire        clk,
    input  wire        rst,
    input  wire [31:0] a,
    input  wire [31:0] b,
    output wire [63:0] acc
);
    localparam LATENCY = 2;
    reg [31:0] a_r, b_r;
    reg [63:0] acc_r;
    always @(posedge clk) begin
        if (rst) begin
            a_r <= 0; b_r <= 0; acc_r <= 0;
        end else begin
            a_r   <= a;
            b_r   <= b;
            acc_r <= acc_r + a_r * b_r;   // 32x32 multiply and 64-bit add in one cycle
        end
    end
    assign acc = acc_r;
endmodule
$md$),
  ($md$mandel_step$md$, $md$mandel_step$md$, $md$One Mandelbrot iteration z' = z^2 + c in signed Q3.14 (18-bit), outputs wrapped to 18 bits, plus escaped = |z|^2 > 4 on the input z.$md$, 79.1, 130, 6, $md${"DSP": 6, "FF": 1000, "LUT": 2000}$md$::jsonb, $md$// mandel_step: One Mandelbrot iteration z' = z^2 + c in signed Q3.14, plus escaped = |z|^2 > 4 on the input z. Naive: three multiplies, adds and compare in one cycle.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module mandel_step (
    input  wire               clk,
    input  wire               rst,
    input  wire signed [17:0] zr,
    input  wire signed [17:0] zi,
    input  wire signed [17:0] cr,
    input  wire signed [17:0] ci,
    output wire signed [17:0] zr_next,
    output wire signed [17:0] zi_next,
    output wire               escaped
);
    localparam LATENCY = 2;
    reg signed [17:0] zr_r, zi_r, cr_r, ci_r;
    reg signed [17:0] zr_o, zi_o;
    reg esc_o;
    wire signed [35:0] rr = zr_r * zr_r;
    wire signed [35:0] ii = zi_r * zi_r;
    wire signed [35:0] ri = zr_r * zi_r;
    wire signed [36:0] diff = rr - ii;
    wire signed [36:0] mag  = rr + ii;
    always @(posedge clk) begin
        if (rst) begin
            zr_r <= 0; zi_r <= 0; cr_r <= 0; ci_r <= 0; zr_o <= 0; zi_o <= 0; esc_o <= 0;
        end else begin
            zr_r <= zr; zi_r <= zi; cr_r <= cr; ci_r <= ci;
            zr_o  <= diff[31:14] + cr_r;          // (zr^2 - zi^2) >> 14, wrapped to 18 bits
            zi_o  <= ri[30:13] + ci_r;            // 2*zr*zi >> 14 == zr*zi >> 13
            esc_o <= mag > 37'sd1073741824;       // |z|^2 > 4.0 (4 << 28)
        end
    end
    assign zr_next = zr_o;
    assign zi_next = zi_o;
    assign escaped = esc_o;
endmodule
$md$),
  ($md$popcount$md$, $md$popcount$md$, $md$Population count of a 256-bit word, 9-bit result, registered.$md$, 70.0, 105, 6, $md${"FF": 2000, "LUT": 3000}$md$::jsonb, $md$// popcount: Population count of a 256-bit word. Naive: count all 256 bits in one cycle.
// Latency contract: an input applied before clock edge n shows on the outputs after edge n+LATENCY-1.
module popcount (
    input  wire         clk,
    input  wire         rst,
    input  wire [255:0] din,
    output wire [8:0]   count
);
    localparam LATENCY = 2;
    reg [255:0] din_r;
    reg [8:0]   count_r;
    integer k;
    reg [8:0] acc;
    always @(*) begin
        acc = 0;
        for (k = 0; k < 256; k = k + 1) acc = acc + din_r[k];
    end
    always @(posedge clk) begin
        if (rst) begin
            din_r <= 0; count_r <= 0;
        end else begin
            din_r <= din;
            count_r <= acc;
        end
    end
    assign count = count_r;
endmodule
$md$)
ON CONFLICT (name) DO UPDATE SET top = EXCLUDED.top, summary = EXCLUDED.summary, baseline_mhz = EXCLUDED.baseline_mhz,
  target_mhz = EXCLUDED.target_mhz, latency_budget = EXCLUDED.latency_budget,
  resource_budget = EXCLUDED.resource_budget, start_verilog = EXCLUDED.start_verilog;

-- Seed md_playbooks v1 from Crusoe-Forge playbooks/fpga.md, keeping only rules with measured numbers.
INSERT INTO public.md_playbooks (version, body, evidence, dropped) VALUES
  (1, $md$# FPGA timing-closure playbook v1 (ECP5)
Seeded from Crusoe-Forge playbooks/fpga.md. Only rules backed by a measured number are kept; the reflector replaces this with ManuDesk evidence.

1. **Adder-chain pipelining**: insert a pipeline register after a wide adder tree to break long carry chains. On mac, a register after the 64-bit partial-product sum raised fmax from 137.31 MHz to 157.16 MHz, latency 3 -> 4 cycles.
2. **Accurate LATENCY parameter**: `localparam LATENCY` must equal the pipeline stages from input to output. Forgetting to update it after adding a register caused a functional rejection on mac; with LATENCY = 4 the design passed and met the 138 MHz target.
3. **Lint-first verification**: fix lint and syntax errors before timing iterations. A missing bracket halted a design that would otherwise have met 107 MHz with 4-cycle latency.
$md$, $md$[{"rule": 1, "design": "mac", "source": "Crusoe-Forge train_mac_111659", "mhz_before": 137.31, "mhz_after": 157.16, "lat_before": 3, "lat_after": 4}, {"rule": 2, "design": "mac", "source": "Crusoe-Forge train_mac_111659", "target_mhz": 138, "lat": 4}, {"rule": 3, "source": "Crusoe-Forge playbooks/fpga.md", "mhz": 107, "lat": 4}]$md$::jsonb, $md$[{"rule": "DSP width matching (zero/sign-extend slices to 18 bits)", "reason": "no measured fmax/latency number"}, {"rule": "Avoid combinational paths across DSPs", "reason": "no measured number"}, {"rule": "DSP-based multiplier connection (full-width operands, register product)", "reason": "no measured number"}, {"rule": "Balanced adder-tree pipelining", "reason": "dropped by the Crusoe-Forge reflector gate (unsupported)"}, {"rule": "Best mac RTL example block", "reason": "example code, not a rule"}]$md$::jsonb)
ON CONFLICT (version) DO NOTHING;
