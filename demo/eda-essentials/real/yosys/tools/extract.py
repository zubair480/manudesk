"""Build data/06-yosys.json from the real Yosys run in real/yosys/."""
import json, re, os, collections
H = os.path.dirname(os.path.abspath(__file__)); R = os.path.join(H, '..')
OUT = os.path.join(R, '..', '..', 'data', '06-yosys.json')
log = open(os.path.join(R, 'yosys.log'), encoding='utf-8', errors='replace').read().splitlines()

# --- passes (headers like "2.19. Executing TECHMAP pass (map to technology primitives).")
hdr = re.compile(r'^(\d+(?:\.\d+)*)\. Executing (\S+)(?: pass)?(?: \((.*)\))?\.?$')
passes = []
for i, l in enumerate(log):
    m = hdr.match(l)
    if not m: continue
    num, name, desc = m[1], m[2], (m[3] or '')
    if num.count('.') > 1: continue          # only top-level synth_ecp5 steps
    body = []
    for l2 in log[i+1:i+60]:
        if hdr.match(l2) or re.match(r'^\d+(\.\d+)+\. ', l2): break
        s = l2.strip()
        if s and not s.startswith('Parameter') and len(body) < 4: body.append(s[:110])
    passes.append({'num': num, 'name': name, 'desc': desc.rstrip(')'), 'line': i, 'sample': body})

def stat(path):
    t = open(os.path.join(R, path)).read()
    cells = {}
    total = None
    for m in re.finditer(r'^\s+(\d+)\s+(\S+)\s*$', t, re.M):
        n, k = int(m[1]), m[2]
        if k == 'cells': total = n
        elif k.startswith('$') or k.isupper() or k[0].isupper(): cells[k] = n
    wires = int(re.search(r'(\d+) wires', t)[1]); bits = int(re.search(r'(\d+) wire bits', t)[1])
    return {'cells': total, 'types': cells, 'wires': wires, 'wire_bits': bits, 'raw': t.strip()}

rtl_stat, ecp5_stat = stat('rtl-stat.txt'), stat('stat.txt')

# --- functional blocks: RTL cells by source line, ECP5 cells by Yosys autoname prefix
BLOCKS = [
    {'id': 'pwm',  'label': 'PWM carrier',    'rtl': 'pwm_cnt <= pwm_cnt + 1',       'lines': [22]},
    {'id': 'pre',  'label': 'Prescaler',      'rtl': 'pre <= pre + 1',               'lines': [23]},
    {'id': 'fsm',  'label': 'Breath control', 'rtl': 'duty ± 1, dir flips at 0/255', 'lines': [25, 26, 27]},
    {'id': 'led',  'label': '8× phase compare','rtl': 'led[i] <= (pwm_cnt + 32·i) < duty', 'lines': list(range(30, 38))},
]
line2blk = {ln: b['id'] for b in BLOCKS for ln in b['lines']}
def src_line(c):
    m = re.findall(r'pwm_led\.v:(\d+)', c['attributes'].get('src', '') or '')
    return int(m[0]) if m else None

rj = json.load(open(os.path.join(R, 'rtl.json')))['modules']['pwm_led']
bitname = {}
for n, v in rj['netnames'].items():
    if n.startswith('$'): continue
    for b in v['bits']: bitname.setdefault(b, n)
rtl_cells = collections.defaultdict(list)
for n, c in rj['cells'].items():
    t = c['type']; ln = src_line(c); blk = line2blk.get(ln)
    width = max(len(x) for x in c['connections'].values())
    if t in ('$sdff', '$sdffe'):
        q = c['connections']['Q'][0]; sig = bitname.get(q, '')
        blk = {'pwm_cnt': 'pwm', 'pre': 'pre', 'duty': 'fsm', 'dir': 'fsm', 'led': 'led'}.get(sig, 'fsm')
    if blk is None: blk = 'fsm'               # unsourced control logic (&pre tick, muxes)
    rtl_cells[blk].append({'t': t, 'w': width, 'line': ln})

ej = json.load(open(os.path.join(R, 'ecp5-top.json')))['modules']['pwm_led']
pref = {'pwm': 'pwm', 'pre': 'pre', 'duty': 'fsm', 'dir': 'fsm', 'led': 'led'}
ecp5_cells = collections.defaultdict(collections.Counter)
cellblk = {}
for n, c in ej['cells'].items():
    p = re.split(r'[_$\[]', n.lstrip('$'))[0]; blk = pref.get(p, 'fsm')
    ecp5_cells[blk][c['type']] += 1; cellblk[n] = blk

# real block-to-block data flow from the mapped netlist
drv = {}; sinks = collections.defaultdict(set)
for n, c in ej['cells'].items():
    for port, bits in c['connections'].items():
        out = c['port_directions'][port] == 'output'
        for b in bits:
            if isinstance(b, str): continue
            if out: drv[b] = cellblk[n]
            else: sinks[b].add(cellblk[n])
for pn, p in ej['ports'].items():
    for b in p['bits']:
        if p['direction'] == 'input': drv[b] = 'in:' + pn
        else: sinks[b].add('out:' + pn)
edges = collections.Counter()
for b, ss in sinks.items():
    d = drv.get(b)
    if d is None: continue
    for s in ss:
        if s != d: edges[(d, s)] += 1
for b in BLOCKS:
    b['rtl_cells'] = rtl_cells[b['id']]
    b['ecp5'] = dict(ecp5_cells[b['id']])
out = {
    'simulated': False,
    'command': open(os.path.join(R, 'command.txt')).read().strip(),
    'log_lines': len(log),
    'passes': passes,
    'rtl_stat': rtl_stat, 'ecp5_stat': ecp5_stat,
    'blocks': BLOCKS,
    'edges': [{'from': a, 'to': b, 'bits': n} for (a, b), n in edges.most_common()],
}
json.dump(out, open(OUT, 'w'), indent=1)
print(len(passes), 'passes;', {b['id']: (len(b['rtl_cells']), b['ecp5']) for b in BLOCKS})
print(out['edges'])
