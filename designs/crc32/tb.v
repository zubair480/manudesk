// Hidden self-checking testbench for crc32. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg [63:0] data = 0;
    wire [31:0] crc;
    crc32 dut (.clk(clk), .rst(rst), .data(data), .crc(crc));
    always #5 clk = ~clk;
    localparam N = 2000;
    reg [63:0] dh [0:N+16];
    reg [31:0] ref_crc;
    integer i, errors = 0, lat, j, n, bit_i;

    function [31:0] ref_byte(input [31:0] c, input [7:0] b);
        integer t;
        reg [31:0] r;
        begin
            r = c ^ {24'd0, b};
            for (t = 0; t < 8; t = t + 1) r = r[0] ? (r >> 1) ^ 32'hEDB88320 : r >> 1;
            ref_byte = r;
        end
    endfunction

    initial begin
        lat = dut.LATENCY;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        ref_crc = 32'hFFFFFFFF;
        for (i = 0; i < N; i = i + 1) begin
            data = (i % 43 == 0) ? {64{1'b1}} : (i % 47 == 0) ? 64'd0 : {$random, $random};
            dh[i] = data;
            @(posedge clk); #1;
            j = i - lat + 1;   // newest word folded into crc now
            if (j >= 0) begin
                for (n = 0; n < 8; n = n + 1) ref_crc = ref_byte(ref_crc, dh[j][n*8 +: 8]);
                if (crc !== ref_crc) begin
                    errors = errors + 1;
                    if (errors < 5) $display("MISMATCH cycle %0d: crc=%h ref=%h", i, crc, ref_crc);
                end
            end else begin
                // pipeline still filling: the DUT folds the zero words it held at reset
                for (n = 0; n < 8; n = n + 1) ref_crc = ref_byte(ref_crc, 8'd0);
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d final_crc=%h", lat, N, crc);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
