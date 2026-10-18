// Hidden self-checking testbench for mandel_step. Reference model aligned by dut.LATENCY.
`timescale 1ns/1ps
module tb;
    reg clk = 0, rst = 1;
    reg signed [17:0] zr = 0, zi = 0, cr = 0, ci = 0;
    wire signed [17:0] zrn, zin;
    wire esc;
    mandel_step dut (.clk(clk), .rst(rst), .zr(zr), .zi(zi), .cr(cr), .ci(ci),
                     .zr_next(zrn), .zi_next(zin), .escaped(esc));
    always #5 clk = ~clk;
    localparam N = 2000;
    reg [17:0] rh [0:N+16];
    reg [17:0] ih [0:N+16];
    reg        eh [0:N+16];
    reg signed [63:0] r64, i64, rr, ii, ri, t;
    integer i, errors = 0, lat, j;
    initial begin
        lat = dut.LATENCY;
        @(posedge clk); @(posedge clk); #1 rst = 0;
        for (i = 0; i < N; i = i + 1) begin
            zr = $random; zi = $random; cr = $random; ci = $random;
            if (i % 5 == 0) begin zr = zr >>> 3; zi = zi >>> 3; end      // values near |z| = 2
            if (i % 61 == 0) begin zr = 18'sh20000; zi = 18'sh20000; end  // most negative
            if (i % 67 == 0) begin zr = 18'sh08000; zi = 0; end          // exactly 2.0: |z|^2 == 4, not escaped
            r64 = zr; i64 = zi;
            rr = r64 * r64; ii = i64 * i64; ri = r64 * i64;
            t = ((rr - ii) >>> 14) + cr;  rh[i] = t[17:0];
            t = (ri >>> 13) + ci;         ih[i] = t[17:0];
            eh[i] = (rr + ii) > 64'sd1073741824;
            @(posedge clk); #1;
            j = i - lat + 1;
            if (j >= 0 && (zrn !== rh[j] || zin !== ih[j] || esc !== eh[j])) begin
                errors = errors + 1;
                if (errors < 5) $display("MISMATCH cycle %0d: zr'=%h ref=%h zi'=%h ref=%h esc=%b ref=%b",
                                         i, zrn, rh[j], zin, ih[j], esc, eh[j]);
            end
        end
        if (errors == 0) $display("PASS latency=%0d cycles=%0d", lat, N);
        else $display("FAIL errors=%0d", errors);
        $finish;
    end
endmodule
