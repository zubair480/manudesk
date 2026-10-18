// Hidden self-checking testbench for fir8. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg signed [15:0] x = 0;
    wire signed [34:0] y;
    fir8 dut (.clk(clk), .rst(rst), .x(x), .y(y));
    always #5 clk = ~clk;
    localparam N = 2000;
    reg signed [15:0] xh [0:N+16];
    reg signed [15:0] c [0:7];
    reg signed [34:0] ref_y;
    integer i, k, errors = 0, lat, j;
    initial begin
        c[0] = 1201; c[1] = -3407; c[2] = 9876; c[3] = 21011; c[4] = 21011; c[5] = 9876; c[6] = -3407; c[7] = 1201;
        lat = dut.LATENCY;
        for (i = 0; i < N + 16; i = i + 1) xh[i] = 0;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        for (i = 0; i < N; i = i + 1) begin
            x = (i % 53 == 0) ? 16'sh8000 : (i % 59 == 0) ? 16'sh7fff : $random;
            xh[i] = x;
            @(posedge clk); #1;
            j = i - lat + 1;   // newest sample visible in y now
            if (j >= 0) begin
                ref_y = 0;
                for (k = 0; k < 8; k = k + 1)
                    if (j - k >= 0) ref_y = ref_y + xh[j - k] * c[k];
                if (y !== ref_y) begin
                    errors = errors + 1;
                    if (errors < 5) $display("MISMATCH cycle %0d: y=%0d ref=%0d", i, y, ref_y);
                end
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d", lat, N);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
