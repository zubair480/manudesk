// popcount: Population count of a 256-bit word. Naive: count all 256 bits in one cycle.
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
