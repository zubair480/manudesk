// 07-nextpnr-3d: the real nextpnr-ecp5 placement and routing of pwm_led, on a 3D ECP5-85F.
// Data: data/07-nextpnr-3d.json (built by extract.py from real/nextpnr/routed.json; real BELs, real pip routing).
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0';
const W = 126, H = 96;                      // ECP5-85F tile grid
const tx = x => x - (W - 1) / 2, tz = y => y - (H - 1) / 2;
const PKG = 156, PKG_T = 8, BALL_R = 2.3, PKG_BOT = 3.9;
const PKG_TOP = PKG_BOT + PKG_T, DIE_T = 2.2, DIE_TOP = PKG_TOP + DIE_T, TILE_T = 0.18, TILE_TOP = DIE_TOP + TILE_T;
const CELL_H = 0.42, IO_H = 0.3;
const COLORS = { lut: '#2563eb', ff: '#f59e0b', carry: '#7c3aed', io: '#10b981', gb: '#0891b2' };
const TOOL = '#c026d3';
const REGION = { x0: 0, x1: 9, y0: 32, y1: 48 };   // tiles our design occupies (cells x2..8, y33..46, IOs on x=0)

const ease = {
  inOut: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  out: t => 1 - Math.pow(1 - t, 3),
  settle: t => { const c = 1.25; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }, // tiny overshoot
};
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clamp01 = v => Math.max(0, Math.min(1, v));

let S = null;   // live scene state (one instance at a time)

