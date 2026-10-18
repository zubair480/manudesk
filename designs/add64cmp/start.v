// add64cmp: s = a + b + c (64-bit operands, 66-bit result) and gt = s > d. Naive: both adds and the compare in one cycle.
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
