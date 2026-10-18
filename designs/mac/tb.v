// Hidden self-checking testbench for mac. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg [31:0] a = 0, b = 0;
    wire [63:0] acc;
    mac dut (.clk(clk), .rst(rst), .a(a), .b(b), .acc(acc));
    always #5 clk = ~clk;

    localparam N = 2000;
    reg [63:0] prod_hist [0:N+16];
    reg [63:0] ref_acc;
    integer i, errors = 0, lat;
    initial begin
        lat = dut.LATENCY;
        for (i = 0; i < N + 16; i = i + 1) prod_hist[i] = 0;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        ref_acc = 0;
        for (i = 0; i < N; i = i + 1) begin
            // edge-case values every so often
            a = (i % 97 == 0) ? 32'hFFFFFFFF : $random;
            b = (i % 89 == 0) ? 32'hFFFFFFFF : $random;
            prod_hist[i] = {32'd0, a} * {32'd0, b};
            @(posedge clk); #1;
            // after posedge number i (0-based), acc includes inputs 0..i-lat+1
            if (i - lat + 1 >= 0) ref_acc = ref_acc + prod_hist[i - lat + 1];
            if (acc !== ref_acc) begin
                errors = errors + 1;
                if (errors < 5) $display("MISMATCH cycle %0d: acc=%h ref=%h", i, acc, ref_acc);
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d final_acc=%h", lat, N, acc);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
