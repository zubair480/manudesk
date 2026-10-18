"""Extract real placement + routing from nextpnr routed.json -> data/07-nextpnr.json."""
import json, re, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, '..')
OUT = os.path.join(R, '..', '..', 'data', '07-nextpnr.json')
d = json.load(open(os.path.join(R, 'routed.json')))
m = d['modules']['top']
rep = json.load(open(os.path.join(R, 'report.json')))
xy = re.compile(r'^X(\d+)/Y(\d+)/(.*)$')

cells = []
loc_of = {}
for name, c in m['cells'].items():
    bel = c['attributes'].get('NEXTPNR_BEL', '')
    mm = xy.match(bel)
    if not mm: continue
    x, y, site = int(mm[1]), int(mm[2]), mm[3]
    slot = 0
    s = re.match(r'SLICE([A-D])\.(K0|K1|FF0|FF1)', site)
    if s:
        slot = 'ABCD'.index(s[1]) * 4 + ['K0', 'K1', 'FF0', 'FF1'].index(s[2])
    elif site.startswith('PIO'):
        slot = 'ABCD'.index(site[3])
    t = c['type']
    # readable origin: which RTL signal this cell was derived from
    base = re.sub(r'^\$nextpnr_', '', name).split('_')[0].split('$')[0]
    cells.append({'n': name[:80], 't': t, 'x': x, 'y': y, 'k': slot, 'site': site, 'g': base})
    loc_of[name] = (x, y)

nets = []
for name, n in m['netnames'].items():
    r = n['attributes'].get('ROUTING')
    if not r: continue
    parts = r.split(';')
    pts = []
    for i in range(0, len(parts) - 2, 3):
        mm = xy.match(parts[i])
        if mm: pts.append((int(mm[1]), int(mm[2])))
    pts = list(dict.fromkeys(pts))
    if len(pts) < 2: continue
    glob = name.startswith('$glbnet')
    # Prim MST over the real routed tiles -> list of segments
    segs = []
    if not glob:
        inside = {pts[0]}; rest = set(pts[1:])
        while rest:
            best = None
            for a in inside:
                for b in rest:
                    dd = abs(a[0]-b[0]) + abs(a[1]-b[1])
                    if best is None or dd < best[0]: best = (dd, a, b)
            _, a, b = best
            segs.append([a[0], a[1], b[0], b[1]])
            inside.add(b); rest.discard(b)
    nets.append({'n': name[:60], 'glob': glob, 'tiles': len(pts), 'segs': segs,
                 'pts': [list(p) for p in pts] if glob else None, 'wires': len(parts)//3})
nets.sort(key=lambda n: -n['tiles'])

log = open(os.path.join(R, 'nextpnr.log'), encoding='utf-8', errors='replace').read()
heap = [list(map(int, g)) for g in re.findall(r'iteration #(\d+), type TRELLIS_COMB: wirelen solved = (\d+), spread = (\d+), legal = (\d+)', log)]
sa = [list(map(int, g)) for g in re.findall(r'at iteration #(\d+): temp = [\d.]+, timing cost = (\d+), wirelen = (\d+)', log)]
arcs = int(re.search(r'Routing (\d+) arcs', log)[1])
fmax = list(rep['fmax'].values())[0]
util = {k: v for k, v in rep['utilization'].items() if v['used'] > 0}
crit = rep['critical_paths'][0]
path = []
for p in crit['path']:
    path.append({'type': p['type'], 'delay': round(p['delay'], 3), 'cell': p['to']['cell'][:50], 'port': p['to']['port'], 'loc': p['to']['loc'], 'net': p.get('net')})
out = {
    'simulated': False,
    'device': 'LFE5U-85F', 'package': 'CABGA381', 'grid': {'w': 126, 'h': 96},
    'command': open(os.path.join(R, 'command.txt')).read().strip().split('\n'),
    'fmax': {'achieved': round(fmax['achieved'], 2), 'constraint': fmax['constraint']},
    'utilization': util, 'arcs': arcs, 'heap': heap, 'sa': sa,
    'critical_path': path, 'cells': cells, 'nets': nets,
    'bitstream': {'file': 'pwm_led.bit', 'bytes': os.path.getsize(os.path.join(R, 'pwm_led.bit'))},
}
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print('cells', len(cells), 'nets', len(nets), 'bytes', os.path.getsize(OUT), 'fmax', out['fmax'])
xs=[c['x'] for c in cells]; ys=[c['y'] for c in cells]; print('bbox', min(xs), max(xs), min(ys), max(ys))
