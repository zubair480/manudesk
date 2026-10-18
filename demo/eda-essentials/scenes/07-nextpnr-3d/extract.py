# Builds data/07-nextpnr-3d.json from the real nextpnr-ecp5 run in real/nextpnr/.
# Run from demo/eda-walkthrough:  python scenes/07-nextpnr-3d/extract.py
import json, os, re

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
P = lambda *a: os.path.join(ROOT, *a)

routed = json.load(open(P('real/nextpnr/routed.json')))
mod = next(iter(routed['modules'].values()))
log = open(P('real/nextpnr/nextpnr.log')).read()

BEL = re.compile(r'X(\d+)/Y(\d+)/(\w+?)(?:\.(\w+))?$')
cells = []
for name, c in mod['cells'].items():
    bel = c['attributes'].get('NEXTPNR_BEL', '')
    m = BEL.match(bel)
    if not m:
        continue
    x, y, site, sub = int(m[1]), int(m[2]), m[3], m[4] or ''
    t = c['type']
    if t == 'TRELLIS_COMB':
        kind = 'carry' if 'CCU2' in name else 'lut'
    elif t == 'TRELLIS_FF':
        kind = 'ff'
    elif t == 'TRELLIS_IO':
        kind = 'io'
    else:
        kind = 'gb'
    s = 'ABCD'.index(site[-1]) if site[-1] in 'ABCD' else 0
    k = int(sub[-1]) if sub[-1:].isdigit() else 0
    label = name.replace('$tr_io', '') if kind == 'io' else ''
    cells.append({'t': kind, 'x': x, 'y': y, 's': s, 'k': k, **({'n': label} if label else {})})

# Real routing: each ROUTING entry is wire;pip;strength. A pip "X6/Y38/0_-1_SRC->-1_0_DST"
# connects the source wire's tile (x+dx, y+dy) to the destination wire's tile.
PIP = re.compile(r'X(\d+)/Y(\d+)/(-?\d+)_(-?\d+)_\w+->(-?\d+)_(-?\d+)_\w+')
nets = []
for name, n in mod['netnames'].items():
    r = n['attributes'].get('ROUTING')
    if not r:
        continue
    parts = r.split(';')
    segs = set()
    for i in range(1, len(parts), 3):
        m = PIP.match(parts[i])
        if not m:
            continue
        x, y, sx, sy, dx, dy = map(int, m.groups())
        a, b = (x + sx, y + sy), (x + dx, y + dy)
        if a != b:
            segs.add(tuple(sorted((a, b))))
    if segs:
        nets.append({'n': name, 'g': 1 if n['attributes'].get('ECP5_IS_GLOBAL') else 0,
                     'segs': [list(a) + list(b) for a, b in sorted(segs)]})
nets.sort(key=lambda n: (n['g'], -len(n['segs'])))

def grab(rx, cast=float):
    m = re.findall(rx, log)
    return cast(m[-1]) if m else None

report = json.load(open(P('real/nextpnr/report.json')))
crit = report['critical_paths'][0]['path']
crit_locs = []
for step in crit:
    for end in ('from', 'to'):
        loc = step[end]['loc']
        if not crit_locs or crit_locs[-1] != loc:
            crit_locs.append(loc)

out = {
    'simulated': False,
    'source': 'real/nextpnr/routed.json (nextpnr-ecp5 --write), report.json, nextpnr.log',
    'device': 'LFE5U-85F', 'package': 'CABGA381', 'grid': {'w': 126, 'h': 96},
    'command': open(P('real/nextpnr/command.txt')).read().strip().splitlines(),
    'fmax': grab(r"Max frequency for clock '[^']+': ([\d.]+) MHz"),
    'fmaxTarget': 25.0,
    'lut4': {'total': grab(r'Total LUT4s:\s+(\d+)', int), 'logic': grab(r'logic LUTs:\s+(\d+)', int),
             'carry': grab(r'carry LUTs:\s+(\d+)', int), 'available': 83640},
    'util': {k: {'used': int(u), 'available': int(a)} for k, u, a in
             re.findall(r'^Info: \t\s*(TRELLIS_COMB|TRELLIS_FF|TRELLIS_IO|DCCA):\s+(\d+)/\s*(\d+)', log, re.M)},
    'arcs': grab(r'Routing (\d+) arcs', int),
    'bitBytes': os.path.getsize(P('real/nextpnr/pwm_led.bit')),
    'critical': {'ns': round(sum(s['delay'] for s in crit), 2), 'locs': crit_locs},
    'criticalNets': sorted({s['net'] for s in crit if s.get('net')}),
    'cells': cells,
    'nets': nets,
}
json.dump(out, open(P('data/07-nextpnr-3d.json'), 'w'), separators=(',', ':'))
print(len(cells), 'cells', len(nets), 'nets', sum(len(n['segs']) for n in nets), 'segs', out['fmax'], out['lut4'], out['util'])
