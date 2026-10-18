`ifndef VERILATOR
module testbench;
  reg [4095:0] vcdfile;
  reg clock;
`else
module testbench(input clock, output reg genclock);
  initial genclock = 1;
`endif
  reg genclock = 1;
  reg [31:0] cycle = 0;
  reg [0:0] PI_rst;
  wire [0:0] PI_clk = clock;
  pwm_led UUT (
    .rst(PI_rst),
    .clk(PI_clk)
  );
`ifndef VERILATOR
  initial begin
    if ($value$plusargs("vcd=%s", vcdfile)) begin
      $dumpfile(vcdfile);
      $dumpvars(0, testbench);
    end
    #5 clock = 0;
    while (genclock) begin
      #5 clock = 0;
      #5 clock = 1;
    end
  end
`endif
  initial begin
`ifndef VERILATOR
    #1;
`endif
    // UUT.$auto$async2sync.\cc:107:execute$185  = 1'b0;
    // UUT.$auto$async2sync.\cc:107:execute$191  = 1'b0;
    // UUT.$auto$async2sync.\cc:116:execute$183  = 1'b1;
    // UUT.$auto$async2sync.\cc:116:execute$189  = 1'b1;
    // UUT.$auto$async2sync.\cc:116:execute$195  = 1'b1;
    UUT._witness_.anyinit_procdff_167 = 1'b0;
    UUT._witness_.anyinit_procdff_168 = 1'b0;
    UUT._witness_.anyinit_procdff_169 = 1'b0;
    UUT._witness_.anyinit_procdff_170 = 1'b0;
    UUT._witness_.anyinit_procdff_171 = 8'b00000000;
    UUT._witness_.anyinit_procdff_172 = 1'b0;
    UUT.dir = 1'b0;
    UUT.duty = 8'b00000000;
    UUT.led = 8'b00000000;
    UUT.past_valid = 1'b0;
    UUT.pre = 2'b00;
    UUT.pwm_cnt = 8'b00000000;

    // state 0
    PI_rst = 1'b1;
  end
  always @(posedge clock) begin
    // state 1
    if (cycle == 0) begin
      PI_rst <= 1'b0;
    end

    // state 2
    if (cycle == 1) begin
      PI_rst <= 1'b0;
    end

    // state 3
    if (cycle == 2) begin
      PI_rst <= 1'b0;
    end

    // state 4
    if (cycle == 3) begin
      PI_rst <= 1'b0;
    end

    // state 5
    if (cycle == 4) begin
      PI_rst <= 1'b0;
    end

    // state 6
    if (cycle == 5) begin
      PI_rst <= 1'b0;
    end

    // state 7
    if (cycle == 6) begin
      PI_rst <= 1'b0;
    end

    // state 8
    if (cycle == 7) begin
      PI_rst <= 1'b0;
    end

    // state 9
    if (cycle == 8) begin
      PI_rst <= 1'b0;
    end

    // state 10
    if (cycle == 9) begin
      PI_rst <= 1'b0;
    end

    // state 11
    if (cycle == 10) begin
      PI_rst <= 1'b0;
    end

    // state 12
    if (cycle == 11) begin
      PI_rst <= 1'b0;
    end

    // state 13
    if (cycle == 12) begin
      PI_rst <= 1'b0;
    end

    // state 14
    if (cycle == 13) begin
      PI_rst <= 1'b0;
    end

    // state 15
    if (cycle == 14) begin
      PI_rst <= 1'b0;
    end

    // state 16
    if (cycle == 15) begin
      PI_rst <= 1'b0;
    end

    // state 17
    if (cycle == 16) begin
      PI_rst <= 1'b0;
    end

    // state 18
    if (cycle == 17) begin
      PI_rst <= 1'b0;
    end

    // state 19
    if (cycle == 18) begin
      PI_rst <= 1'b0;
    end

    // state 20
    if (cycle == 19) begin
      PI_rst <= 1'b0;
    end

    // state 21
    if (cycle == 20) begin
      PI_rst <= 1'b0;
    end

    // state 22
    if (cycle == 21) begin
      PI_rst <= 1'b0;
    end

    // state 23
    if (cycle == 22) begin
      PI_rst <= 1'b0;
    end

    // state 24
    if (cycle == 23) begin
      PI_rst <= 1'b0;
    end

    // state 25
    if (cycle == 24) begin
      PI_rst <= 1'b0;
    end

    // state 26
    if (cycle == 25) begin
      PI_rst <= 1'b0;
    end

    // state 27
    if (cycle == 26) begin
      PI_rst <= 1'b0;
    end

    // state 28
    if (cycle == 27) begin
      PI_rst <= 1'b0;
    end

    // state 29
    if (cycle == 28) begin
      PI_rst <= 1'b0;
    end

    // state 30
    if (cycle == 29) begin
      PI_rst <= 1'b0;
    end

    // state 31
    if (cycle == 30) begin
      PI_rst <= 1'b0;
    end

    // state 32
    if (cycle == 31) begin
      PI_rst <= 1'b0;
    end

    // state 33
    if (cycle == 32) begin
      PI_rst <= 1'b0;
    end

    // state 34
    if (cycle == 33) begin
      PI_rst <= 1'b0;
    end

    // state 35
    if (cycle == 34) begin
      PI_rst <= 1'b0;
    end

    genclock <= cycle < 35;
    cycle <= cycle + 1;
  end
endmodule
