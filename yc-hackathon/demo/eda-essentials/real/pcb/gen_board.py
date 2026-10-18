"""Generate the pwm_led carrier board (ECP5 + 8 LEDs) as a Specctra DSN for Freerouting,
plus board_geometry.json (the geometry the 09-kicad / 10-freerouting scenes render).

Coordinates: mm, origin top-left, y down. DSN uses um with y up (y_dsn = -y).
Usage:  python gen_board.py   (writes board_geometry.json and board.dsn next to this file)
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 56.0, 38.0

# ---------- padstacks ----------
# name -> dict(shape, w, h, layers)
PADSTACKS = {
    'BGA_450':  dict(shape='circle', d=0.45, layers=['F.Cu']),
    'R0402':    dict(shape='rect', w=0.6, h=0.6, layers=['F.Cu']),
    'R0603':    dict(shape='rect', w=0.9, h=0.95, layers=['F.Cu']),
    'OSC':      dict(shape='rect', w=1.1, h=0.9, layers=['F.Cu']),
    'USB':      dict(shape='rect', w=1.35, h=0.4, layers=['F.Cu']),
    'SOT_PIN':  dict(shape='rect', w=1.0, h=1.6, layers=['F.Cu']),
    'SOT_TAB':  dict(shape='rect', w=3.3, h=1.6, layers=['F.Cu']),
    'TH_1700':  dict(shape='circle', d=1.7, layers=['F.Cu', 'B.Cu'], drill=1.0),
    'TH_SQ':    dict(shape='rect', w=1.7, h=1.7, layers=['F.Cu', 'B.Cu'], drill=1.0),
    'MH_3200':  dict(shape='circle', d=5.6, layers=['F.Cu', 'B.Cu'], drill=3.2),
}

parts = []   # dict(ref, value, fp, x, y, w, h, pins=[dict(name,x,y,ps)])

def part(ref, value, fp, x, y, w, h, pins, kind):
    parts.append(dict(ref=ref, value=value, fp=fp, kind=kind, x=x, y=y, w=w, h=h,
                      pins=[dict(name=str(n), x=round(px, 3), y=round(py, 3), ps=ps) for n, px, py, ps in pins]))

# U1: ECP5 (BGA, 8x8 used-ball field at 1.0 mm pitch, rows A..H)
ROWS = 'ABCDEFGH'
u1_pins = []
for r in range(8):
    for c in range(8):
        u1_pins.append((f'{ROWS[r]}{c+1}', -3.5 + c, -3.5 + r, 'BGA_450'))
part('U1', 'LFE5U-25F-6BG256C', 'Package_BGA:ECP5_CABGA256', 28.0, 15.0, 10.0, 10.0, u1_pins, 'bga')

# Y1: 25 MHz oscillator 3.2x2.5
part('Y1', '25MHz', 'Oscillator:Oscillator_SMD_3225-4Pin', 15.0, 10.0, 3.2, 2.5,
     [(1, -1.1, 0.85, 'OSC'), (2, 1.1, 0.85, 'OSC'), (3, 1.1, -0.85, 'OSC'), (4, -1.1, -0.85, 'OSC')], 'osc')

# Decoupling caps C1..C4 (0402)
for i, (cx, cy) in enumerate([(20.5, 9.5), (35.5, 9.5), (20.5, 21.0), (35.5, 21.0)]):
    part(f'C{i+1}', '100nF', 'Capacitor_SMD:C_0402', cx, cy, 1.0, 0.5,
         [(1, -0.5, 0, 'R0402'), (2, 0.5, 0, 'R0402')], 'cap')

# R1..R8 (0402, vertical) and D1..D8 (0603 LED, vertical)
for i in range(8):
    x = 14.0 + i * 4.0
    part(f'R{i+1}', '330R', 'Resistor_SMD:R_0402', x, 25.5, 0.5, 1.0,
         [(1, 0, -0.5, 'R0402'), (2, 0, 0.5, 'R0402')], 'res')
    part(f'D{i+1}', 'LED_Green', 'LED_SMD:LED_0603', x, 30.5, 0.8, 1.6,
         [(1, 0, 0.8, 'R0603'), (2, 0, -0.8, 'R0603')], 'led')   # 1 = K (bottom), 2 = A (top)

# J1: 2x5 JTAG header 2.54 mm
j1 = []
for n in range(10):
    col, row = n % 2, n // 2
    j1.append((n + 1, -1.27 + col * 2.54, -5.08 + row * 2.54, 'TH_SQ' if n == 0 else 'TH_1700'))
part('J1', 'JTAG', 'Connector_PinHeader_2.54mm:PinHeader_2x05', 48.77, 15.08, 5.08, 12.7, j1, 'header')

# J2: micro-USB (left edge)
part('J2', 'USB_Micro-B', 'Connector_USB:USB_Micro-B', 3.4, 19.0, 5.0, 7.5,
     [(i + 1, 0.0, -1.3 + i * 0.65, 'USB') for i in range(5)], 'usb')

# U2: 3.3 V LDO SOT-223
part('U2', 'AMS1117-3.3', 'Package_TO_SOT_SMD:SOT-223', 9.0, 28.0, 6.5, 3.5,
     [(1, -2.3, 3.1, 'SOT_PIN'), (2, 0.0, 3.1, 'SOT_PIN'), (3, 2.3, 3.1, 'SOT_PIN'), (4, 0.0, -3.1, 'SOT_TAB')], 'ldo')

# Mounting holes
for i, (hx, hy) in enumerate([(3.5, 3.5), (52.5, 3.5), (3.5, 34.5), (52.5, 34.5)]):
    part(f'H{i+1}', 'MountingHole_3.2mm', 'MountingHole:MountingHole_3.2mm_M3_Pad', hx, hy, 5.6, 5.6,
         [(1, 0, 0, 'MH_3200')], 'hole')

# ---------- nets ----------
nets = {}
def net(name, *pins):
    nets.setdefault(name, []).extend(pins)

for i in range(8):
    net(f'LED{i}', f'U1-H{i+1}', f'R{i+1}-1')        # FPGA ball -> resistor
    net(f'/led_a{i}', f'R{i+1}-2', f'D{i+1}-2')      # resistor -> LED anode
net('CLK25', 'U1-B1', 'Y1-3')
net('TCK', 'U1-B8', 'J1-3'); net('TDI', 'U1-C8', 'J1-4'); net('TMS', 'U1-D8', 'J1-5'); net('TDO', 'U1-E8', 'J1-6')
net('RST', 'U1-F8', 'J1-7')
net('USB_DN', 'U1-E1', 'J2-2'); net('USB_DP', 'U1-F1', 'J2-3')
net('VBUS', 'J2-1', 'U2-3')
net('+3V3', 'U1-C3', 'U1-C6', 'U1-F3', 'U1-F6', 'Y1-4', 'Y1-1', 'U2-2', 'U2-4', 'J1-1',
    *[f'C{i+1}-1' for i in range(4)])
net('GND', 'U1-D4', 'U1-D5', 'U1-E4', 'U1-E5', 'Y1-2', 'J2-5', 'U2-1', 'J1-2', 'J1-8', 'J1-10',
    *[f'C{i+1}-2' for i in range(4)], *[f'D{i+1}-1' for i in range(8)])

# ---------- write board.json ----------
board = dict(name='pwm_led_carrier', width=W, height=H, units='mm', layers=['F.Cu', 'B.Cu'],
             rules=dict(track=0.2, clearance=0.15, via_d=0.6, via_drill=0.3),
             padstacks=PADSTACKS, parts=parts,
             nets=[dict(name=k, pins=v) for k, v in nets.items()])
with open(os.path.join(HERE, 'board_geometry.json'), 'w') as f:
    json.dump(board, f, indent=1)

# ---------- write board.dsn ----------
um = lambda v: int(round(v * 1000))
def ps_shape(name, p):
    out = []
    for L in p['layers']:
        if p['shape'] == 'circle':
            out.append(f'      (shape (circle {L} {um(p["d"])}))')
        else:
            out.append(f'      (shape (rect {L} {um(-p["w"]/2)} {um(-p["h"]/2)} {um(p["w"]/2)} {um(p["h"]/2)}))')
    return f'    (padstack {name}\n' + '\n'.join(out) + '\n      (attach off)\n    )'

L = []
L.append('(pcb "board.dsn"')
L.append('  (parser\n    (string_quote ")\n    (space_in_quoted_tokens on)\n    (host_cad "KiCad\'s Pcbnew")\n    (host_version "9.0")\n  )')
L.append('  (resolution um 10)\n  (unit um)')
L.append('  (structure')
L.append('    (layer F.Cu (type signal) (property (index 0)))')
L.append('    (layer B.Cu (type signal) (property (index 1)))')
L.append(f'    (boundary (path pcb 0  0 0  {um(W)} 0  {um(W)} {-um(H)}  0 {-um(H)}  0 0))')
L.append('    (via "Via[0-1]_600:300_um")')
L.append('    (rule (width 200) (clearance 150) (clearance 150 (type default_smd)) (clearance 50 (type smd_smd)))')
L.append('  )')
L.append('  (placement')
for p in parts:
    L.append(f'    (component "{p["fp"]}::{p["ref"]}"\n      (place {p["ref"]} {um(p["x"])} {-um(p["y"])} front 0 (PN "{p["value"]}"))\n    )')
L.append('  )')
L.append('  (library')
for p in parts:
    L.append(f'    (image "{p["fp"]}::{p["ref"]}"')
    hw, hh = p['w'] / 2, p['h'] / 2
    L.append(f'      (outline (path signal 50  {um(-hw)} {um(hh)}  {um(hw)} {um(hh)}  {um(hw)} {um(-hh)}  {um(-hw)} {um(-hh)}  {um(-hw)} {um(hh)}))')
    for pin in p['pins']:
        L.append(f'      (pin {pin["ps"]} "{pin["name"]}" {um(pin["x"])} {-um(pin["y"])})')
    L.append('    )')
for name, p in PADSTACKS.items():
    L.append(ps_shape(name, p))
L.append('    (padstack "Via[0-1]_600:300_um"\n      (shape (circle F.Cu 600))\n      (shape (circle B.Cu 600))\n      (attach off)\n    )')
L.append('  )')
L.append('  (network')
for k, v in nets.items():
    L.append(f'    (net "{k}"\n      (pins {" ".join(v)})\n    )')
names = ' '.join(f'"{k}"' for k in nets)
L.append(f'    (class kicad_default "" {names}\n      (circuit (use_via "Via[0-1]_600:300_um"))\n      (rule (width 200) (clearance 150))\n    )')
L.append('  )')
L.append('  (wiring\n  )')
L.append(')')
with open(os.path.join(HERE, 'board.dsn'), 'w') as f:
    f.write('\n'.join(L) + '\n')
print(f'{len(parts)} parts, {len(nets)} nets, {sum(len(v) for v in nets.values())} net pins')
