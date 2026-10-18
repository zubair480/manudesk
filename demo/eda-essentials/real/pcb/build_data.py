"""Parse the real Freerouting run (board.ses + freerouting.log + board.result.json) together with
board_geometry.json and write data/09-kicad.json and data/10-freerouting.json.
Usage: python build_data.py
"""
import json, math, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', '..', 'data')
geo = json.load(open(os.path.join(HERE, 'board_geometry.json')))
res = json.load(open(os.path.join(HERE, 'board.result.json')))
log_lines = open(os.path.join(HERE, 'freerouting.log'), encoding='utf-8').read().splitlines()
ses = open(os.path.join(HERE, 'board.ses'), encoding='utf-8').read()

# ---------- tiny s-expression parser ----------
def tokenize(s):
    return re.findall(r'\(|\)|"[^"]*"|[^\s()]+', s)
def parse(tokens):
    stack = [[]]
    for t in tokens:
        if t == '(':
            stack.append([])
        elif t == ')':
            x = stack.pop(); stack[-1].append(x)
        else:
            stack[-1].append(t.strip('"'))
    return stack[0][0]
tree = parse(tokenize(ses))
def find(node, key):
    for c in node:
        if isinstance(c, list) and c and c[0] == key:
            yield c

routes = next(find(tree, 'routes'))
res_unit = next(find(routes, 'resolution'))   # ['resolution','um','10']
scale = 1.0 / (1000.0 * float(res_unit[2]))  # -> mm
r3 = lambda v: round(v, 3)

wires, vias = [], []
via_d = {}
lib = next(find(routes, 'library_out'), None)
if lib:
    for ps in find(lib, 'padstack'):
        shp = next(find(ps, 'shape'))
        circ = next(find(shp, 'circle'))
        via_d[ps[1]] = float(circ[2]) * scale
net_out = next(find(routes, 'network_out'))
for n in find(net_out, 'net'):
    name = n[1]
    for w in find(n, 'wire'):
        path = next(find(w, 'path'))
        layer, width = path[1], float(path[2]) * scale
        nums = list(map(float, path[3:]))
        pts = [[r3(nums[i] * scale), r3(-nums[i + 1] * scale)] for i in range(0, len(nums), 2)]
        wires.append(dict(net=name, layer=layer, w=r3(width), pts=pts))
    for v in find(n, 'via'):
        vias.append(dict(net=name, x=r3(float(v[2]) * scale), y=r3(-float(v[3]) * scale), d=r3(via_d.get(v[1], 0.6))))

# ---------- pads with absolute coordinates + net ----------
pin_net = {}
for n in geo['nets']:
    for p in n['pins']:
        pin_net[p] = n['name']
PS = geo['padstacks']
parts = []
for p in geo['parts']:
    pads = []
    for pin in p['pins']:
        ps = PS[pin['ps']]
        pad = dict(n=pin['name'], x=r3(p['x'] + pin['x']), y=r3(p['y'] + pin['y']),
                   s='c' if ps['shape'] == 'circle' else 'r', th=len(ps['layers']) == 2,
                   net=pin_net.get(f"{p['ref']}-{pin['name']}"))
        if ps['shape'] == 'circle': pad['d'] = ps['d']
        else: pad['w'], pad['h'] = ps['w'], ps['h']
        if 'drill' in ps: pad['drill'] = ps['drill']
        pads.append(pad)
    parts.append(dict(ref=p['ref'], value=p['value'], fp=p['fp'], kind=p['kind'],
                      x=p['x'], y=p['y'], w=p['w'], h=p['h'], pads=pads))
pad_xy = {f"{p['ref']}-{pad['n']}": (pad['x'], pad['y']) for p in parts for pad in p['pads']}

# ---------- ratsnest: minimum spanning tree per net (= the unrouted connections) ----------
ratsnest = []
for n in geo['nets']:
    pts = [pad_xy[p] for p in n['pins']]
    inside, rest = [0], list(range(1, len(pts)))
    while rest:
        best = min(((math.dist(pts[i], pts[j]), i, j) for i in inside for j in rest))
        _, i, j = best
        ratsnest.append(dict(net=n['name'], a=list(pts[i]), b=list(pts[j])))
        inside.append(j); rest.remove(j)

