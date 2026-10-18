// One-off: parse real/pwm_led.vcd (Icarus output) into data/04-gtkwave.json.
// Usage (from demo/eda-walkthrough): node real/gtkwave/vcd2json.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('real/pwm_led.vcd', 'utf8');
const lines = src.split(/\r?\n/);

const vars = {};           // id -> {name, width, scope, kind}
const scope = [];
let timescalePs = 1, i = 0, hdrDate = '', hdrVersion = '';
for (; i < lines.length; i++) {
  const l = lines[i].trim();
  if (l.startsWith('$date')) hdrDate = lines[i + 1].trim();
  if (l.startsWith('$version')) hdrVersion = lines[i + 1].trim();
  if (l.startsWith('$timescale')) {
    const m = (lines[i + 1] + l).match(/(\d+)\s*(fs|ps|ns|us)/);
    if (m) timescalePs = +m[1] * { fs: 1e-3, ps: 1, ns: 1e3, us: 1e6 }[m[2]];
  }
  let m;
  if ((m = l.match(/^\$scope \w+ (\S+) \$end/))) scope.push(m[1]);
  else if (l.startsWith('$upscope')) scope.pop();
  else if ((m = l.match(/^\$var (\w+) (\d+) (\S+) (\S+)/))) {
    const [, kind, w, id, name] = m;
    (vars[id] ||= []).push({ name, width: +w, scope: scope.join('.'), kind });
  } else if (l.startsWith('$enddefinitions')) break;
}

const changes = {};        // id -> [[tNs, valueString]]
let t = 0;
for (; i < lines.length; i++) {
  const l = lines[i].trim();
  if (!l || l[0] === '$') continue;
  if (l[0] === '#') { t = +l.slice(1) * timescalePs / 1000; continue; }
  let id, v;
  if (l[0] === 'b' || l[0] === 'B') { [v, id] = l.slice(1).split(/\s+/); }
  else { v = l[0]; id = l.slice(1); }
  const arr = (changes[id] ||= []);
  if (arr.length && arr[arr.length - 1][0] === t) arr[arr.length - 1][1] = v;
  else if (!arr.length || arr[arr.length - 1][1] !== v) arr.push([t, v]);
}
const endNs = t;

const find = (scopeName, name) => Object.entries(vars).find(([, vs]) => vs.some(v => v.scope === scopeName && v.name === name));
const toNum = s => (/[xz]/i.test(s) ? null : parseInt(s, 2));

const DUT = 'tb_pwm_led.dut';
const out = [];
const add = (label, scopeName, name, opts = {}) => {
  const [id, vs] = find(scopeName, name);
  const meta = vs.find(v => v.scope === scopeName);
  let ch = changes[id].map(([tt, v]) => [tt, toNum(v)]);
  if (opts.bit != null) {
    ch = ch.map(([tt, v]) => [tt, v == null ? null : (v >> opts.bit) & 1]);
    ch = ch.filter((c, k) => k === 0 || c[1] !== ch[k - 1][1]);
  }
  out.push({ label, path: `${scopeName}.${name}`, width: opts.bit != null ? 1 : meta.width, kind: meta.kind,
    radix: opts.radix || (meta.width > 1 && opts.bit == null ? 'hex' : 'bin'), changes: ch });
};

add('clk', DUT, 'clk');
add('rst', DUT, 'rst');
add('duty[7:0]', DUT, 'duty', { radix: 'hex' });
add('dir', DUT, 'dir');
add('pwm_cnt[7:0]', DUT, 'pwm_cnt', { radix: 'hex' });
for (let b = 0; b < 8; b++) add(`led[${b}]`, DUT, 'led', { bit: b });

// clk toggles every 20 ns for the whole run; store it compactly as a clock spec
const clk = out[0];
const clkPeriod = clk.changes[2][0] - clk.changes[0][0];
clk.clock = { periodNs: clkPeriod, firstRiseNs: clk.changes.find(c => c[1] === 1)[0] };
clk.changes = clk.changes.slice(0, 4);

// SST hierarchy (the real scope tree in the VCD)
const sst = {};
for (const vs of Object.values(vars)) for (const v of vs) (sst[v.scope] ||= []).push({ name: v.name, width: v.width, kind: v.kind });

// one PWM period window at the widest-duty region before direction flips (for the zoom target)
const dutyCh = out[2].changes;
const peak = dutyCh.find(c => c[1] === 255);
const periodNs = 256 * clkPeriod;
const zoom = { startNs: Math.round((peak[0] - 3 * periodNs) / clkPeriod) * clkPeriod, spanNs: periodNs };

// real `gtkwave -x real/pwm_led.vcd` output (captured to real/gtkwave/load.log), minus the GLib dbus noise
const loadLog = readFileSync('real/gtkwave/load.log', 'utf8').split(/\r?\n/).filter(l => l.trim() && !/GLib|Exiting early/.test(l));
const json = { source: 'real/pwm_led.vcd', command: 'gtkwave -x real/pwm_led.vcd', loadLog, generator: hdrVersion, dumped: hdrDate, timescale: '1ps', unit: 'ns',
  endNs, clkPeriodNs: clkPeriod, pwmPeriodNs: periodNs, zoom, sst, signals: out };
writeFileSync('data/04-gtkwave.json', JSON.stringify(json));
console.log('end', endNs, 'ns; signals', out.map(s => `${s.label}:${s.changes.length}`).join(' '), 'zoom', zoom);
