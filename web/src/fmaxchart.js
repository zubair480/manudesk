// Fmax per check: one point per Menu Desk check (x = check number, y = nextpnr Fmax), rejected checks marked
// with a red cross (at their Fmax if they routed, on the floor if they never reached place-and-route), the
// best-so-far line, and dashed baseline / target lines.
// mountFmaxChart(el, checks, {baseline, target}) -> {push(check), destroy()}. push() eases the axes to the new
// range and pops the new point in.
import './viewers.css';

const NS = 'http://www.w3.org/2000/svg';
const TWEEN = 650;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = u => 1 - Math.pow(1 - u, 3);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const mhz = c => (c && c.fmax_mhz != null && isFinite(+c.fmax_mhz) ? +c.fmax_mhz : null);

function niceStep(span, n) {
  const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export function mountFmaxChart(el, checks = [], opts = {}) {
  const root = document.createElement('div');
  root.className = 'mdv mdv-chart';
  root.innerHTML = `<div class="mdv-head"><span class="mdv-big" data-r="best">…</span><span class="mdv-sub" data-r="info"></span></div>
    <div data-r="plot" style="position:relative"><svg role="img" aria-label="Fmax per check"></svg><div class="mdv-tip" data-r="tip"></div></div>`;
  el.appendChild(root);
  const $ = k => root.querySelector(`[data-r="${k}"]`);
  const plot = $('plot'), svg = plot.querySelector('svg'), tip = $('tip');
  const baseline = opts.baseline ?? null, target = opts.target ?? null;
  let data = [], dom = null, anim = 0, guard = 0, fresh = null, freshTimer = 0;

  const norm = list => [...list].filter(Boolean).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  data = norm(checks).map((c, i) => ({...c, n: c.n ?? i + 1}));

  function domainFor(list) {
    const ys = list.map(mhz).filter(v => v != null).concat([baseline, target].filter(v => v != null));
    const hi = Math.max(10, ...ys) * 1.14, step = niceStep(hi, 5);
    const ns = list.map(c => c.n);
    return {x0: Math.min(1, ...ns) - .5, x1: Math.max(4, ...ns) + .5, y1: Math.ceil(hi / step) * step, step};
  }

  function render(d, newPt, prog) {
    const W = Math.max(260, plot.clientWidth), narrow = W < 460, H = narrow ? 210 : 240;
    const m = {l: 42, r: narrow ? 14 : 18, t: 18, b: 34}, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = n => m.l + (n - d.x0) / (d.x1 - d.x0) * iw, Y = v => m.t + ih - v / d.y1 * ih;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let h = `<defs><linearGradient id="mdvArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--v-accent)" stop-opacity=".22"/>`
      + `<stop offset="1" stop-color="var(--v-accent)" stop-opacity="0"/></linearGradient></defs>`;
    for (let v = 0; v <= d.y1 + 1e-6; v += d.step) {
      h += `<line class="${v ? 'grid' : 'ax'}" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`
        + `<text class="tk" x="${m.l - 7}" y="${Y(v) + 3.5}" text-anchor="end">${+v.toFixed(1)}</text>`;
    }
    const firstN = Math.ceil(d.x0), lastN = Math.floor(d.x1), every = Math.ceil((lastN - firstN + 1) / (narrow ? 8 : 14));
    for (let n = firstN; n <= lastN; n++) if ((n - firstN) % every === 0)
      h += `<text class="tk" x="${X(n)}" y="${H - m.b + 16}" text-anchor="middle">#${n}</text>`;
    h += `<text class="axl" x="${m.l}" y="${m.t - 6}">MHZ</text><text class="axl" x="${W - m.r}" y="${H - 3}" text-anchor="end">CHECK</text>`;
    // baseline / target
    const ref = (v, cls, txt, left) => {
      if (v == null) return '';
      const y = Y(v);
      return `<line class="ref ${cls}" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`
        + `<text class="refl ${cls}" x="${left ? m.l + 4 : W - m.r - 2}" y="${y - 5}" text-anchor="${left ? 'start' : 'end'}">${txt} ${+(+v).toFixed(1)}</text>`;
    };
    // labels sit at the right end; if the two lines nearly coincide the baseline label moves to the left end
    const closeRefs = baseline != null && target != null && Math.abs(Y(baseline) - Y(target)) < 14;
    h += ref(baseline, 'base', 'baseline', closeRefs) + ref(target, 'tgt', 'target');
    // points in screen space; the newcomer slides in from the previous best
    const pts = data.map(c => {
      const v = mhz(c), ok = !!c.accepted && v != null;
      return {c, ok, v, x: X(c.n), y: v != null ? Y(v) : Y(0) - 8};
    });
    let run = -Infinity, bestPts = [];
    for (const p of pts) if (p.ok && p.v > run) { run = p.v; bestPts.push(p); } else if (p.ok) bestPts.push({...p, y: Y(run), ghost: true});
    if (newPt && prog < 1) {
      const p = pts.find(q => q.c === newPt), prevBest = bestPts.filter(q => q.c !== newPt).pop();
      if (p && prevBest) { const tx = p.x, ty = p.y; p.x = prevBest.x + (tx - prevBest.x) * prog; p.y = prevBest.y + (ty - prevBest.y) * prog; }
      const bp = bestPts.find(q => q.c === newPt); if (bp && p) { bp.x = p.x; bp.y = bp.ghost ? bp.y : p.y; }
    }
    if (bestPts.length) {
      let line = `M${bestPts[0].x},${bestPts[0].y}`;
      for (let i = 1; i < bestPts.length; i++) line += ` H${bestPts[i].x} V${bestPts[i].y}`;
      const area = line + ` V${Y(0)} H${bestPts[0].x} Z`;
      h += `<path class="area" d="${area}"/><path class="best" d="${line}"/>`;
    }
    const top = pts.filter(p => p.ok).reduce((a, p) => (!a || p.v > a.v ? p : a), null);
    for (const p of pts) {
      const isNew = p.c === newPt, sc = isNew && prog < 1 ? Math.max(.01, prog) : 1;
      const lbl = p.v != null ? p.v.toFixed(1) : (p.c.stage || 'rejected');
      const cls = `pt${p.ok ? '' : ' rej'}${p === top ? ' top' : ''}${isNew && fresh === newPt && prog >= 1 ? ' new' : ''}`;
      const ly = p.y - 11 < m.t ? p.y + 20 : p.y - 11;
      h += `<g class="${cls}" tabindex="0" data-n="${esc(p.c.n)}" transform="translate(${p.x},${p.y}) scale(${sc})">`
        + `<circle class="pulse" r="5"/><circle class="hit" r="14"/>`
        + (p.ok ? `<circle class="dot" r="5.5"/>`
          : `<circle class="ring" r="7.5"/><path d="M-3.6,-3.6 L3.6,3.6 M3.6,-3.6 L-3.6,3.6"/>`)
        + `<text class="val" y="${ly - p.y}" text-anchor="middle">${esc(lbl)}</text></g>`;
    }
    if (!data.length) h += `<text class="tk" x="${m.l + iw / 2}" y="${m.t + ih / 2}" text-anchor="middle">waiting for the first check…</text>`;
    svg.innerHTML = h;
  }

  function head() {
    const acc = data.filter(c => c.accepted && mhz(c) != null), best = acc.reduce((a, c) => Math.max(a, mhz(c)), -Infinity);
    const rej = data.length - data.filter(c => c.accepted).length;
    $('best').innerHTML = acc.length ? `${best.toFixed(1)} <small>MHz best</small>` : `— <small>MHz</small>`;
    const x = acc.length && baseline ? `<b>${(best / baseline).toFixed(2)}x</b> baseline · ` : '';
    $('info').innerHTML = `${x}${data.length} check${data.length === 1 ? '' : 's'}` + (rej ? ` · ${rej} rejected` : '')
      + (target != null ? ` · target ${+(+target).toFixed(1)} MHz` : '');
  }

  function draw(newPt) {
    cancelAnimationFrame(anim); clearTimeout(guard);
    const to = domainFor(data);
    head();
    if (!newPt || !dom || reduce()) { dom = to; render(dom, newPt, 1); return; }
    const from = dom, t1 = performance.now();
    const done = () => { cancelAnimationFrame(anim); clearTimeout(guard); dom = to; render(dom, newPt, 1); };
    guard = setTimeout(done, TWEEN + 120);   // rAF stalls in background tabs; never leave the chart mid-tween
    const step = now => {
      const u = Math.min(1, (now - t1) / TWEEN), e = ease(u);
      dom = {x0: from.x0 + (to.x0 - from.x0) * e, x1: from.x1 + (to.x1 - from.x1) * e,
        y1: from.y1 + (to.y1 - from.y1) * e, step: e < .5 ? from.step : to.step};
      render(dom, newPt, e);
      if (u < 1) anim = requestAnimationFrame(step); else done();
    };
    anim = requestAnimationFrame(step);
  }

  // tooltip on hover / focus / tap
  function show(g) {
    const n = g.dataset.n, c = data.find(q => String(q.n) === n); if (!c) return;
    const v = mhz(c);
    let t = `Check #${c.n} · ${c.accepted ? 'accepted' : 'rejected' + (c.stage ? ' at ' + c.stage : '')}`;
    if (v != null) t += `\n${v.toFixed(1)} MHz` + (c.vs_baseline ? ` · ${c.vs_baseline} baseline` : '');
    if (c.critical_path) t += `\n${c.critical_path}`;
    if (!c.accepted && c.reasons?.length) t += `\n${c.reasons.slice(0, 2).join('\n')}`;
    tip.textContent = t; tip.style.display = 'block';
    const pr = plot.getBoundingClientRect(), gr = g.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = gr.left + gr.width / 2 - pr.left, cy = gr.top - pr.top;
    tip.style.left = Math.max(0, Math.min(cx - tw / 2, pr.width - tw)) + 'px';
    tip.style.top = (cy - th - 6 < 0 ? cy + gr.height + 6 : cy - th - 6) + 'px';
  }
  const hide = () => { tip.style.display = 'none'; };
  svg.addEventListener('pointerover', e => { const g = e.target.closest('.pt'); g ? show(g) : hide(); });
  svg.addEventListener('pointerdown', e => { const g = e.target.closest('.pt'); g ? show(g) : hide(); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focusin', e => { const g = e.target.closest('.pt'); if (g) show(g); });
  svg.addEventListener('focusout', hide);

  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = plot.clientWidth; if (w && w !== lastW) { lastW = w; if (dom) render(dom, null, 1); else draw(); } });
  ro.observe(plot);
  draw();

  return {
    push(check) {
      if (!check) return;
      const c = {...check, n: check.n ?? (data.length ? Math.max(...data.map(q => q.n)) + 1 : 1)};
      const i = data.findIndex(q => (c.id != null && q.id === c.id) || q.n === c.n);
      if (i >= 0) data[i] = c; else data.push(c);
      data = norm(data);
      fresh = c; clearTimeout(freshTimer); freshTimer = setTimeout(() => { fresh = null; }, TWEEN + 1300);
      draw(c);
    },
    destroy() { cancelAnimationFrame(anim); clearTimeout(guard); clearTimeout(freshTimer); ro.disconnect(); root.remove(); },
  };
}
