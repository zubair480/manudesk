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
      PI_rst <= 1'b1;
    end

    // state 6
    if (cycle == 5) begin
      PI_rst <= 1'b0;
    end

    // state 7
    if (cycle == 6) begin
      PI_rst <= 1'b0;
    end

    genclock <= cycle < 7;
    cycle <= cycle + 1;
  end
endmodule
