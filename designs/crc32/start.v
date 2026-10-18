// crc32: CRC-32 (reflected poly 0xEDB88320), 64 data bits per cycle, LSB first, state reset to 0xFFFFFFFF, raw state out. Naive: whole update in one cycle.
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
