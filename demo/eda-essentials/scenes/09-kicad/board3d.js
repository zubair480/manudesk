// three.js 3D viewer for the pwm_led carrier board. Geometry comes from data/09-kicad.json:
// footprints and pads from the board definition, copper traces and vias from the real Freerouting .ses.
// The LEDs are driven by a cycle-faithful model of real/rtl/pwm_led.v (25 MHz, DIV = 16).
const V = '0.160.0';
const CDN = `https://cdn.jsdelivr.net/npm/three@${V}`;
// Prefer the shell's importmap ("three", "three/addons/") so the page shares one THREE instance;
// fall back to jsDelivr's +esm bundles if the importmap is missing.
const viaMap = () => import('three').then(() => true, () => false);
let useMap = null;
const core = async () => ((useMap ??= await viaMap()) ? import('three') : import(`${CDN}/+esm`));
const addon = async (p) => ((useMap ??= await viaMap()) ? import(`three/addons/${p}.js`) : import(`${CDN}/examples/jsm/${p}.js/+esm`));

/** Cycle model of pwm_led.v. One duty step every 2^DIV clocks; turnarounds stall for one step (dir flips first). */
export class PwmLed {
  constructor(fclk = 25e6, DIV = 16) { this.stepT = (1 << DIV) / fclk; this.duty = 0; this.dir = 1; this.acc = 0; }
  advance(dt) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.stepT && n++ < 4096) {
      this.acc -= this.stepT;
      if (this.dir && this.duty === 255) this.dir = 0;
      else if (!this.dir && this.duty === 0) this.dir = 1;
      else this.duty += this.dir ? 1 : -1;
    }
  }
  /** led[i] at PWM count c, exactly as the RTL: ((c + 32*i) mod 256) < duty */
  bit(i, c) { return ((c + 32 * i) & 255) < this.duty; }
  /** average brightness of led[i] over one 256-count PWM frame (= duty/256 for every i) */
  level(i) { let on = 0; for (let c = 0; c < 256; c++) on += this.bit(i, c); return on / 256; }
}

