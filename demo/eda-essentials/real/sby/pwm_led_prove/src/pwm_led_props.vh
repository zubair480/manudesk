// pwm_led_props.vh - formal properties for pwm_led, `included inside the module
`ifdef FORMAL
    reg past_valid = 1'b0;
    always @(posedge clk) past_valid <= 1'b1;

    // start every trace from reset
    always @(*) if (!past_valid) assume(rst);

    always @(posedge clk) if (past_valid && !$past(rst)) begin
        // P1: brightness never wraps 255 -> 0 or 0 -> 255
        duty_no_wrap_up:   assert(!($past(duty) == 8'hFF && duty == 8'h00));
        duty_no_wrap_down: assert(!($past(duty) == 8'h00 && duty == 8'hFF));
        // P2: direction only flips at the extremes
        if (dir != $past(dir))
            dir_flip_at_ends: assert($past(duty) == 8'hFF || $past(duty) == 8'h00);
        // P3: duty moves by at most one step per clock
        duty_step: assert(duty == $past(duty) || duty == $past(duty) + 8'd1
                                              || duty == $past(duty) - 8'd1);
    end

    // P4: all LEDs are dark one cycle after reset
    always @(posedge clk) if (past_valid && $past(rst))
        leds_off_after_rst: assert(led == 8'h00);
`endif