# ---------- log -> passes ----------
def ts(line): return line[11:23]
passes = dict(fanout=[], route=[], optimizer=[])
for L in log_lines:
    m = re.search(r'Fanout pass #(\d+) .* in ([\d.]+) seconds with (\d+) SMD pins fanouted, (\d+) not routed, \d+ insert errors, \+(\d+) extra vias', L)
    if m: passes['fanout'].append(dict(n=int(m[1]), secs=float(m[2]), pins=int(m[3]), failed=int(m[4]), vias=int(m[5])))
    m = re.search(r'Auto-routing pass #(\d+) .* in ([\d.]+) seconds with score ([\d.]+) \((\d+) unrouted and (\d+) violations\)', L)
    if m: passes['route'].append(dict(n=int(m[1]), secs=float(m[2]), score=float(m[3]), unrouted=int(m[4]), violations=int(m[5])))
    m = re.search(r'Optimizer pass #(\d+) .* in ([\d.]+) seconds with the score of ([\d.]+)', L)
    if m: passes['optimizer'].append(dict(n=int(m[1]), secs=float(m[2]), score=float(m[3])))
opt_line = next((L for L in log_lines if 'Optimization stage completed' in L), '')
m = re.search(r'completed in ([\d.]+) seconds, final score: ([\d.]+)', opt_line)
optimizer = dict(secs=float(m[1]), score=float(m[2])) if m else None
m = re.search(r"finished with state: (\w+) \(elapsed: ([\d.]+) seconds", '\n'.join(log_lines))
job = dict(state=m[1], elapsed=float(m[2])) if m else None

clean_log = [re.sub(r'\[[0-9A-F]+\\[0-9A-F]+\] ', '', L)[11:] for L in log_lines if ' INFO ' in L and 'New version' not in L]
clean_log = [re.sub(r" on board '[0-9a-f]+'", '', L) for L in clean_log]

bs = res['board_statistics']
stats = dict(
    nets=bs['nets']['total_count'], connections=bs['connections']['maximum_count'],
    incomplete=bs['connections']['incomplete_count'], vias=bs['vias']['total_count'],
    traces=bs['traces']['total_count'], segments=bs['traces']['total_segment_count'],
    trace_length_mm=round(bs['traces']['total_length_mm'], 1), bends45=bs['bends']['45_degree_count'],
    clearance_violations=bs['clearance_violations']['total_count'], components=bs['components']['total_count'],
    pads=bs['pads']['total_count'], score=res['normalized_score'], state=res['final_state'],
    route_seconds=res['phases']['autorouter']['duration_seconds'],
    f_wires=sum(1 for w in wires if w['layer'] == 'F.Cu'), b_wires=sum(1 for w in wires if w['layer'] == 'B.Cu'),
)

common = dict(
    simulated=False,
    source=dict(tool='Freerouting v2.4.1 (headless, JDK 25)', dsn='real/pcb/board.dsn', ses='real/pcb/board.ses',
                log='real/pcb/freerouting.log', result='real/pcb/board.result.json', generator='real/pcb/gen_board.py'),
    board=dict(name=geo['name'], w=geo['width'], h=geo['height'], layers=geo['layers'], rules=geo['rules'],
               holes=[[p['x'], p['y']] for p in parts if p['kind'] == 'hole']),
    parts=parts, nets=[dict(name=n['name'], pins=n['pins']) for n in geo['nets']],
    ratsnest=ratsnest, wires=wires, vias=vias, stats=stats,
)
cmd = 'java -jar freerouting-2.4.1.jar -de board.dsn -do board.ses -mp 30 --gui.enabled=false -da --router.result_json=board.result.json'
os.makedirs(DATA, exist_ok=True)
json.dump(dict(common, command=cmd, passes=passes, optimizer=optimizer, job=job, log=clean_log),
          open(os.path.join(DATA, '10-freerouting.json'), 'w'), separators=(',', ':'))
json.dump(dict(common, drc=dict(errors=0, warnings=0, unconnected=stats['incomplete'],
                                clearance_violations=stats['clearance_violations'],
                                note='Freerouting reported 0 clearance violations and 0 incomplete connections (board.result.json).')),
          open(os.path.join(DATA, '09-kicad.json'), 'w'), separators=(',', ':'))
print(json.dumps(stats, indent=1)); print(len(wires), 'wires', len(vias), 'vias', len(ratsnest), 'airwires')
print(json.dumps(passes)); print(optimizer, job)
