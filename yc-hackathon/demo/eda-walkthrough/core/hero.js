// Intro hero: a low-poly 3D model of our ULX3S-style board with 8 LEDs breathing on the same
// phase-shifted PWM logic as real/rtl/pwm_led.v. Soft studio lighting on white, contact shadows.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function mountHero(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(8.6, 8.8, 11.4);
  camera.lookAt(0, -0.2, 0);

  // lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3ea, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 9, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 6; key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdbe6ff, 0.6); rim.position.set(-6, 4, -5); scene.add(rim);

  // shadow catcher
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.13 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.62; ground.receiveShadow = true;
  scene.add(ground);

  const board = new THREE.Group();
  scene.add(board);

  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });
  const M = {
    pcb: mat(0x2f6b3a, { roughness: 0.7 }), pcbEdge: mat(0x24542d, { roughness: 0.8 }),
    gold: mat(0xd9a933, { metalness: 0.85, roughness: 0.32 }),
    chip: mat(0x3b4048, { roughness: 0.45 }), chipTop: mat(0x464c55, { roughness: 0.35 }),
    grey: mat(0xb9bec6, { roughness: 0.4 }), greyDark: mat(0x8d939c, { roughness: 0.45 }),
    black: mat(0x24272c, { roughness: 0.5 }), white: mat(0xf2f2f0, { roughness: 0.5 }),
    pin: mat(0xe9edf2, { metalness: 0.6, roughness: 0.3 }),
  };
  const add = (geo, m, x, y, z, parent = board) => {
    const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  const box = (w, h, d, m, x, y, z, parent) => add(new THREE.BoxGeometry(w, h, d), m, x, y, z, parent);

  // PCB: chamfered square, extruded with a bevel
  const W = 7, D = 7, c = 0.7, T = 0.28;
  const s = new THREE.Shape();
  s.moveTo(-W / 2 + c, -D / 2); s.lineTo(W / 2 - c, -D / 2); s.lineTo(W / 2, -D / 2 + c); s.lineTo(W / 2, D / 2 - c);
  s.lineTo(W / 2 - c, D / 2); s.lineTo(-W / 2 + c, D / 2); s.lineTo(-W / 2, D / 2 - c); s.lineTo(-W / 2, -D / 2 + c); s.closePath();
  const pcbGeo = new THREE.ExtrudeGeometry(s, { depth: T, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
  pcbGeo.rotateX(-Math.PI / 2); pcbGeo.translate(0, -T, 0);
  const pcb = add(pcbGeo, [M.pcb, M.pcbEdge], 0, 0, 0);
  const top = 0.045; // surface height

  // gold traces (Manhattan), drawn as thin flat bars
  const trace = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const m = box(len + 0.09, 0.012, 0.09, M.gold, (x1 + x2) / 2, top, (z1 + z2) / 2);
      m.rotation.y = -Math.atan2(z2 - z1, x2 - x1); m.castShadow = false;
    }
  };
  // chip fan-out
  [[-0.9, -0.2, -2.0, -1.3], [-0.9, 0.3, -2.3, 0.3], [-0.9, 0.8, -1.9, 1.7], [0.9, -0.6, 2.0, -1.6], [0.9, 0.2, 2.1, 0.2],
   [0.9, 0.7, 1.6, 1.6], [0, -1.1, -0.4, -2.3], [0.3, 1.1, 0.3, 2.2]].forEach(([a, b, cx, cz]) => trace([[a, b], [cx, b], [cx, cz]]));
  // LED bus
  for (let i = 0; i < 8; i++) { const x = -2.45 + i * 0.7; trace([[x, 2.55], [x, 2.15], [Math.max(-0.6, Math.min(0.6, x * 0.25)), 1.25]]); }

  // ECP5 BGA in the centre
  const chip = new THREE.Group(); board.add(chip);
  box(1.9, 0.26, 1.9, M.chip, 0, top + 0.13, 0, chip);
  box(1.6, 0.03, 1.6, M.chipTop, 0, top + 0.275, 0, chip);
  // gull-wing style pins for a readable silhouette (like the reference)
  for (let i = 0; i < 7; i++) {
    const o = -0.72 + i * 0.24;
    [[o, 1.02], [o, -1.02]].forEach(([x, z]) => box(0.09, 0.05, 0.18, M.pin, x, top + 0.04, z, chip));
    [[1.02, o], [-1.02, o]].forEach(([x, z]) => box(0.18, 0.05, 0.09, M.pin, x, top + 0.04, z, chip));
  }
  // pin-1 dot + label texture
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#464c55'; g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#9aa1ab'; g.font = '600 64px Geist, Inter, sans-serif'; g.textAlign = 'center';
  g.fillText('LATTICE', 256, 230); g.font = '500 46px "Geist Mono", monospace'; g.fillText('ECP5-85F', 256, 300);
  g.beginPath(); g.arc(70, 70, 22, 0, 7); g.fillStyle = '#5a616b'; g.fill();
  const label = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 1.58), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), roughness: 0.4 }));
  label.material.map.colorSpace = THREE.SRGBColorSpace;
  label.rotation.x = -Math.PI / 2; label.position.y = top + 0.292; chip.add(label);

  // passives, oscillator, USB, header, flash
  [[-2.2, -1.3], [-2.6, -1.3], [2.1, -1.6], [2.5, -1.6], [-1.9, 1.7], [1.6, 1.6]].forEach(([x, z]) => {
    box(0.34, 0.16, 0.2, M.greyDark, x, top + 0.08, z); box(0.08, 0.17, 0.21, M.gold, x - 0.15, top + 0.085, z); box(0.08, 0.17, 0.21, M.gold, x + 0.15, top + 0.085, z);
  });
  box(0.7, 0.26, 0.55, M.grey, -2.3, top + 0.13, 0.3); // 25 MHz oscillator
  box(0.62, 0.05, 0.47, M.greyDark, -2.3, top + 0.285, 0.3);
  box(1.0, 0.16, 0.55, M.black, 2.2, top + 0.08, 0.2); // SPI flash
  box(1.4, 0.55, 0.95, M.grey, 0.3, top + 0.28, -2.75); // USB connector
  box(1.2, 0.36, 0.06, M.greyDark, 0.3, top + 0.3, -3.23);
  box(0.5, 0.36, 1.9, M.black, 2.85, top + 0.18, 1.8); // header
  for (let i = 0; i < 4; i++) {
    const pin = box(0.08, 0.7, 0.08, M.gold, 2.85, top + 0.5, 1.15 + i * 0.43);
    const leg = box(0.6, 0.08, 0.08, M.gold, 2.85 + 0.25, top + 0.86, 1.15 + i * 0.43); leg.rotation.z = 0.0;
  }
  // mounting holes
  const ring = new THREE.TorusGeometry(0.22, 0.08, 12, 32); ring.rotateX(Math.PI / 2);
  [[-2.85, -2.85], [2.85, -2.85], [-2.85, 2.85], [2.85, 2.85]].forEach(([x, z]) => {
    add(ring, M.gold, x, top + 0.02, z);
    add(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 24), mat(0x1c3d22), x, top + 0.005, z);
  });

  // 8 LEDs with resistors: emissive, driven by the PWM model
  const leds = [];
  for (let i = 0; i < 8; i++) {
    const x = -2.45 + i * 0.7, z = 2.75;
    box(0.36, 0.12, 0.2, M.white, x, top + 0.06, z + 0.32);
    const lm = new THREE.MeshStandardMaterial({ color: 0x7fd1ff, emissive: 0x2a8bff, emissiveIntensity: 0, roughness: 0.15, transparent: true, opacity: 0.92 });
    const led = box(0.34, 0.2, 0.34, lm, x, top + 0.1, z - 0.08);
    const glow = new THREE.PointLight(0x3b8cff, 0, 1.4, 2); glow.position.set(x, top + 0.35, z - 0.08); board.add(glow);
    leds.push({ lm, glow });
  }

  board.rotation.y = -0.5;

  // ---- animation ----
  let raf = 0, t0 = performance.now(), duty = 0, dir = 1, mx = 0, my = 0, tx = 0, ty = 0, intro = 0;
  const onMove = (e) => { const r = container.getBoundingClientRect(); tx = ((e.clientX - r.left) / r.width - 0.5); ty = ((e.clientY - r.top) / r.height - 0.5); };
  addEventListener('pointermove', onMove);
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  const loop = (now) => {
    const t = (now - t0) / 1000;
    intro = Math.min(1, intro + 0.012);
    const e = 1 - Math.pow(1 - intro, 4);
    board.position.y = (1 - e) * -1.2 + Math.sin(t * 0.9) * 0.05;
    board.rotation.y = -0.5 + (1 - e) * 0.9 + Math.sin(t * 0.25) * 0.12;
    mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
    board.rotation.x = my * 0.12; board.rotation.z = -mx * 0.08;
    // same breathing as the RTL: duty ramps 0..255..0; LED i on-fraction over one PWM period
    duty += dir * 2.4; if (duty >= 255) { duty = 255; dir = -1; } if (duty <= 0) { duty = 0; dir = 1; }
    leds.forEach((l, i) => {
      let on = 0; for (let k = 0; k < 256; k += 8) on += ((k + 32 * i) & 255) < duty ? 1 : 0;
      const b = (on / 32) * e;
      l.lm.emissiveIntensity = b * 2.4; l.glow.intensity = b * 1.6;
    });
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => { cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('pointermove', onMove); renderer.dispose(); pmrem.dispose(); renderer.domElement.remove(); };
}