export default {
  id: '07-nextpnr-3d',
  tool: 'nextpnr',
  title: 'Placing and routing pwm_led on a real ECP5-85F',
  css: true,

  async mount(root, ctx) {
    root.innerHTML = `
      <div class="n3d">
        <aside class="n3d-side">
          <div class="window panel n3d-log">
            <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>nextpnr-ecp5</b> · place &amp; route</div></div>
            <div class="term" id="n3d-term"></div>
          </div>
          <div class="panel n3d-stats">
            <div class="n3d-fmax"><div class="l">Fmax</div><div class="v"><span id="n3d-fmax">0.00</span><small>MHz</small></div><div class="sub" id="n3d-fmax-sub">target 25 MHz</div></div>
            <div class="n3d-bars" id="n3d-bars"></div>
          </div>
        </aside>
        <section class="panel n3d-view" id="n3d-view">
          <canvas id="n3d-canvas"></canvas>
          <svg class="n3d-leaders" id="n3d-leaders"></svg>
          <div class="n3d-labels" id="n3d-labels"></div>
          <div class="n3d-tag" id="n3d-tag"><b>LFE5U-85F</b><span>CABGA381 · 126 × 96 tiles</span></div>
          <div class="n3d-legend" id="n3d-legend">
            <span><i style="background:${COLORS.lut}"></i>LUT</span><span><i style="background:${COLORS.carry}"></i>Carry</span>
            <span><i style="background:${COLORS.ff}"></i>FF</span><span><i style="background:${COLORS.io}"></i>IO</span>
            <span><i class="w"></i>Routed net</span>
          </div>
          <div class="n3d-read" id="n3d-read">
            <div><span>Cells placed</span><b id="r-cells">0</b></div>
            <div><span>Wirelength</span><b id="r-wire">8,955</b></div>
            <div><span>Arcs routed</span><b id="r-arcs">0</b></div>
          </div>
          <div class="n3d-hero" id="n3d-hero">
            <div class="x" id="h-x">1.0×</div><div class="cap">headroom</div>
            <div class="bar b-need"><span>Needed</span><i></i><b>25 MHz</b></div>
            <div class="bar b-got"><span>Achieved</span><i></i><b>214.96 MHz</b></div>
          </div>
          <div class="n3d-scale" id="n3d-scale"></div>
          <div class="n3d-bit" id="n3d-bit"></div>
          <div class="n3d-err" id="n3d-err" hidden></div>
        </section>
      </div>`;
    const $ = s => root.querySelector(s);
    const libs = loadThree();   // start the CDN imports while the data loads
    libs.catch(() => {});
    const [data, logText] = await Promise.all([ctx.data('07-nextpnr-3d'), ctx.text('real/nextpnr/nextpnr.log')]);
    S = { root, $, data, log: logText.replace(/\r/g, '').split('\n'), ctx, tweens: [], clock: 0, raf: 0, labels: [], disposables: [], frame: 0 };

    // Utilisation bars (real numbers; tiny on purpose)
    const u = data.util, L = data.lut4;
    const bars = [
      ['LUT4', L.total, L.available], ['FF', u.TRELLIS_FF.used, u.TRELLIS_FF.available],
      ['IO', u.TRELLIS_IO.used, u.TRELLIS_IO.available], ['Global clk', u.DCCA.used, u.DCCA.available],
    ];
    $('#n3d-bars').innerHTML = bars.map(([k, a, b]) => `
      <div class="bar" data-p="${(a / b) * 100}"><div class="row"><span>${k}</span><b>${a.toLocaleString()}<em>/ ${b.toLocaleString()}</em></b></div>
      <div class="track"><i></i></div><div class="pct">${((a / b) * 100).toFixed(2)}%</div></div>`).join('');

    try {
      const [THREE, { RoomEnvironment }, { RoundedBoxGeometry }] = await libs;
      build(THREE, RoomEnvironment, RoundedBoxGeometry);
    } catch (e) {
      console.error('[07-nextpnr-3d] three.js failed', e);
      const err = $('#n3d-err'); err.hidden = false; err.textContent = 'Could not load three.js from the CDN.';
    }
  },

  async play(ctx) {
    ctx.visual?.();   // the chip is the figure: real-time from the first frame
    if (!S || !S.three) {
      ctx.narrate('nextpnr placed 152 LUTs + 41 FFs on an 83,640-LUT ECP5 and hit 214.96 MHz (25 MHz needed).');
      await ctx.sleep(4000); return;
    }
    const s = S, d = s.data, $ = s.$;
    const chunks = splitLog(s.log);
    const term = $('#n3d-term');
    const nCells = d.cells.length, hx = (d.fmax / d.fmaxTarget).toFixed(1);

    // 1. Hook + the whole chip.
    ctx.narrate('Will it fit on the chip, and will it run fast enough?');
    term.innerHTML = `<span class="prompt">$ </span><span class="cmd">${esc(d.command[0])}</span>\n`;
    s.orbitSpeed = 0.035;
    await streamLog(ctx, term, chunks[0], 2600);

    // 2. Dolly in to the tiny region our design occupies; cells drop in.
    ctx.narrate('The FPGA: 83,640 LUTs. Our whole design lands in this corner.');
    s.orbitSpeed = 0;
    flyTo(s.views.region, 3600);
    showRegion(1400);
    hideLabel('chip'); hideLabel('ours', 1800);
    $('#n3d-read').classList.add('on');
    const logP = streamLog(ctx, term, chunks[1], 5200);
    await ctx.sleep(1500);
    ctx.narrate(`150 Yosys cells → ${d.lut4.total} LUTs + ${d.util.TRELLIS_FF.used} flip-flops: 0.18% of the chip`);
    dropCells(4200);
    counter('#r-cells', 0, nCells, 4200, v => `${v}<em>/ ${nCells}</em>`);
    counter('#r-wire', 8955, 352, 4200, v => `${v.toLocaleString()}<em>from 8,955</em>`);   // HeAP random -> SA final (nextpnr.log)
    showScale();
    await ctx.sleep(2600);
    ['io', 'carry', 'lut', 'ff'].forEach((k, i) => setTimeout(() => showLabel(k), i * 260 / ctx.speed));
    await logP;

    // 3. Routing: the real routed wires, pip by pip.
    ctx.narrate(`Then nextpnr wires them: ${d.arcs} connections through real routing`);
    flyTo(s.views.route, 5200);
    hideLabel('io'); hideLabel('lut');
    const logR = streamLog(ctx, term, chunks[2], 4600);
    drawWires(4800);
    counter('#r-arcs', 0, d.arcs, 4800, v => `${v}<em>/ ${d.arcs}</em>`);
    await ctx.sleep(2400);
    showLabel('rst');
    await logR;
    await ctx.sleep(600);

    // 4. Timing: critical path, Fmax.
    ctx.narrate(`Slowest path: ${d.critical.ns} ns. That means ${d.fmax} MHz max.`);
    hideLabel('carry'); hideLabel('ff'); hideLabel('rst');
    highlightCritical(900);
    showLabel('crit');
    flyTo(s.views.crit, 2600);
    countUp($('#n3d-fmax'), d.fmax, 1400, 2);
    $('#n3d-fmax-sub').innerHTML = `target 25 MHz · <b>${hx}× headroom</b>`;
    s.routed = true;
    const logT = streamLog(ctx, term, chunks[3], 2600);
    await ctx.sleep(1800);

    // 5. Payoff: needed vs achieved.
    ctx.narrate(`We need 25 MHz. That's ${hx}× headroom.`);
    hideLabel('crit');
    const hero = $('#n3d-hero');
    hero.classList.add('on');
    requestAnimationFrame(() => {
      hero.querySelector('.b-got i').style.width = '100%';
      hero.querySelector('.b-need i').style.width = `${(d.fmaxTarget / d.fmax) * 100}%`;
    });
    counter('#h-x', d.fmaxTarget, d.fmax, 1500, v => `${(v / d.fmaxTarget).toFixed(1)}×`, 1);
    await ctx.sleep(500);
    ctx.focus?.(hero, { scale: 1.6, ms: 800 });
    await ctx.sleep(2200);
    ctx.unfocus?.({ ms: 700 });
    await logT;

    // 6. Bitstream.
    term.insertAdjacentHTML('beforeend', `\n<span class="prompt">$ </span><span class="cmd">${esc(d.command[1])}</span>\n<span class="ok">wrote pwm_led.bit (${d.bitBytes.toLocaleString()} bytes)</span>\n`);
    term.scrollTop = term.scrollHeight;
    const kb = (d.bitBytes / 1024).toFixed(1);
    $('#n3d-bit').innerHTML = `<span class="dot"></span><span>Bitstream written</span><b>pwm_led.bit</b><em>${kb} KB</em>`;
    $('#n3d-bit').classList.add('on');
    const m = (key, label, value, unit = '') => ctx.emit('metric', { key, label, value, unit });
    m('fmax', 'Fmax (nextpnr)', d.fmax, 'MHz');
    m('fmax_target', 'Clock needed', d.fmaxTarget, 'MHz');
    m('luts_placed', 'LUT4s placed', d.lut4.total);
    m('ffs', 'Flip-flops', d.util.TRELLIS_FF.used);
    m('utilization', 'LUT utilisation', +((d.lut4.total / d.lut4.available) * 100).toFixed(2), '%');
    m('routed_arcs', 'Arcs routed', d.arcs);
    m('bitstream_bytes', 'Bitstream', d.bitBytes, 'bytes');
    ctx.narrate('Fast enough. But is it right for every possible input?');
    hero.classList.remove('on');
    flyTo(s.views.final, 3200);
    setTimeout(() => { if (S) S.orbitSpeed = 0.05; }, 3200 / ctx.speed);
    await ctx.sleep(3600);
  },

  unmount() {
    if (!S) return;
    const s = S; S = null;
    cancelAnimationFrame(s.raf);
    s.ro?.disconnect();
    s.three?.scene.traverse(o => o.isInstancedMesh && o.dispose());
    s.disposables.forEach(o => o.dispose?.());
    if (s.renderer) { s.renderer.dispose(); s.renderer.forceContextLoss(); }
  },
};

