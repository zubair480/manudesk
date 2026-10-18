"""Build data/08-symbiyosys.json from the real SymbiYosys run in real/sby/."""
import json, re, os
H = os.path.dirname(os.path.abspath(__file__)); R = os.path.join(H, '..')
OUT = os.path.join(R, '..', '..', 'data', '08-symbiyosys.json')
log = open(os.path.join(R, 'sby.log'), encoding='utf-8', errors='replace').read()
props_src = open(os.path.join(R, 'pwm_led_props.vh')).read()
props = []
cur = ''
for line in props_src.splitlines():
    c = re.match(r'\s*//\s*(P\d+): (.*)', line)
    if c: cur = (c[1], c[2]); continue
    a = re.match(r'\s*(?:if .*\)\s*)?(\w+):\s*assert', line) or re.match(r'\s*(\w+): assert', line)
    if a: props.append({'name': a[1], 'group': cur[0], 'desc': cur[1]})
bmc_steps = sorted({int(s) for s in re.findall(r'\[pwm_led_bmc\] engine_0: ##.*Checking assertions in step (\d+)', log)})
base_steps = sorted({int(s) for s in re.findall(r'\[pwm_led_prove\] engine_0\.basecase: ##.*Checking assertions in step (\d+)', log)})
ind_steps = [int(s) for s in re.findall(r'Trying induction in step (\d+)', log)]
out = {
    'simulated': False,
    'command': open(os.path.join(R, 'command.txt')).read().strip().split('\n'),
    'sby': open(os.path.join(R, 'pwm_led.sby')).read(),
    'props_file': props_src,
    'properties': props,
    'bmc': {'depth': max(bmc_steps) + 1 if bmc_steps else 0, 'steps': len(bmc_steps), 'status': re.search(r'\[pwm_led_bmc\] DONE \((\w+)', log)[1]},
    'prove': {'basecase_steps': len(base_steps), 'induction_steps': ind_steps,
              'status': re.search(r'\[pwm_led_prove\] DONE \((\w+)', log)[1],
              'kind': 'k-induction' if 'successful proof by k-induction' in log else None},
    'elapsed': re.search(r'real\s+(\S+)', log)[1] if re.search(r'real\s+(\S+)', log) else None,
    'mutant_check': 'duty+2 mutant fails duty_step under induction (checked by hand, scratch run)',
}
json.dump(out, open(OUT, 'w'), indent=1)
print(props, out['bmc'], out['prove'])
