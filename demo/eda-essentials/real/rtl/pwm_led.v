// pwm_led.v - 8-channel "breathing" LED driver for ECP5 (ULX3S, 25 MHz)
module pwm_led #(
    parameter integer DIV = 16          // prescaler bits: breath speed
) (
    input  wire       clk,
    input  wire       rst,
    output reg  [7:0] led
);
    reg [7:0]       pwm_cnt;            // PWM carrier
    reg [DIV-1:0]   pre;                // prescaler
    reg [7:0]       duty;               // current brightness
    reg             dir;                // 1 = getting brighter

    always @(posedge clk) begin
        if (rst) begin
            pwm_cnt <= 8'd0;
            pre     <= {DIV{1'b0}};
            duty    <= 8'd0;
            dir     <= 1'b1;
            led     <= 8'd0;
        end else begin
            pwm_cnt <= pwm_cnt + 8'd1;
            pre     <= pre + 1'b1;
            if (&pre) begin
                if (dir && duty == 8'hFF)      dir <= 1'b0;
                else if (!dir && duty == 8'h00) dir <= 1'b1;
                else duty <= dir ? duty + 8'd1 : duty - 8'd1;
            end
            // each LED is phase-shifted by 32 counts
            led[0] <= (pwm_cnt          ) < duty;
            led[1] <= (pwm_cnt + 8'd32  ) < duty;
            led[2] <= (pwm_cnt + 8'd64  ) < duty;
            led[3] <= (pwm_cnt + 8'd96  ) < duty;
            led[4] <= (pwm_cnt + 8'd128 ) < duty;
            led[5] <= (pwm_cnt + 8'd160 ) < duty;
            led[6] <= (pwm_cnt + 8'd192 ) < duty;
            led[7] <= (pwm_cnt + 8'd224 ) < duty;
        end
    end
endmodule