// three via the shell's importmap (one shared instance); jsdelivr +esm if the map is missing.
async function loadThree() {
  try {
    return await Promise.all([import('three'), import('three/addons/environments/RoomEnvironment.js'), import('three/addons/geometries/RoundedBoxGeometry.js')]);
  } catch {
    return Promise.all([import(`${CDN}/+esm`), import(`${CDN}/examples/jsm/environments/RoomEnvironment.js/+esm`),
      import(`${CDN}/examples/jsm/geometries/RoundedBoxGeometry.js/+esm`)]);
  }
}

// ---------------------------------------------------------------- 3D build
function build(THREE, RoomEnvironment, RoundedBoxGeometry) {
  const s = S, d = s.data, $ = s.$;
  const canvas = $('#n3d-canvas'), view = $('#n3d-view');
  const track = o => (s.disposables.push(o), o);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xffffff, 1);
  renderer.debug.checkShaderErrors = false;   // no sync GL queries per shader compile

  const scene = new THREE.Scene();
  const pmrem = track(new THREE.PMREMGenerator(renderer));
  const envRT = track(pmrem.fromScene(new RoomEnvironment(), 0.04));
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 2000);

  // Lights: soft key + fill. Shadow frustum follows the camera target (tight = crisp contact shadows).
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe2e7, 0.1));
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xf3f6ff, 0.55);
  fill.position.set(120, 80, 60);
  scene.add(fill);

  // Ground: shadow catcher + a soft contact-shadow blob under the package (ambient-occlusion feel).
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(3000, 3000)), track(new THREE.ShadowMaterial({ opacity: 0.2 })));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const blob = new THREE.Mesh(track(new THREE.PlaneGeometry(PKG * 1.45, PKG * 1.45)),
    track(new THREE.MeshBasicMaterial({ map: track(blobTexture(THREE)), transparent: true, depthWrite: false, toneMapped: false })));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; scene.add(blob);

  // Package: light-gray substrate with bevelled edges, on BGA solder balls.
  const pkgMat = track(new THREE.MeshStandardMaterial({ color: '#d9dce1', roughness: 0.38, metalness: 0.0, envMapIntensity: 0.7 }));
  const pkg = new THREE.Mesh(track(new RoundedBoxGeometry(PKG, PKG_T, PKG, 5, 2.4)), pkgMat);
  pkg.position.y = PKG_BOT + PKG_T / 2; pkg.castShadow = pkg.receiveShadow = true; scene.add(pkg);

  const ballGeo = track(new THREE.SphereGeometry(BALL_R, 14, 10));
  const ballMat = track(new THREE.MeshStandardMaterial({ color: '#c3c6cb', metalness: 0.85, roughness: 0.32, envMapIntensity: 0.9 }));
  const N = 20, pitch = (PKG - 14) / (N - 1);
  const balls = new THREE.InstancedMesh(ballGeo, ballMat, N * N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  let bi = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    m4.compose(v.set(-PKG / 2 + 7 + i * pitch, BALL_R * 0.86, -PKG / 2 + 7 + j * pitch), q, sc.set(1, 0.9, 1));
    balls.setMatrixAt(bi++, m4);
  }
  balls.castShadow = true; scene.add(balls);

  // Die: a slightly darker silicon slab.
  const dieMat = track(new THREE.MeshStandardMaterial({ color: '#b3b9c2', roughness: 0.32, metalness: 0.12, envMapIntensity: 0.8 }));
  const die = new THREE.Mesh(track(new RoundedBoxGeometry(W + 4, DIE_T, H + 4, 3, 0.7)), dieMat);
  die.position.y = PKG_TOP + DIE_T / 2; die.castShadow = die.receiveShadow = true; scene.add(die);

  // Marking on the package margin (texture, not HTML).
  const mark = new THREE.Mesh(track(new THREE.PlaneGeometry(84, 21)),
    track(new THREE.MeshStandardMaterial({ map: track(markTexture(THREE)), transparent: true, roughness: 0.6, depthWrite: false })));
  mark.rotation.x = -Math.PI / 2; mark.position.set(-PKG / 2 + 52, PKG_TOP + 0.02, H / 2 + 2 + 12.5); scene.add(mark);
  const pin1 = new THREE.Mesh(track(new THREE.CircleGeometry(2.2, 40)), track(new THREE.MeshStandardMaterial({ color: '#c6cad0', roughness: 0.8 })));
  pin1.rotation.x = -Math.PI / 2; pin1.position.set(-PKG / 2 + 7, PKG_TOP + 0.02, -PKG / 2 + 7); scene.add(pin1);

  // Fabric: raised instanced tiles near our region (seen up close); a flat texture everywhere else.
  const tileMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.0, envMapIntensity: 0.22 }));
  const near = (x, y) => x <= 30 && y >= 14 && y <= 80;
  const nearTiles = [];
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (near(x, y)) nearTiles.push([x, y]);
  const nearMesh = new THREE.InstancedMesh(track(new RoundedBoxGeometry(0.84, TILE_T, 0.84, 1, 0.05)), tileMat, nearTiles.length);
  const c = new THREE.Color();
  nearTiles.forEach(([x, y], i) => {
    const ring = x === 0 || y === 0 || x === W - 1 || y === H - 1;
    m4.compose(v.set(tx(x), TILE_T / 2, tz(y)), q, sc.set(ring ? 0.92 : 1, 1, ring ? 0.92 : 1));
    nearMesh.setMatrixAt(i, m4);
    nearMesh.setColorAt(i, c.set(ring ? '#d5d9df' : '#eceef2'));
  });
  nearMesh.receiveShadow = true; scene.add(nearMesh);
  // Raised tiles rise out of the flat fabric texture during the dolly (avoids moire in the wide shot).
  nearMesh.visible = false; nearMesh.position.y = DIE_TOP + 0.005; nearMesh.scale.y = 0.01;

  // Far fabric: one mipmapped texture on the die (no moire at a distance, and cheap).
  const fab = new THREE.Mesh(track(new THREE.PlaneGeometry(W + 4, H + 4)),
    track(new THREE.MeshStandardMaterial({ map: track(fabricTexture(THREE, renderer)), roughness: 0.6, envMapIntensity: 0.35 })));
  fab.rotation.x = -Math.PI / 2; fab.position.y = DIE_TOP + 0.01; fab.receiveShadow = true; scene.add(fab);

  // Region highlight: tint + an outline in the tool colour (revealed during the dolly).
  const regionIdx = [];
  nearTiles.forEach(([x, y], i) => {
    if (x >= REGION.x0 && x <= REGION.x1 && y >= REGION.y0 && y <= REGION.y1) regionIdx.push([i, x === 0]);
  });
  const outline = new THREE.Group();
  const olMat = track(new THREE.MeshStandardMaterial({ color: TOOL, roughness: 0.4, transparent: true, opacity: 0 }));
  const rx0 = tx(REGION.x0) - 0.6, rx1 = tx(REGION.x1) + 0.6, rz0 = tz(REGION.y0) - 0.6, rz1 = tz(REGION.y1) + 0.6;
  const olGeo = track(new THREE.BoxGeometry(1, 0.03, 1));
  [[rx0, rz0, rx1, rz0], [rx0, rz1, rx1, rz1], [rx0, rz0, rx0, rz1], [rx1, rz0, rx1, rz1]].forEach(([a, b, cc, e]) => {
    const mm = new THREE.Mesh(olGeo, olMat);
    mm.scale.set(Math.abs(cc - a) + 0.05 || 0.05, 1, Math.abs(e - b) + 0.05 || 0.05);
    mm.position.set((a + cc) / 2, TILE_TOP + 0.03, (b + e) / 2); outline.add(mm);
  });
  scene.add(outline);

  // Placed cells: one InstancedMesh, colour per type, real BEL positions within each tile.
  const cellGeo = track(new RoundedBoxGeometry(1, 1, 1, 3, 0.16));
  const cellMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.42, metalness: 0.02, envMapIntensity: 0.75 }));
  const cells = d.cells.map(cl => {
    let x = tx(cl.x), z = tz(cl.y), w, dpt, h;
    if (cl.t === 'io') {
      const bottom = cl.y === H - 1;
      if (bottom) { x = tx(cl.x) + (cl.s - 1.5) * 0.21; z = tz(cl.y); } else { x += 0.04; z += (cl.s - 1.5) * 0.21; }
      w = bottom ? 0.16 : 0.62; dpt = bottom ? 0.62 : 0.16; h = IO_H;
    } else if (cl.t === 'gb') { w = 0.5; dpt = 0.5; h = 0.36; }
    else {
      x += (cl.s - 1.5) * 0.205;
      z += (cl.t === 'ff' ? 0.1 : -0.3) + cl.k * 0.2;
      w = 0.185; dpt = 0.17; h = cl.t === 'ff' ? CELL_H * 0.85 : CELL_H;
    }
    return { ...cl, pos: new THREE.Vector3(x, TILE_TOP + h / 2, z), size: new THREE.Vector3(w, h, dpt) };
  });
  const order = { io: 0, gb: 1, carry: 2, lut: 3, ff: 4 };
  cells.sort((a, b) => order[a.t] - order[b.t] || a.y - b.y || a.x - b.x);
  const cellMesh = new THREE.InstancedMesh(cellGeo, cellMat, cells.length);
  const col = new THREE.Color();
  cells.forEach((cl, i) => { cellMesh.setColorAt(i, col.set(COLORS[cl.t])); cl.p = 0; });
  cellMesh.castShadow = true; cellMesh.receiveShadow = true; cellMesh.frustumCulled = false; scene.add(cellMesh);

  // Routed nets: real tile-to-tile pip hops, as traces in the channels between tiles.
  const wires = buildWires(THREE, d.nets);
  const wireGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const wireMat = track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.05, envMapIntensity: 0.7 }));
  const wireMesh = new THREE.InstancedMesh(wireGeo, wireMat, wires.length);
  wires.forEach((w, i) => { wireMesh.setColorAt(i, col.set(TOOL)); w.p = 0; });
  wireMesh.castShadow = true; wireMesh.frustumCulled = false; scene.add(wireMesh);

  s.three = { THREE, renderer, scene, camera, key, cells, cellMesh, wires, wireMesh, nearMesh, regionIdx, olMat, m4, q, v, sc, col };

  // Camera views (target, distance, azimuth, elevation in degrees).
  const regionCenter = new THREE.Vector3((tx(REGION.x0) + tx(REGION.x1)) / 2 + 0.5, TILE_TOP, (tz(REGION.y0) + tz(REGION.y1)) / 2);
  s.views = {
    chip: { t: new THREE.Vector3(0, PKG_TOP - 4, 8), dist: 300, az: -30, el: 32 },
    region: { t: regionCenter.clone().add(new THREE.Vector3(1, 0, 0)), dist: 34, az: -32, el: 46 },
    route: { t: regionCenter.clone().add(new THREE.Vector3(3, 0, 6)), dist: 46, az: -22, el: 46 },
    crit: { t: new THREE.Vector3(tx(5.6), TILE_TOP, tz(37.2)), dist: 20, az: -40, el: 44 },
    final: { t: new THREE.Vector3(tx(5.4), TILE_TOP, tz(38.6)), dist: 25, az: -24, el: 40 },
  };
  s.cam = { ...s.views.chip, t: s.views.chip.t.clone() };
  s.orbitSpeed = 0.035;

  // Labels.
  const centroid = t => {
    const list = cells.filter(cl => t(cl)); const p = new THREE.Vector3();
    list.forEach(cl => p.add(cl.pos)); return p.divideScalar(Math.max(1, list.length)).setY(TILE_TOP + CELL_H);
  };
  const rst = cells.find(cl => cl.n === 'rst');
  addLabel('chip', new THREE.Vector3(tx(96), TILE_TOP, tz(14)), '<b>LFE5U-85F</b> 83,640 LUTs · 126 × 96 tiles', 'ne');
  addLabel('ours', regionCenter.clone().setY(TILE_TOP + 0.5), '<b>pwm_led</b> lives here', 'nw', true);
  addLabel('io', centroid(cl => cl.t === 'io' && cl.x === 0), '<b>led[0..7], clk</b> IO pins', 'w');
  addLabel('carry', centroid(cl => cl.t === 'carry'), `<b>Carry chains</b> CCU2C · ${d.lut4.carry} LUT4s`, 'nw');
  addLabel('lut', centroid(cl => cl.t === 'lut'), `<b>Logic</b> ${d.lut4.logic} LUT4s`, 'ne');
  addLabel('ff', centroid(cl => cl.t === 'ff'), `<b>Flip-flops</b> ${d.util.TRELLIS_FF.used} DFFs`, 'se');
  if (rst) addLabel('rst', rst.pos.clone(), '<b>rst</b> pin X4/Y95 · longest net', 'e');
  const cp = new THREE.Vector3();
  d.critical.locs.forEach(([x, y]) => cp.add(new THREE.Vector3(tx(x), TILE_TOP + CELL_H + 0.3, tz(y)))); cp.divideScalar(d.critical.locs.length);
  addLabel('crit', cp, `<b>Critical path</b> ${d.critical.ns} ns → ${d.fmax} MHz`, 'ne', true);
  s.critNets = new Set(d.criticalNets || []);
  s.cellsDirty = s.wiresDirty = true;

  // Resize + loop.
  const resize = () => {
    const r = view.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
    s.size = { w: r.width, h: r.height };
    s.reserved = null;
  };
  s.ro = new ResizeObserver(resize); s.ro.observe(view); resize();
  s.renderer = renderer;
  showLabel('chip', 600); showLabel('ours', 1200);

  let last = performance.now();
  const loop = now => {
    if (!S) return;
    s.raf = requestAnimationFrame(loop);
    const dt = Math.min(0.5, (now - last) / 1000); last = now;
    s.clock += dt * 1000 * (s.ctx.speed || 1);
    for (let i = s.tweens.length - 1; i >= 0; i--) {
      const tw = s.tweens[i], p = clamp01((s.clock - tw.t0) / tw.dur);
      if (s.clock >= tw.t0) tw.fn(p);
      if (p >= 1) s.tweens.splice(i, 1);
    }
    s.cam.az += s.orbitSpeed * dt * 60 * 0.1 * (s.ctx.speed || 1);
    updateCamera();
    updateCells(); updateWires();
    renderer.render(scene, camera);
    layoutLabels();
  };
  s.raf = requestAnimationFrame(loop);
}

