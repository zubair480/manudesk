// Hidden self-checking testbench for add64cmp. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg [63:0] a = 0, b = 0, c = 0;
    reg [65:0] d = 0;
    wire [65:0] s;
    wire gt;
    add64cmp dut (.clk(clk), .rst(rst), .a(a), .b(b), .c(c), .d(d), .s(s), .gt(gt));
    always #5 clk = ~clk;
    localparam N = 2000;
    reg [65:0] sh [0:N+16];
    reg gh [0:N+16];
    integer i, errors = 0, lat, j;
    initial begin
        lat = dut.LATENCY;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        for (i = 0; i < N; i = i + 1) begin
            a = (i % 31 == 0) ? {64{1'b1}} : {$random, $random};
            b = (i % 37 == 0) ? {64{1'b1}} : {$random, $random};
            c = (i % 41 == 0) ? {64{1'b1}} : {$random, $random};
            sh[i] = {2'b0, a} + {2'b0, b} + {2'b0, c};
            // half the time compare against a value within a few counts of the sum (exercises the carry)
            d = (i % 2) ? sh[i] + ($random & 3) - 1 : {$random, $random, $random};
            gh[i] = sh[i] > d;
            @(posedge clk); #1;
            j = i - lat + 1;
            if (j >= 0) begin
                if (s !== sh[j] || gt !== gh[j]) begin
                    errors = errors + 1;
                    if (errors < 5) $display("MISMATCH cycle %0d: s=%h ref=%h gt=%b ref=%b", i, s, sh[j], gt, gh[j]);
                end
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d", lat, N);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
