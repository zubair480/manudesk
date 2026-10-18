"""Add the real SymbiYosys COVER run (real/sby/pwm_led_cover.sby, cover.log, pwm_led_cover/engine_0/trace*.vcd)
to data/08-symbiyosys.json as `cover`. Each solver witness VCD becomes a hwsim-compatible columnar trace
(cols.{t_ns,rst,pre,pwm_cnt,duty,dir,led,on0}; one row per solver step; registers = state at that step,
rst = the input the DUT saw at the edge that produced it). Run after extract.py."""
import json, re, os
H = os.path.dirname(os.path.abspath(__file__)); R = os.path.join(H, '..')
OUT = os.path.join(R, '..', '..', 'data', '08-symbiyosys.json')
log = open(os.path.join(R, 'cover.log'), encoding='utf-8', errors='replace').read()

def parse_vcd(path):
    ids, steps, cur = {}, [], None
    for line in open(path):
        line = line.strip()
        m = re.match(r'\$var \w+ (\d+) (\S+) (\S+) \$end', line)
        if m: ids[m[2]] = m[3]; continue
        if line.startswith('#'):
            continue
        m = re.match(r'b([01xz]+) (\S+)$', line)
        if not m: continue
        name = ids.get(m[2]); val = int(m[1].replace('x', '0').replace('z', '0'), 2)
        if name == 'smt_step':
            cur = dict(steps[-1]) if steps else {}
            steps.append(cur)
        if cur is not None and name: cur[name] = val
    return steps

def to_trace(steps, div, label, markers):
    n = len(steps)
    cols = {k: [] for k in ('t_ns', 'rst', 'pre', 'pwm_cnt', 'duty', 'dir', 'led', 'on0')}
    for k, s in enumerate(steps):
        cols['t_ns'].append(20 + 40 * k)
        cols['rst'].append(steps[k - 1]['rst'] if k else s['rst'])
        for r in ('pre', 'pwm_cnt', 'duty', 'dir', 'led'): cols[r].append(s[r])
        cols['on0'].append(None)
    return {'source': label, 'simulator': 'yosys-smtbmc + yices (cover witness)', 'params': {'DIV': div},
            'clk_period_ns': 40, 'simulated': False, 'n': n, 'cols': cols, 'markers': markers, 'windows': {'all': [0, n - 1]}}

sby = open(os.path.join(R, 'pwm_led_cover.sby')).read()
div = int(re.search(r'chparam -set DIV (\d+)', sby)[1])
reached = re.findall(r'cover trace: \S*?(trace\d+)\.vcd\s*\n.*?reached cover statement pwm_led\.(\w+) at \S+ step (\d+)', log)
covers, traces = [], {}
for tr, name, step in reached:
    step = int(step)
    # the VCD ends with one extra timestamp (a copy of the last state); keep solver steps 0..step
    steps = parse_vcd(os.path.join(R, 'pwm_led_cover', 'engine_0', tr + '.vcd'))[:step + 1]
    marks = [{'cycle': 0, 'kind': 'reset', 'label': 'step 0: solver assumes rst=1'}]
    for k in range(1, len(steps)):
        if steps[k - 1]['rst'] and k > 1: marks.append({'cycle': k, 'kind': 'event', 'label': f'cycle {k}: solver asserts rst (a free input)'})
    # a cover inside always @(posedge clk) samples the state one step before the step smtbmc reports
    marks.append({'cycle': step - 1, 'kind': 'pass', 'label': f'cover reached: {name} (solver step {step})'})
    covers.append({'name': name, 'step': step, 'trace': tr, 'steps': len(steps)})
    traces[tr] = to_trace(steps, div, f'real/sby/pwm_led_cover/engine_0/{tr}.vcd', marks)
out = json.load(open(OUT))
out['cover'] = {
    'simulated': False,
    'command': open(os.path.join(R, 'cover_command.txt')).read().strip().split('\n'),
    'sby': sby, 'props_file': open(os.path.join(R, 'pwm_led_cover.vh')).read(),
    'div': div, 'depth': int(re.search(r'depth (\d+)', sby)[1]),
    'status': re.search(r'DONE \((\w+)', log)[1],
    'steps_checked': max(int(s) for s in re.findall(r'Checking cover reachability in step (\d+)', log)) + 1,
    'elapsed': (re.search(r'real\s+(\S+)', log) or [None, None])[1],
    'covers': sorted(covers, key=lambda c: c['step']), 'traces': traces,
}
json.dump(out, open(OUT, 'w'), indent=1)
print(out['cover']['covers'], out['cover']['status'], out['cover']['steps_checked'])