function buildWires(THREE, nets) {
  const out = [];
  const routed = nets.filter(n => !n.g);
  routed.forEach((net, ni) => {
    const lane = ni % 5;
    const y = TILE_TOP + 0.035 + lane * 0.022;           // flat traces in the channels between tiles
    const deg = new Map(), pieces = [];
    const keyOf = (x, z) => `${x},${z}`;
    const bump = k => deg.set(k, (deg.get(k) || 0) + 1);
    net.segs.forEach(([x1, y1, x2, y2]) => {
      const pts = x1 !== x2 && y1 !== y2 ? [[x1, y1], [x2, y1], [x2, y2]] : [[x1, y1], [x2, y2]];
      for (let i = 0; i < pts.length - 1; i++) {
        pieces.push([pts[i], pts[i + 1]]); bump(keyOf(...pts[i])); bump(keyOf(...pts[i + 1]));
      }
    });
    const off = (lane - 2) * 0.028;              // lateral lane inside the channel, so parallel nets read as a bundle
    const P = ([x, yy]) => new THREE.Vector3(tx(x) + 0.5 + off, y, tz(yy) + 0.5 + off);
    pieces.sort((a, b) => (a[0][1] - b[0][1]) || (a[0][0] - b[0][0]));
    pieces.forEach(([a, b]) => out.push({ net: net.n, ni, a: P(a), b: P(b) }));
    deg.forEach((n, k) => {
      if (n !== 1) return;
      const [x, z] = k.split(',').map(Number);
      const top = P([x, z]);
      out.push({ net: net.n, ni, a: top.clone().setY(TILE_TOP + 0.16), b: top.clone().setY(DIE_TOP), drop: true });
    });
  });
  // Reveal order: interleave nets so routing spreads over the region rather than net by net.
  out.forEach((w, i) => { w.order = w.ni * 0.6 + (w.drop ? 0.4 : 0) + (i % 7) * 0.02; });
  const max = Math.max(...out.map(w => w.order)) || 1;
  out.forEach(w => { w.order /= max; });
  return out;
}

