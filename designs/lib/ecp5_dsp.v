// ECP5 18x18 multiplier with the DSP's own input and output registers on. Latency 2 cycles
// (a, b sampled at edge n, p valid after edge n+1). Yosys never sets the REG_* options when it infers
// MULT18X18D, so this instantiates the primitive. Under simulation it is an equivalent behavioural model.
module mul18x18_reg #(parameter SIGNED = 0) (
    input  wire        clk,
    input  wire        ce,
    input  wire        rst,
    input  wire [17:0] a,
    input  wire [17:0] b,
    output wire [35:0] p
);
`ifdef SYNTHESIS
    wire [35:0] p_w;
    MULT18X18D #(
        .REG_INPUTA_CLK("CLK0"), .REG_INPUTA_CE("CE0"), .REG_INPUTA_RST("RST0"),
        .REG_INPUTB_CLK("CLK0"), .REG_INPUTB_CE("CE0"), .REG_INPUTB_RST("RST0"),
        .REG_OUTPUT_CLK("CLK0"), .REG_OUTPUT_CE("CE0"), .REG_OUTPUT_RST("RST0"),
        .REG_PIPELINE_CLK("NONE"), .REG_INPUTC_CLK("NONE"),
        .CLK0_DIV("ENABLED"), .GSR("DISABLED"), .RESETMODE("SYNC"),
        .SOURCEB_MODE("B_SHIFT"), .MULT_BYPASS("DISABLED"), .CAS_MATCH_REG("FALSE")
    ) dsp (
        .A0(a[0]),
        .A1(a[1]),
        .A2(a[2]),
        .A3(a[3]),
        .A4(a[4]),
        .A5(a[5]),
        .A6(a[6]),
        .A7(a[7]),
        .A8(a[8]),
        .A9(a[9]),
        .A10(a[10]),
        .A11(a[11]),
        .A12(a[12]),
        .A13(a[13]),
        .A14(a[14]),
        .A15(a[15]),
        .A16(a[16]),
        .A17(a[17]),
        .B0(b[0]),
        .B1(b[1]),
        .B2(b[2]),
        .B3(b[3]),
        .B4(b[4]),
        .B5(b[5]),
        .B6(b[6]),
        .B7(b[7]),
        .B8(b[8]),
        .B9(b[9]),
        .B10(b[10]),
        .B11(b[11]),
        .B12(b[12]),
        .B13(b[13]),
        .B14(b[14]),
        .B15(b[15]),
        .B16(b[16]),
        .B17(b[17]),
        .C0(1'b0),
        .C1(1'b0),
        .C2(1'b0),
        .C3(1'b0),
        .C4(1'b0),
        .C5(1'b0),
        .C6(1'b0),
        .C7(1'b0),
        .C8(1'b0),
        .C9(1'b0),
        .C10(1'b0),
        .C11(1'b0),
        .C12(1'b0),
        .C13(1'b0),
        .C14(1'b0),
        .C15(1'b0),
        .C16(1'b0),
        .C17(1'b0),
        .P0(p_w[0]),
        .P1(p_w[1]),
        .P2(p_w[2]),
        .P3(p_w[3]),
        .P4(p_w[4]),
        .P5(p_w[5]),
        .P6(p_w[6]),
        .P7(p_w[7]),
        .P8(p_w[8]),
        .P9(p_w[9]),
        .P10(p_w[10]),
        .P11(p_w[11]),
        .P12(p_w[12]),
        .P13(p_w[13]),
        .P14(p_w[14]),
        .P15(p_w[15]),
        .P16(p_w[16]),
        .P17(p_w[17]),
        .P18(p_w[18]),
        .P19(p_w[19]),
        .P20(p_w[20]),
        .P21(p_w[21]),
        .P22(p_w[22]),
        .P23(p_w[23]),
        .P24(p_w[24]),
        .P25(p_w[25]),
        .P26(p_w[26]),
        .P27(p_w[27]),
        .P28(p_w[28]),
        .P29(p_w[29]),
        .P30(p_w[30]),
        .P31(p_w[31]),
        .P32(p_w[32]),
        .P33(p_w[33]),
        .P34(p_w[34]),
        .P35(p_w[35]),
        .SIGNEDA(SIGNED ? 1'b1 : 1'b0),
        .SIGNEDB(SIGNED ? 1'b1 : 1'b0),
        .SOURCEA(1'b0),
        .SOURCEB(1'b0),
        .CLK0(clk),
        .CLK1(1'b0),
        .CLK2(1'b0),
        .CLK3(1'b0),
        .CE0(ce),
        .CE1(1'b1),
        .CE2(1'b1),
        .CE3(1'b1),
        .RST0(rst),
        .RST1(1'b0),
        .RST2(1'b0),
        .RST3(1'b0)
    );
    assign p = p_w;
`else
    reg [17:0] a_q, b_q;
    reg [35:0] p_q;
    always @(posedge clk) begin
        if (rst) begin
            a_q <= 0; b_q <= 0; p_q <= 0;
        end else if (ce) begin
            a_q <= a;
            b_q <= b;
            if (SIGNED) p_q <= $signed(a_q) * $signed(b_q);  // separate branches: a ?: with one unsigned arm
            else        p_q <= a_q * b_q;                    // would make the signed multiply unsigned
        end
    end
    assign p = p_q;
`endif
endmodule
