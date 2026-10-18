// mandel_step: One Mandelbrot iteration z' = z^2 + c in signed Q3.14, plus escaped = |z|^2 > 4 on the input z. Naive: three multiplies, adds and compare in one cycle.
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