export async function createBoard3D(host, data, opts = {}) {
  const [THREE, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, { RoomEnvironment }] = await Promise.all([
    core(), addon('postprocessing/EffectComposer'), addon('postprocessing/RenderPass'),
    addon('postprocessing/UnrealBloomPass'), addon('postprocessing/OutputPass'), addon('environments/RoomEnvironment'),
  ]);
  const B = data.board, W = B.w, H = B.h, T = 1.6;
  const X = (x) => x - W / 2, Z = (y) => y - H / 2;

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'kc9-gl';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);   // white studio sweep
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(renderer), 0.04);
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 2000);

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(32, 70, 38); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6;
  Object.assign(key.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 10, far: 200 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.55); rim.position.set(-50, 30, -45); scene.add(rim);

  // ---------- materials ----------
  const mat = {
    mask: new THREE.MeshPhysicalMaterial({ color: 0x0f6a3c, roughness: 0.42, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.28, envMapIntensity: 0.6 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x8f8a5e, roughness: 0.75 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe6b85c, metalness: 1, roughness: 0.26, envMapIntensity: 1.1 }),
    tin: new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.32 }),
    black: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.45 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.7 }),
    capBody: new THREE.MeshStandardMaterial({ color: 0x9a7650, roughness: 0.6 }),
    ledBase: new THREE.MeshStandardMaterial({ color: 0xf2f1ea, roughness: 0.5 }),
    drill: new THREE.MeshBasicMaterial({ color: 0x2a2e33 }),
    substrate: new THREE.MeshStandardMaterial({ color: 0x24301f, roughness: 0.55 }),
  };
  const shadowy = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d, m, x, y, z) => { const o = shadowy(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)); o.position.set(x, y, z); return o; };
  const root = new THREE.Group(); scene.add(root);

  // ---------- board (rounded rect with drilled mounting holes) ----------
  const r = 1.5, shape = new THREE.Shape();
  shape.moveTo(-W / 2 + r, -H / 2); shape.lineTo(W / 2 - r, -H / 2); shape.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + r);
  shape.lineTo(W / 2, H / 2 - r); shape.quadraticCurveTo(W / 2, H / 2, W / 2 - r, H / 2); shape.lineTo(-W / 2 + r, H / 2);
  shape.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - r); shape.lineTo(-W / 2, -H / 2 + r); shape.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + r, -H / 2);
  for (const [hx, hy] of B.holes) { const h = new THREE.Path(); h.absarc(X(hx), -Z(hy), 1.6, 0, Math.PI * 2, true); shape.holes.push(h); }
  const bgeo = new THREE.ExtrudeGeometry(shape, { depth: T - 0.16, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2, curveSegments: 24 });
  bgeo.rotateX(-Math.PI / 2); bgeo.translate(0, 0.08, 0);
  const board = new THREE.Mesh(bgeo, [mat.mask, mat.edge]); board.receiveShadow = true; board.castShadow = true;
  root.add(board);

  // ---------- silkscreen (canvas texture) ----------
  const silkTex = (() => {
    const pxmm = 40, c = document.createElement('canvas'); c.width = W * pxmm; c.height = H * pxmm;
    const g = c.getContext('2d'); g.scale(pxmm, pxmm);
    g.strokeStyle = g.fillStyle = '#f1f0e6'; g.lineWidth = 0.15; g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = (s, x, y, size = 1, weight = 600) => { g.font = `${weight} ${size}px "Geist Mono", ui-monospace, monospace`; g.fillText(s, x, y); };
    for (const p of data.parts) {
      if (p.kind === 'res') txt(p.ref, p.x - 1.4, p.y, 0.8);
      else if (p.kind === 'led') { txt(p.ref, p.x - 1.5, p.y, 0.8); g.beginPath(); g.moveTo(p.x - 0.8, p.y + 1.5); g.lineTo(p.x + 0.8, p.y + 1.5); g.stroke(); txt(String(+p.ref.slice(1) - 1), p.x, p.y + 2.6, 0.9, 700); }
      else if (p.kind === 'cap') txt(p.ref, p.x, p.y - 1.0, 0.75);
      else if (p.kind === 'bga') { g.strokeRect(p.x - 5.6, p.y - 5.6, 11.2, 11.2); g.beginPath(); g.arc(p.x - 6.3, p.y - 6.3, 0.35, 0, 7); g.fill(); txt('U1', p.x, p.y - 6.6, 1); }
      else if (p.kind === 'header') { g.strokeRect(p.x - 2.6, p.y - 6.4, 5.2, 12.8); txt('J1 JTAG', p.x, p.y - 7.5, 0.9); }
      else if (p.kind === 'usb') txt('J2', p.x + 3.7, p.y - 3.4, 1);
      else if (p.kind === 'ldo') txt('U2 3V3', p.x, p.y - 4.9, 0.9);
      else if (p.kind === 'osc') txt('Y1 25MHz', p.x, p.y - 2.3, 0.8);
    }
    txt('pwm_led carrier', 41, 34.4, 1.5, 700);
    txt('ECP5 · 8× breathing LED · rev A', 41, 36.0, 0.8, 500);
    txt('LED[7:0]', 28, 33.8, 0.9, 600);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    return tex;
  })();
  const silk = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: silkTex, transparent: true, roughness: 0.6, depthWrite: false }));
  silk.rotation.x = -Math.PI / 2; silk.position.y = T + 0.004; silk.receiveShadow = true; root.add(silk);

  // ---------- copper traces (instanced segments + round joints), real Freerouting output ----------
  const segs = [], joints = [];
  for (const w of data.wires) {
    const y = w.layer === 'F.Cu' ? T + 0.02 : -0.02;
    w.pts.forEach((p, i) => {
      joints.push([X(p[0]), y, Z(p[1]), w.w]);
      if (i) { const q = w.pts[i - 1]; segs.push([X(q[0]), Z(q[1]), X(p[0]), Z(p[1]), y, w.w]); }
    });
  }
  const segMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat.gold, segs.length);
  const jointMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), mat.gold, joints.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  segs.forEach(([x0, z0, x1, z1, y, w], i) => {
    const L = Math.hypot(x1 - x0, z1 - z0);
    q.setFromAxisAngle(up, -Math.atan2(z1 - z0, x1 - x0));
    m4.compose(new THREE.Vector3((x0 + x1) / 2, y, (z0 + z1) / 2), q, new THREE.Vector3(L, 0.035, w));
    segMesh.setMatrixAt(i, m4);
  });
  joints.forEach(([x, y, z, w], i) => { m4.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(w, 0.035, w)); jointMesh.setMatrixAt(i, m4); });
  segMesh.receiveShadow = jointMesh.receiveShadow = true;
  root.add(segMesh, jointMesh);

  // ---------- pads ----------
  const ringGeo = (r0, r1) => { const g = new THREE.RingGeometry(r0, r1, 32); g.rotateX(-Math.PI / 2); return g; };
  const disc = (rad, m, x, y, z) => { const g = new THREE.CircleGeometry(rad, 24); g.rotateX(-Math.PI / 2); const o = new THREE.Mesh(g, m); o.position.set(x, y, z); return o; };
  for (const p of data.parts) {
    if (p.kind === 'bga') continue; // hidden under the package
    for (const pd of p.pads) {
      const x = X(pd.x), z = Z(pd.y);
      if (pd.drill) {
        for (const y of [T + 0.012, -0.012]) {
          const ring = new THREE.Mesh(ringGeo(pd.drill / 2, (pd.s === 'c' ? pd.d : pd.w) / 2), mat.gold); ring.position.set(x, y, z);
          if (pd.s !== 'c') { ring.geometry = new THREE.BoxGeometry(pd.w, 0.03, pd.h); }
          ring.receiveShadow = true; root.add(ring);
          if (pd.s !== 'c') root.add(disc(pd.drill / 2, mat.drill, x, y + (y > 0 ? 0.02 : -0.02), z));
        }
        const wall = new THREE.Mesh(new THREE.CylinderGeometry(pd.drill / 2, pd.drill / 2, T, 24, 1, true), mat.gold);
        wall.material = mat.gold; wall.position.set(x, T / 2, z); root.add(wall);
      } else {
        const m = pd.s === 'c' ? new THREE.Mesh(new THREE.CylinderGeometry(pd.d / 2, pd.d / 2, 0.04, 20), mat.gold)
          : new THREE.Mesh(new THREE.BoxGeometry(pd.w, 0.04, pd.h), mat.gold);
        m.position.set(x, T + 0.02, z); m.receiveShadow = true; root.add(m);
      }
    }
  }
  // vias
  for (const v of data.vias) for (const y of [T + 0.012, -0.012]) {
    const ring = new THREE.Mesh(ringGeo(0.15, v.d / 2), mat.gold); ring.position.set(X(v.x), y, Z(v.y)); root.add(ring);
    root.add(disc(0.15, mat.drill, X(v.x), y + (y > 0 ? 0.002 : -0.002), Z(v.y)));
  }

  // ---------- components ----------
  const label = (lines, w, h, opts = {}) => {
    const c = document.createElement('canvas'); c.width = Math.round(w * 64); c.height = Math.round(h * 64);
    const g = c.getContext('2d'); g.fillStyle = opts.bg || '#17181b'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = opts.ink || '#8f939b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach(([s, size, weight, y]) => { g.font = `${weight} ${size * 64}px "Geist", system-ui, sans-serif`; g.fillText(s, c.width / 2, y * 64); });
    if (opts.dot) { g.beginPath(); g.arc(opts.dot[0] * 64, opts.dot[1] * 64, 0.35 * 64, 0, 7); g.fillStyle = '#0b0c0e'; g.fill(); g.strokeStyle = '#2a2c31'; g.lineWidth = 4; g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  };
  const leds = [];
  // soft green halo so the breathing reads at product-shot distance (normal blending: visible on white)
  const haloTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(0.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  for (const p of data.parts) {
    const x = X(p.x), z = Z(p.y);
    if (p.kind === 'bga') {
      // ECP5 CABGA: substrate + ball row peeking out + mold cap with laser marking
      root.add(box(10, 0.36, 10, mat.substrate, x, T + 0.42, z));
      const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 12, 8), mat.tin, p.pads.length);
      p.pads.forEach((pd, i) => { m4.makeTranslation(X(pd.x), T + 0.2, Z(pd.y)); balls.setMatrixAt(i, m4); });
      root.add(balls);
      const cap = new THREE.Shape(); const s = 4.55, rr = 0.35;
      cap.moveTo(-s + rr, -s); cap.lineTo(s - rr, -s); cap.quadraticCurveTo(s, -s, s, -s + rr); cap.lineTo(s, s - rr); cap.quadraticCurveTo(s, s, s - rr, s);
      cap.lineTo(-s + rr, s); cap.quadraticCurveTo(-s, s, -s, s - rr); cap.lineTo(-s, -s + rr); cap.quadraticCurveTo(-s, -s, -s + rr, -s);
      const cg = new THREE.ExtrudeGeometry(cap, { depth: 0.7, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 3 });
      cg.rotateX(-Math.PI / 2);
      const mold = shadowy(new THREE.Mesh(cg, mat.black)); mold.position.set(x, T + 0.6 + 0.12, z); root.add(mold);
      const top = new THREE.Mesh(new THREE.PlaneGeometry(9.1, 9.1), new THREE.MeshStandardMaterial({
        map: label([['LATTICE', 0.95, 800, 2.1], ['ECP5', 1.6, 700, 3.9], ['LFE5U-85F', 0.9, 600, 5.6], ['-6BG381C', 0.75, 500, 6.7], ['2643 A  ·  CHN', 0.6, 500, 7.9]], 9.1, 9.1, { dot: [1.05, 1.05] }),
        roughness: 0.62 }));
      top.rotation.x = -Math.PI / 2; top.position.set(x, T + 0.6 + 0.7 + 0.245, z); root.add(top);
    } else if (p.kind === 'osc') {
      root.add(box(3.2, 0.35, 2.5, mat.ceramic, x, T + 0.2, z));
      root.add(box(2.95, 0.55, 2.25, mat.tin, x, T + 0.65, z));
      const top = new THREE.Mesh(new THREE.PlaneGeometry(2.95, 2.25), new THREE.MeshStandardMaterial({ map: label([['25.000', 0.62, 700, 0.95], ['SIT 25M', 0.42, 600, 1.55]], 2.95, 2.25, { bg: '#c9cdd3', ink: '#6f747c' }), metalness: 0.9, roughness: 0.35 }));
      top.rotation.x = -Math.PI / 2; top.position.set(x, T + 0.93, z); root.add(top);
    } else if (p.kind === 'res') {
      root.add(box(0.5, 0.33, 0.62, mat.black, x, T + 0.2, z));
      for (const s of [-1, 1]) root.add(box(0.5, 0.35, 0.2, mat.tin, x, T + 0.2, z + s * 0.4));
    } else if (p.kind === 'cap') {
      root.add(box(0.62, 0.48, 0.5, mat.capBody, x, T + 0.27, z));
      for (const s of [-1, 1]) root.add(box(0.2, 0.5, 0.5, mat.tin, x + s * 0.4, T + 0.27, z));
    } else if (p.kind === 'led') {
      root.add(box(0.8, 0.3, 1.6, mat.ledBase, x, T + 0.17, z));
      for (const s of [-1, 1]) root.add(box(0.8, 0.31, 0.25, mat.tin, x, T + 0.17, z + s * 0.72));
      const lensMat = new THREE.MeshStandardMaterial({ color: 0x0f2b1c, emissive: 0x46ff9a, emissiveIntensity: 0, roughness: 0.15, transparent: true, opacity: 0.94 });
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.26, 1.06), lensMat); lens.position.set(x, T + 0.45, z); root.add(lens);
      const light = new THREE.PointLight(0x46ff9a, 0, 5, 2); light.position.set(x, T + 1.1, z); root.add(light);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0x22c55e, transparent: true, opacity: 0, depthWrite: false }));
      halo.scale.set(3.4, 3.4, 1); halo.position.set(x, T + 0.7, z); root.add(halo);
      leds.push({ lensMat, light, halo, i: +p.ref.slice(1) - 1 });
    } else if (p.kind === 'header') {
      root.add(box(5.08, 2.5, 12.7, mat.plastic, x, T + 1.25, z));
      const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 11.3, 0.64), mat.gold, p.pads.length);
      p.pads.forEach((pd, i) => { m4.makeTranslation(X(pd.x), T + 2.5 + 5.8 - 11.3 / 2, Z(pd.y)); pins.setMatrixAt(i, m4); });
      pins.castShadow = true; root.add(pins);
    } else if (p.kind === 'usb') {
      root.add(box(5.2, 2.6, 7.6, mat.tin, x - 0.9, T + 1.3, z));
      root.add(box(0.3, 1.5, 6.1, mat.drill, x - 0.9 - 2.5, T + 1.35, z));
      root.add(box(0.12, 0.5, 4.4, mat.black, x - 0.9 - 2.45, T + 1.35, z));
    } else if (p.kind === 'ldo') {
      root.add(box(6.5, 1.6, 3.5, mat.black, x, T + 0.95, z));
      root.add(box(3.0, 0.25, 2.2, mat.tin, x, T + 0.15, Z(p.y - 2.6)));
      for (const dx of [-2.3, 0, 2.3]) root.add(box(0.7, 0.25, 1.5, mat.tin, X(p.x + dx), T + 0.15, Z(p.y + 2.5)));
      const top = new THREE.Mesh(new THREE.PlaneGeometry(6.3, 3.3), new THREE.MeshStandardMaterial({ map: label([['AMS1117', 0.9, 700, 1.25], ['3.3  2614', 0.65, 600, 2.3]], 6.3, 3.3), roughness: 0.6 }));
      top.rotation.x = -Math.PI / 2; top.position.set(x, T + 1.76, z); root.add(top);
    }
  }

  // ---------- floor ----------
  // soft studio floor: key-light shadow on an invisible catcher + a blurred contact shadow under the board
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.13 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.7; floor.receiveShadow = true; scene.add(floor);
  const contact = (() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * (H + 14) / (W + 14));
    const g = c.getContext('2d'); g.filter = 'blur(18px)'; g.fillStyle = 'rgba(15,23,42,.55)';
    const k = c.width / (W + 14); g.beginPath(); g.roundRect(7 * k, 7 * k, W * k, H * k, 2 * k); g.fill();
    const t = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W + 14, H + 14), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.55 }));
    m.rotation.x = -Math.PI / 2; m.position.y = -1.68; return m;
  })();
  scene.add(contact);

  // ---------- post ----------
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.12, 1.0);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  // ---------- camera rig ----------
  const fov = camera.fov * Math.PI / 180;
  let cw = 1, ch = 1, fitR = 80, raf = 0, last = 0, running = false;
  const rig = { f: 0, flyT0: 0, flyDur: 1, orbitT: 0, target: new THREE.Vector3(0, T, 0), d: 0, d0: 0, d1: 0, dT0: 0, dDur: 1 };
  const ledC = new THREE.Vector3(X(28), T, Z(30.5));
  const pwm = new PwmLed();
  let fillPx = null, padX = 0;      // board height in px of the 2D view, so the top-down shot lines up with it

  function resize() {
    const r = host.getBoundingClientRect(); cw = Math.max(1, r.width); ch = Math.max(1, r.height);
    renderer.setSize(cw, ch, false); composer.setSize(cw, ch); bloom.resolution.set(cw, ch);
    camera.aspect = cw / ch; camera.updateProjectionMatrix();
    const boardPx = fillPx ?? Math.min(ch * 0.86, (cw * 0.86) * H / W);
    fitR = (H * ch / boardPx) / (2 * Math.tan(fov / 2));
  }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();

  const easeIO = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function placeCamera(dt) {
    const f = easeIO(rig.f);
    if (rig.f >= 1) rig.orbitT += dt;
    const phi = 0.0001 + f * (55 * Math.PI / 180) + (rig.f >= 1 ? Math.sin(rig.orbitT * 0.35) * 0.05 : 0);
    const theta = f * -0.62 + Math.sin(rig.orbitT * 0.16) * 0.42;   // gentle turntable sway
    const wFrac = cw > 0 ? Math.max(0.5, (cw - 2 * padX) / cw) : 1;
    const radEnd = Math.max(1.3 * H, 1.12 * W / wFrac / camera.aspect) / (2 * Math.tan(fov / 2));   // product-shot framing from the full view height
    const rad = (fitR + f * (radEnd - fitR)) * (1 - 0.5 * rig.d);
    if (rig.dT0) { const k = Math.min(1, (performance.now() - rig.dT0) / rig.dDur); rig.d = rig.d0 + (rig.d1 - rig.d0) * easeIO(k); }
    const tgt = new THREE.Vector3(0, T + f * -0.6, f * 1.2).lerp(ledC, rig.d);
    camera.position.set(tgt.x + rad * Math.sin(phi) * Math.sin(theta), tgt.y + rad * Math.cos(phi), tgt.z + rad * Math.sin(phi) * Math.cos(theta));
    camera.up.set(-Math.cos(phi) * Math.sin(theta), Math.sin(phi), -Math.cos(phi) * Math.cos(theta));
    camera.lookAt(tgt);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0); last = now;
    if (rig.flyT0) rig.f = Math.min(1, (now - rig.flyT0) / rig.flyDur);
    pwm.advance(dt * (opts.speed?.() ?? 1));
    const lvl = pwm.level(0);  // identical for all 8 LEDs (see PwmLed.level)
    for (const l of leds) {
      const v = pwm.level(l.i);
      l.lensMat.emissiveIntensity = 0.1 + v * 4.5;
      l.halo.material.opacity = v * 0.85;
      l.light.intensity = v * 1.6;
    }
    placeCamera(dt * (opts.speed?.() ?? 1));
    composer.render();
    opts.onFrame?.(pwm, lvl);
  }

  return {
    pwm,
    setFill(px, pad = 0) { fillPx = px; padX = pad; resize(); },
    start() { if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); } },
    stop() { running = false; cancelAnimationFrame(raf); },
    flyIn(ms) { rig.flyDur = ms; rig.flyT0 = performance.now(); },
    /** push the camera toward the LED row (d = 0..1) */
    dolly(d, ms) { rig.d0 = rig.d; rig.d1 = d; rig.dDur = ms; rig.dT0 = performance.now(); },
    renderOnce() { placeCamera(0); composer.render(); },
    dispose() {
      running = false; cancelAnimationFrame(raf); ro.disconnect();
      scene.traverse(o => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach(mm => { mm.map?.dispose?.(); mm.dispose?.(); }); });
      envRT.dispose(); pmrem.dispose(); rt.dispose(); composer.dispose?.();
      renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove();
    },
  };
}
