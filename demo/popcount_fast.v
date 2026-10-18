// popcount, pipelined: the design a fresh agent reached through ManuDesk's check() loop.
// stages: din_r(1) -> nib_r: 64 x 4-bit counts(2) -> s1_r: 16 sums(3) -> s2_r: 4 sums(4) -> count_r(5)
module popcount (
    input  wire         clk,
    input  wire         rst,
    input  wire [255:0] din,
    output wire [8:0]   count
);
    localparam LATENCY = 5;
    reg [255:0] din_r;
    reg [191:0] nib_r;   // 64 x 3-bit counts of 4 bits each (0..4)
    reg [79:0]  s1_r;    // 16 x 5-bit sums of 4 nibble counts (0..16)
    reg [27:0]  s2_r;    // 4 x 7-bit sums (0..64)
    reg [8:0]   count_r;
    integer i;
    always @(posedge clk) begin
        if (rst) begin
            din_r <= 0; nib_r <= 0; s1_r <= 0; s2_r <= 0; count_r <= 0;
        end else begin
            din_r <= din;
            for (i = 0; i < 64; i = i + 1)
                nib_r[i*3 +: 3] <= din_r[i*4] + din_r[i*4+1] + din_r[i*4+2] + din_r[i*4+3];
            for (i = 0; i < 16; i = i + 1)
                s1_r[i*5 +: 5] <= nib_r[(i*4)*3 +: 3] + nib_r[(i*4+1)*3 +: 3]
                                + nib_r[(i*4+2)*3 +: 3] + nib_r[(i*4+3)*3 +: 3];
            for (i = 0; i < 4; i = i + 1)
                s2_r[i*7 +: 7] <= s1_r[(i*4)*5 +: 5] + s1_r[(i*4+1)*5 +: 5]
                                + s1_r[(i*4+2)*5 +: 5] + s1_r[(i*4+3)*5 +: 5];
            count_r <= s2_r[6:0] + s2_r[13:7] + s2_r[20:14] + s2_r[27:21];
        end
    end
    assign count = count_r;
endmodule