// ---------------------------------------------------------------- animation
function tween(dur, fn, delay = 0) { S.tweens.push({ t0: S.clock + delay, dur: Math.max(1, dur), fn }); }

function flyTo(view, dur) {
  const s = S, from = { ...s.cam, t: s.cam.t.clone() };
  let daz = view.az - from.az; daz = ((daz + 540) % 360) - 180;
  tween(dur, p => {
    const e = ease.inOut(p);
    s.cam.t.lerpVectors(from.t, view.t, e);
    s.cam.dist = Math.exp(Math.log(from.dist) + (Math.log(view.dist) - Math.log(from.dist)) * e);
    s.cam.az = from.az + daz * e;
    s.cam.el = from.el + (view.el - from.el) * e;
  });
}

function updateCamera() {
  const { camera, key } = S.three, c = S.cam;
  const az = c.az * Math.PI / 180, el = c.el * Math.PI / 180;
  camera.position.set(c.t.x + c.dist * Math.sin(az) * Math.cos(el), c.t.y + c.dist * Math.sin(el), c.t.z + c.dist * Math.cos(az) * Math.cos(el));
  camera.lookAt(c.t);
  // Key light from upper-left-front, shadow box sized to what's on screen.
  const half = Math.max(8, c.dist * 0.62);
  key.position.set(c.t.x - half * 1.1, c.t.y + half * 1.7, c.t.z + half * 0.7);
  key.target.position.copy(c.t);
  const sc = key.shadow.camera;
  if (Math.abs(sc.right - half) > 0.01) {
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 0.5; sc.far = half * 6; sc.updateProjectionMatrix();
  }
}

