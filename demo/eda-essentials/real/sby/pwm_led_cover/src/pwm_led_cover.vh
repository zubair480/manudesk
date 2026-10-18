// pwm_led_cover.vh - cover goals for pwm_led: ask the solver to FIND reachable hardware states.
// `included inside the module by make_cover.py. Same reset assumption as pwm_led_props.vh.
`ifdef FORMAL
    reg past_valid = 1'b0;
    always @(posedge clk) past_valid <= 1'b1;

    // start every trace from reset
    always @(*) if (!past_valid) assume(rst);

    always @(posedge clk) if (past_valid && !$past(rst)) begin
        // C1: brightness climbs four steps
        duty_reaches_4: cover(duty == 8'd4);
        // C2: the first LED (led[7], phase +224) switches on
        first_led_on:   cover(led[7]);
    end

    // C3: the solver presses reset in the middle of a ramp (rst is a free input)
    always @(posedge clk) if (past_valid && $past(past_valid))
        reset_mid_ramp: cover($past(rst) && !$past(rst, 2) && $past(duty) != 8'd0);
`endif
