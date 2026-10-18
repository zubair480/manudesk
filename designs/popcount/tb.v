// Hidden self-checking testbench for popcount. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg [255:0] din = 0;
    wire [8:0] count;
    popcount dut (.clk(clk), .rst(rst), .din(din), .count(count));
    always #5 clk = ~clk;
    localparam N = 2000;
    reg [8:0] ch [0:N+16];
    integer i, k, errors = 0, lat, j, m;
    initial begin
        lat = dut.LATENCY;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        for (i = 0; i < N; i = i + 1) begin
            for (k = 0; k < 8; k = k + 1) din[k*32 +: 32] = $random;
            if (i % 29 == 0) din = {256{1'b1}};
            if (i % 31 == 0) din = 0;
            if (i % 7 == 0) din = din & {8{$random}};   // sparser words
            m = 0;
            for (k = 0; k < 256; k = k + 1) m = m + din[k];
            ch[i] = m;
            @(posedge clk); #1;
            j = i - lat + 1;
            if (j >= 0 && count !== ch[j]) begin
                errors = errors + 1;
                if (errors < 5) $display("MISMATCH cycle %0d: count=%0d ref=%0d", i, count, ch[j]);
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d", lat, N);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