function showRegion(dur) {
  const { THREE, nearMesh, regionIdx, olMat, col } = S.three;
  nearMesh.visible = true;
  tween(dur * 1.4, p => { nearMesh.scale.y = Math.max(0.01, ease.out(p)); });
  const base = new THREE.Color('#eceef2'), ring = new THREE.Color('#d5d9df');
  const tint = new THREE.Color('#f6e4f8'), ringTint = new THREE.Color('#e9cdee');
  tween(dur, p => {
    regionIdx.forEach(([i, isRing]) => nearMesh.setColorAt(i, col.copy(isRing ? ring : base).lerp(isRing ? ringTint : tint, p)));
    nearMesh.instanceColor.needsUpdate = true;
    olMat.opacity = 0.75 * p;
  });
}

function dropCells(dur) {
  const cells = S.three.cells, n = cells.length;
  const ioDur = dur * 0.18;
  cells.forEach((c, i) => {
    const isIo = c.t === 'io' || c.t === 'gb';
    const delay = isIo ? (i / 11) * ioDur : ioDur + ((i - 11) / Math.max(1, n - 11)) * (dur - ioDur - 700);
    tween(700, p => { c.p = p; }, delay);
  });
  S.cellsDirty = true;
}

function updateCells() {
  const t = S.three; if (!S.cellsDirty) return;
  let busy = false;
  t.cells.forEach((c, i) => {
    const p = c.p, e = p <= 0 ? 0 : ease.settle(p);
    const drop = (1 - e) * 7;
    const s = p <= 0 ? 0.0001 : 0.55 + 0.45 * Math.min(1, e);
    t.m4.compose(t.v.set(c.pos.x, c.pos.y + drop, c.pos.z), t.q, t.sc.copy(c.size).multiplyScalar(s));
    t.cellMesh.setMatrixAt(i, t.m4);
    if (p < 1) busy = true;
  });
  t.cellMesh.instanceMatrix.needsUpdate = true;
  if (!busy && S.cellsSettled) S.cellsDirty = false;
  if (!busy) S.cellsSettled = true;
}

