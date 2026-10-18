// fir8: 8-tap FIR, signed 16-bit samples, fixed signed 16-bit coefficients. Naive: all products and the adder tree in one cycle.
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
