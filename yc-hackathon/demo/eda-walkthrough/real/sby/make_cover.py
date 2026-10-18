# Copies the frozen RTL and splices the cover include in before `endmodule` -> pwm_led_cover_fv.v
import os
h = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(h, '..', 'rtl', 'pwm_led.v')).read()
i = src.rindex('endmodule')
open(os.path.join(h, 'pwm_led_cover_fv.v'), 'w').write(src[:i] + '`include "pwm_led_cover.vh"\n' + src[i:])