function drawWires(dur) {
  tween(dur, p => { S.wireP = p; });
  S.wiresDirty = true;
}

function updateWires() {
  const t = S.three; if (!S.wiresDirty) return;
  const P = S.wireP || 0, span = 0.12;
  const dir = new t.THREE.Vector3();
  t.wires.forEach((w, i) => {
    const p = clamp01((P - w.order * (1 - span)) / span);
    dir.subVectors(w.b, w.a);
    const len = dir.length();
    const th = w.drop ? 0.09 : (w.crit ? 0.11 : 0.06);
    if (p <= 0 || len === 0) { t.m4.makeScale(0, 0, 0); t.wireMesh.setMatrixAt(i, t.m4); return; }
    const L = len * p;
    t.v.copy(w.a).addScaledVector(dir, p / 2);
    if (w.crit && !w.drop) t.v.y += 0.08 * (S.critP || 0);
    if (w.drop) t.sc.set(th, L, th);
    else if (Math.abs(dir.x) > Math.abs(dir.z)) t.sc.set(L + th, th, th);
    else t.sc.set(th, th, L + th);
    t.m4.compose(t.v, t.q, t.sc);
    t.wireMesh.setMatrixAt(i, t.m4);
  });
  t.wireMesh.instanceMatrix.needsUpdate = true;
  if (P >= 1 && !S.critAnim) S.wiresDirty = false;
}

function highlightCritical(dur) {
  const t = S.three, crit = S.critNets;
  const hot = new t.THREE.Color('#86198f'), base = new t.THREE.Color(TOOL), cool = new t.THREE.Color('#e08eeb');
  t.wires.forEach(w => { w.crit = crit.has(w.net); });
  S.critAnim = true; S.wiresDirty = true;
  tween(dur, p => {
    t.wires.forEach((w, i) => t.wireMesh.setColorAt(i, t.col.copy(base).lerp(w.crit ? hot : cool, p)));
    t.wireMesh.instanceColor.needsUpdate = true;
    S.critP = p;
    if (p >= 1) S.critAnim = false;
  });
}

