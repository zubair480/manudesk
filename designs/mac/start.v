// mac: 32x32 unsigned multiply-accumulate. acc <= acc + a*b every cycle. Naive: multiply and add in one stage.
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
