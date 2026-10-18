module blinky(input clk, output [7:0] led);
  reg [25:0] cnt = 0;
  always @(posedge clk) cnt <= cnt + 1;
  assign led = cnt[25:18];
endmodule