// ---------------------------------------------------------------- labels (projected, collision-avoiding)
function addLabel(id, anchor, html, side, accent = false) {
  const el = document.createElement('div');
  el.className = 'n3d-label' + (accent ? ' accent' : '');
  el.innerHTML = html;
  S.$('#n3d-labels').appendChild(el);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  S.$('#n3d-leaders').appendChild(line);
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('r', '3'); S.$('#n3d-leaders').appendChild(dot);
  if (accent) { line.classList.add('accent'); dot.classList.add('accent'); }
  S.labels.push({ id, anchor, el, line, dot, side, on: false });
}
function showLabel(id, delay = 0) {
  const l = S?.labels.find(l => l.id === id); if (!l) return;
  setTimeout(() => { if (S) { l.on = true; l.el.classList.add('on'); } }, delay);
}
function hideLabel(id, delay = 0) {
  const l = S?.labels.find(l => l.id === id); if (!l) return;
  setTimeout(() => { if (S) { l.on = false; l.el.classList.remove('on'); } }, delay);
}
function layoutLabels() {
  const s = S, { camera, THREE } = s.three, { w, h } = s.size;
  if (!s.labels.some(l => l.on)) { s.labels.forEach(l => { l.el.style.visibility = 'hidden'; l.line.style.opacity = l.dot.style.opacity = 0; }); return; }
  const v = new THREE.Vector3();
  if (!s.reserved || s.frame++ % 8 === 0) {   // HUD chips the labels must avoid (refreshed ~8x a second)
    const vr = s.$('#n3d-view').getBoundingClientRect();
    s.reserved = ['#n3d-tag', '#n3d-legend', '#n3d-scale', '#n3d-bit', '#n3d-read', '#n3d-hero'].map(q => s.$(q))
      .filter(el => +getComputedStyle(el).opacity > 0.05).map(el => el.getBoundingClientRect())
      .filter(r => r.width).map(r => ({ x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height }));
  }
  const placed = s.reserved.slice();
  const OFF = { ne: [34, -40], nw: [-34, -40], se: [34, 34], sw: [-34, 34], e: [44, -8], w: [-44, -8] };
  const items = s.labels.map(l => {
    v.copy(l.anchor).project(camera);
    const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
    const vis = l.on && v.z < 1 && x > 8 && x < w - 8 && y > 8 && y < h - 8;
    if (!l.bw || l.bw < 2) { l.bw = l.el.offsetWidth; l.bh = l.el.offsetHeight; }
    return { l, x, y, vis };
  }).sort((a, b) => a.y - b.y);
  for (const it of items) {
    const { l } = it;
    l.line.style.opacity = l.dot.style.opacity = it.vis ? 1 : 0;
    if (!it.vis) { l.el.style.visibility = 'hidden'; continue; }
    l.el.style.visibility = '';
    const [ox, oy] = OFF[l.side];
    let bx = it.x + ox - (ox < 0 ? l.bw : 0), by = it.y + oy - l.bh / 2;
    bx = Math.max(10, Math.min(w - l.bw - 10, bx));
    for (let k = 0; k < 40; k++) {
      const hit = placed.find(p => bx < p.x + p.w + 8 && bx + l.bw + 8 > p.x && by < p.y + p.h + 6 && by + l.bh + 6 > p.y);
      if (!hit) break;
      const up = hit.y - l.bh - 6;
      by = oy < 0 && up >= 10 ? up : hit.y + hit.h + 6;
    }
    by = Math.max(10, Math.min(h - l.bh - 60, by));
    placed.push({ x: bx, y: by, w: l.bw, h: l.bh });
    l.el.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px)`;
    const ex = ox < 0 ? bx + l.bw : bx, ey = by + l.bh / 2;
    l.line.setAttribute('d', `M${it.x.toFixed(1)},${it.y.toFixed(1)} L${(ex + (ox < 0 ? 10 : -10)).toFixed(1)},${ey.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`);
    l.dot.setAttribute('cx', it.x.toFixed(1)); l.dot.setAttribute('cy', it.y.toFixed(1));
  }
}

// ---------------------------------------------------------------- overlay helpers
function showScale() {
  const d = S.data, pct = ((d.lut4.total / d.lut4.available) * 100).toFixed(2);
  const el = S.$('#n3d-scale');
  el.innerHTML = `<b>${d.lut4.total}</b> LUT4s on an <b>${d.lut4.available.toLocaleString()}</b>-LUT chip<em>${pct}% used</em>`;
  el.classList.add('on');
  S.$('#n3d-bars').querySelectorAll('.bar').forEach((b, i) => setTimeout(() => {
    b.classList.add('on'); b.querySelector('i').style.width = `max(3px, ${b.dataset.p}%)`;
  }, i * 140));
}

function counter(sel, from, to, dur, fmt, dp = 0) {
  const el = S.$(sel);
  tween(dur, p => { const v = from + (to - from) * ease.out(p); el.innerHTML = fmt(dp ? +v.toFixed(dp) : Math.round(v)); });
}

function countUp(el, to, dur, dp) {
  tween(dur, p => { el.textContent = (to * ease.out(p)).toFixed(dp); });
}

function splitLog(lines) {
  const find = (re, from = 0) => { const i = lines.findIndex((l, k) => k >= from && re.test(l)); return i < 0 ? from : i; };
  const a = find(/Placed \d+ cells based on constraints/);
  const b = find(/Routing globals/, a);
  const c = find(/Router1 time/, b) + 1;
  const e = find(/Critical path report for cross-domain/, c);
  const f = find(/Max frequency for clock/, e);
  return [lines.slice(0, a), lines.slice(a, b), lines.slice(b, c), [...lines.slice(c, e), ...lines.slice(f, f + 3), ...lines.slice(-2)]];
}

function fmtLine(l) {
  let h = esc(l);
  if (/Max frequency/.test(l) && !S?.routed) h = `<span class="dim">${h}</span>`;   // pre-route estimate: don't show two Fmax values
  else if (/Max frequency/.test(l)) h = h.replace(/([\d.]+ MHz)/, '<b class="hl">$1</b>').replace('PASS', '<b class="ok">PASS</b>');
  else if (/warning/i.test(l)) h = `<span class="warn">${h}</span>`;
  else if (/Routing complete|Program finished/.test(l)) h = `<span class="ok">${h}</span>`;
  return h.replace(/^Info:/, '<span class="dim">Info:</span>');
}

async function streamLog(ctx, term, lines, dur) {
  const list = lines.filter((l, i) => l.trim() || (lines[i - 1] || '').trim());
  if (!list.length) return;
  const per = Math.max(1, Math.ceil(list.length / (dur / 45)));
  const wait = dur / Math.ceil(list.length / per);
  for (let i = 0; i < list.length; i += per) {
    term.insertAdjacentHTML('beforeend', list.slice(i, i + per).map(fmtLine).join('\n') + '\n');
    term.scrollTop = term.scrollHeight;
    try { await ctx.sleep(wait); } catch { return; }   // aborted: play() itself rejects on its own sleep
  }
}

// ---------------------------------------------------------------- textures
function markTexture(THREE) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(120,126,136,0.85)';
  g.font = '600 64px Geist, Inter, system-ui, sans-serif'; g.fillText('LATTICE', 8, 74);
  g.font = '500 70px "Geist Mono", ui-monospace, monospace'; g.fillText('ECP5-85F', 8, 160);
  g.fillStyle = 'rgba(120,126,136,0.6)';
  g.font = '400 40px "Geist Mono", ui-monospace, monospace'; g.fillText('LFE5U-85F-6BG381C', 8, 224);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

function fabricTexture(THREE, renderer) {
  const PX = 14, c = document.createElement('canvas'); c.width = (W + 4) * PX; c.height = (H + 4) * PX;
  const g = c.getContext('2d');
  g.fillStyle = '#b3b9c2'; g.fillRect(0, 0, c.width, c.height);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    const ring = x === 0 || y === 0 || x === W - 1 || y === H - 1, sz = (ring ? 0.77 : 0.84) * PX;
    g.fillStyle = ring ? '#d5d9df' : '#eceef2';
    g.fillRect((x + 2.5) * PX - sz / 2, (y + 2.5) * PX - sz / 2, sz, sz);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t;
}

function blobTexture(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.filter = 'blur(18px)';
  g.fillStyle = 'rgba(40,46,56,0.30)';
  g.beginPath(); g.roundRect(48, 48, 160, 160, 18); g.fill();
  g.filter = 'blur(4px)';
  g.fillStyle = 'rgba(30,34,42,0.22)';
  g.beginPath(); g.roundRect(62, 62, 132, 132, 8); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
