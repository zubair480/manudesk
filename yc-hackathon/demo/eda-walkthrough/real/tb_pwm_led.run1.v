`timescale 1ns/1ps
module tb_pwm_led;
    reg clk = 0, rst = 1;
    wire [7:0] led;
    integer on0, errors = 0, t;
    pwm_led #(.DIV(4)) dut (.clk(clk), .rst(rst), .led(led));
    always #20 clk = ~clk;              // 25 MHz

    initial begin
        $dumpfile("pwm_led.vcd");
        $dumpvars(0, tb_pwm_led);
        repeat (4) @(posedge clk);
        rst = 0;
        $display("[%0t] reset released", $time);

        // Test 1: duty ramps up from 0
        repeat (16*40) @(posedge clk);
        if (dut.duty > 8'd30 && dut.dir == 1) $display("PASS test1 duty ramping up: duty=%0d", dut.duty);
        else begin $display("FAIL test1 duty=%0d dir=%0d", dut.duty, dut.dir); errors = errors + 1; end

        // Test 2: LED0 on-time over one PWM period matches duty
        on0 = 0;
        for (t = 0; t < 256; t = t + 1) begin @(posedge clk); on0 = on0 + led[0]; end
        if (on0 >= dut.duty - 2 && on0 <= dut.duty + 2) $display("PASS test2 led0 on-time %0d/256 ~ duty %0d", on0, dut.duty);
        else begin $display("FAIL test2 on0=%0d duty=%0d", on0, dut.duty); errors = errors + 1; end

        // Test 3: direction flips at full brightness
        wait (dut.duty == 8'hFF); repeat (40) @(posedge clk);
        if (dut.dir == 0) $display("PASS test3 direction reversed at duty=255");
        else begin $display("FAIL test3 dir did not flip"); errors = errors + 1; end

        // Test 4: reset clears outputs
        rst = 1; @(posedge clk); @(posedge clk);
        if (led == 8'd0 && dut.duty == 0) $display("PASS test4 reset clears led and duty");
        else begin $display("FAIL test4 led=%b", led); errors = errors + 1; end

        if (errors == 0) $display("ALL TESTS PASSED (4/4)");
        else $display("TESTS FAILED: %0d", errors);
        $finish;
    end
endmodule
