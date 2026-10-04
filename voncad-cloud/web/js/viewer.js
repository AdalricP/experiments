// Voncad Cloud — CAD viewer.
// Reusable ES module: `new Viewer(container, opts)` draws a voncad-scene v1 (see server/tessellate.py)
// with crisp B-rep edges, GPU id-picking of faces/edges, section, explode, measure, a view cube and
// stable topology ids ("p0/f3") that humans can point at and agents can read.
//
// Also exports small DOM components shared by the studio and the share viewer:
//   mountToolbar(viewer, el, items), PartTree(viewer, el), SelectionPanel(viewer, el), ICONS.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const ACCENT = 0xff5b1f;        // selection — international orange
const AGENT = 0x2f6bff;         // highlight(ids) — what an agent is pointing at
const INK = 0x1a1a1a;

const VIEWS = {
  iso: [1, -1, 0.82],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, 1e-4, -1],
};
const VIEW_KEYS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
export const RENDER_MODES = [
  ['shaded-edges', 'Shaded + edges'],
  ['shaded', 'Shaded'],
  ['hidden', 'Hidden line'],
  ['wireframe', 'Wireframe'],
  ['xray', 'X-ray'],
];

// ---------------------------------------------------------------- helpers

function b64ToArrayBuffer(s) {
  if (!s) return new ArrayBuffer(0);
  const bin = atob(s);
  const n = bin.length;
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
const f32 = (s) => new Float32Array(b64ToArrayBuffer(s));
const u32 = (s) => new Uint32Array(b64ToArrayBuffer(s));
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function fmt(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) < 0.5 * 10 ** -d) n = 0;
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return n.toExponential(2);
  return (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
export const fmtVec = (v, d = 2) => (v ? `${fmt(v[0], d)}, ${fmt(v[1], d)}, ${fmt(v[2], d)}` : '—');

function slerpDir(a, b, t, out) {
  const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const th = Math.acos(d);
  if (th < 1e-4) return out.copy(a).lerp(b, t).normalize();
  if (Math.PI - th < 1e-3) {   // opposite: go round via a perpendicular
    const p = Math.abs(a.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const mid = p.sub(a.clone().multiplyScalar(p.dot(a))).normalize();
    return t < 0.5 ? slerpDir(a, mid, t * 2, out) : slerpDir(mid, b, t * 2 - 1, out);
  }
  const s = Math.sin(th);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * th) / s).addScaledVector(b, Math.sin(t * th) / s).normalize();
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// ---------------------------------------------------------------- shaders

const PICK_VS = /* glsl */`
#include <common>
#include <clipping_planes_pars_vertex>
attribute float pickId;
varying float vPick;
void main() {
  vPick = pickId;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;
const ENCODE = /* glsl */`
vec4 vcEncode(float id) {
  id = floor(id + 0.5);
  return vec4(mod(floor(id / 65536.0), 256.0), mod(floor(id / 256.0), 256.0), mod(id, 256.0), 255.0) / 255.0;
}`;
const PICK_FS = /* glsl */`
#include <clipping_planes_pars_fragment>
varying float vPick;
${ENCODE}
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vcEncode(vPick);
}`;

const GRID_VS = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GRID_FS = /* glsl */`
uniform float uCell;
uniform vec3 uCenter;
uniform float uFade;
uniform float uOpacity;
varying vec3 vWorld;
float gridLine(vec2 p, float s, out float lod) {
  vec2 c = p / s;
  vec2 fw = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / fw;
  lod = clamp(max(fw.x, fw.y) * 3.0 - 0.5, 0.0, 1.0);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float d = distance(vWorld.xy, uCenter.xy);
  float fade = 1.0 - smoothstep(uFade * 0.15, uFade, d);
  fade *= fade;
  float l1, l2;
  float minor = gridLine(vWorld.xy, uCell, l1) * (1.0 - l1);
  float major = gridLine(vWorld.xy, uCell * 10.0, l2) * (1.0 - l2 * 0.7);
  vec2 aw = fwidth(vWorld.xy) * 1.2;
  float ax = 1.0 - min(abs(vWorld.y) / aw.y, 1.0);
  float ay = 1.0 - min(abs(vWorld.x) / aw.x, 1.0);
  float a = max(minor * 0.16, major * 0.34);
  vec3 col = vec3(0.07);
  if (ax > 0.01) { col = mix(col, vec3(0.82, 0.25, 0.2), ax); a = max(a, ax * 0.9); }
  if (ay > 0.01) { col = mix(col, vec3(0.25, 0.6, 0.3), ay); a = max(a, ay * 0.9); }
  a *= uOpacity * fade;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

const BLUR_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BLUR_FS = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 s = vec4(0.0);
  s += texture2D(tDiffuse, vUv - 4.0 * uDir) * 0.051;
  s += texture2D(tDiffuse, vUv - 3.0 * uDir) * 0.0918;
  s += texture2D(tDiffuse, vUv - 2.0 * uDir) * 0.12245;
  s += texture2D(tDiffuse, vUv - 1.0 * uDir) * 0.1531;
  s += texture2D(tDiffuse, vUv) * 0.1633;
  s += texture2D(tDiffuse, vUv + 1.0 * uDir) * 0.1531;
  s += texture2D(tDiffuse, vUv + 2.0 * uDir) * 0.12245;
  s += texture2D(tDiffuse, vUv + 3.0 * uDir) * 0.0918;
  s += texture2D(tDiffuse, vUv + 4.0 * uDir) * 0.051;
  gl_FragColor = s;
}`;

// ---------------------------------------------------------------- Viewer

export class Viewer extends EventTarget {
  constructor(container, opts = {}) {
    super();
    this.container = container;
    this.opts = Object.assign({ cube: true, grid: true, shadow: true, ao: false, shortcuts: true, measureProvider: null, interactive: true }, opts);
    container.classList.add('vc-viewer');
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.state = {
      renderMode: 'shaded-edges', projection: 'perspective', tool: 'select', filter: 'auto',
      section: { enabled: false, axis: 'x', normal: [1, 0, 0], offset: 0.5, flip: false },
      explode: 0, bbox: false, grid: this.opts.grid, shadow: this.opts.shadow, ao: false,
    };
    this.selection = [];
    this.highlighted = [];
    this.hoverId = null;
    this.measurePicks = [];
    this.measureResult = null;
    this.parts = [];
    this.sceneData = null;
    this.versionId = null;
    this._dirty = true;
    this._labels = [];
    this._disposed = false;

    this._initRenderer();
    this._initScene();
    if (this.opts.cube) this._initCube();
    this._initOverlay();
    this._initEvents();
    if (this.opts.shortcuts) this._initShortcuts();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
    if (this.opts.ao) this.setAO(true);
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------ setup

  _initRenderer() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !!this.opts.transparent, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (this.opts.transparent) r.setClearColor(0x000000, 0);
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.localClippingEnabled = true;
    r.domElement.className = 'vc-canvas';
    r.domElement.setAttribute('tabindex', '0');
    this.container.appendChild(r.domElement);
    const gl = r.getContext();
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      this.softwareGL = /swiftshader|llvmpipe|software/i.test(name);
    } catch (e) { this.softwareGL = false; }
    this.pickRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    this._pickBuf = new Uint8Array(4);
  }

  _initScene() {
    const scene = this.scene = new THREE.Scene();
    // Soft vertical paper gradient behind the model
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, '#fdfdfc'); grd.addColorStop(0.6, '#f6f6f4'); grd.addColorStop(1, '#ededea');
    g.fillStyle = grd; g.fillRect(0, 0, 4, 512);
    this._bgTex = new THREE.CanvasTexture(c);
    this._bgTex.colorSpace = THREE.SRGBColorSpace;
    scene.background = this.opts.transparent ? null : this._bgTex;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this._envRT = pmrem.fromScene(room, 0.035);
    room.dispose?.();
    pmrem.dispose();
    scene.environment = this._envRT.texture;
    scene.environmentIntensity = 0.95;
    scene.environmentRotation = new THREE.Euler(Math.PI / 2, 0, 0);  // env authored Y-up; we are Z-up

    // camera-relative key light for crisp definition
    this.lightRig = new THREE.Group();
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(-0.6, 0.9, 1);
    const tgt = new THREE.Object3D(); tgt.position.set(0, 0, -1);
    key.target = tgt;
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(0.8, -0.4, 0.6); fill.target = tgt;
    this.lightRig.add(key, fill, tgt);
    scene.add(this.lightRig);

    this.perspCam = new THREE.PerspectiveCamera(32, 1, 0.1, 10000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
    this.perspCam.position.set(200, -200, 160);
    this.camera = this.perspCam;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 1.1;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => { this._dirty = true; });
    this.controls.addEventListener('start', () => { this._anim = null; this._hideTip(); this.setAutoRotate(false); });
    if (this.opts.autoRotate) this.setAutoRotate(true);

    this.root = new THREE.Group();          // parts
    this.helpers = new THREE.Group();       // measure / bbox / section outline
    this.ghostRoot = new THREE.Group();
    scene.add(this.root, this.ghostRoot, this.helpers);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.clipPlanes = [];

    // materials shared across parts
    this.pickMat = new THREE.ShaderMaterial({ vertexShader: PICK_VS, fragmentShader: PICK_FS, clipping: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.pickLineMat = new LineMaterial({ linewidth: 11, worldUnits: false });
    this.pickLineMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute float instanceEdgeId;\nvarying float vPickId;\nvoid main() {\n\tvPickId = instanceEdgeId;');
      let fs = sh.fragmentShader.replace('void main() {', `varying float vPickId;\n${ENCODE}\nvoid main() {`);
      const i = fs.lastIndexOf('}');
      sh.fragmentShader = fs.slice(0, i) + '\n\tgl_FragColor = vcEncode(vPickId);\n}';
    };
    this.pickLineMat.customProgramCacheKey = () => 'vc-pick-line';
    this.depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.overlayMats = {
      select: new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, depthWrite: false }),
      hover: new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.28, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, depthWrite: false }),
      agent: new THREE.MeshStandardMaterial({ color: AGENT, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, depthWrite: false }),
    };
    this.overlayLineMats = {
      select: new LineMaterial({ color: ACCENT, linewidth: 3.2, worldUnits: false }),
      hover: new LineMaterial({ color: ACCENT, linewidth: 2.6, worldUnits: false, transparent: true, opacity: 0.7 }),
      agent: new LineMaterial({ color: AGENT, linewidth: 3.2, worldUnits: false }),
      measure: new LineMaterial({ color: INK, linewidth: 1.4, worldUnits: false, depthTest: false, transparent: true }),
    };
    for (const m of [this.pickMat, this.depthOnlyMat, ...Object.values(this.overlayMats)]) m.clippingPlanes = this.clipPlanes;
    for (const m of [this.pickLineMat, ...Object.values(this.overlayLineMats)]) m.clippingPlanes = m === this.overlayLineMats.measure ? [] : this.clipPlanes;
    this._lineMats = new Set([this.pickLineMat, ...Object.values(this.overlayLineMats)]);

    // infinite fading grid
    this.gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VS, fragmentShader: GRID_FS, transparent: true, depthWrite: false,
      uniforms: { uCell: { value: 10 }, uCenter: { value: new THREE.Vector3() }, uFade: { value: 1000 }, uOpacity: { value: 1 } },
      extensions: { derivatives: true },
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -2;
    this.grid.userData.helper = true;
    scene.add(this.grid);

    this._initContactShadow();
    this._initSectionHelper();
  }

  _initContactShadow() {
    // Two layers: a tight contact shadow (what touches the ground) + a broad ambient one (footprint).
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: BLUR_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false, uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } } });
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.fsQuad.frustumCulled = false;
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.shadowPlane = new THREE.Group();
    this.shadowPlane.userData.helper = true;
    this.shadowLayers = [
      { size: 512, reach: 0.06, exp: 1.4, dark: 1.5, blur: [1.2, 0.6], opacity: 0.62 },
      { size: 256, reach: 0.9, exp: 1.0, dark: 1.0, blur: [3.0, 1.6, 0.8], opacity: 0.26 },
    ].map((L) => {
      L.rt = new THREE.WebGLRenderTarget(L.size, L.size); L.rt.texture.generateMipmaps = false;
      L.rtBlur = new THREE.WebGLRenderTarget(L.size, L.size); L.rtBlur.texture.generateMipmaps = false;
      L.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      L.cam.layers.set(1);
      const m = L.mat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
      m.clippingPlanes = this.clipPlanes;
      m.depthTest = false; m.depthWrite = false;
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          `gl_FragColor = vec4( vec3( 0.0 ), pow(clamp(1.0 - fragCoordZ, 0.0, 1.0), ${L.exp.toFixed(2)}) * ${L.dark.toFixed(2)} );`);
      };
      m.customProgramCacheKey = () => 'vc-shadow-' + L.exp + '-' + L.dark;
      L.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: L.rt.texture, transparent: true, depthWrite: false, opacity: L.opacity, side: THREE.DoubleSide, toneMapped: false }));
      L.plane.renderOrder = -1;
      this.shadowPlane.add(L.plane);
      return L;
    });
    this.scene.add(this.shadowPlane);
    this._shadowDirty = true;
  }

  _initSectionHelper() {
    const g = new THREE.PlaneGeometry(1, 1);
    this.sectionFill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.025, depthWrite: false, side: THREE.DoubleSide }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55 }));
    this.sectionHelper = new THREE.Group();
    this.sectionHelper.add(this.sectionFill, edges);
    this.sectionHelper.visible = false;
    this.sectionHelper.userData.helper = true;
    this.scene.add(this.sectionHelper);
  }

  _initCube() {
    const cs = this.cube = { size: 112, margin: 10, scene: new THREE.Scene(), regions: [], hover: null };
    cs.camera = new THREE.OrthographicCamera(-2.05, 2.05, 2.05, -2.05, 0.1, 20);
    const group = cs.group = new THREE.Group();
    cs.scene.add(group);
    const b = 0.3;
    const faces = [
      ['FRONT', [0, -1, 0], [1, 0, 0], [0, 0, 1]],
      ['BACK', [0, 1, 0], [-1, 0, 0], [0, 0, 1]],
      ['RIGHT', [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      ['LEFT', [-1, 0, 0], [0, -1, 0], [0, 0, 1]],
      ['TOP', [0, 0, 1], [1, 0, 0], [0, 1, 0]],
      ['BOTTOM', [0, 0, -1], [1, 0, 0], [0, -1, 0]],
    ];
    const regionMat = new Map();
    const base = new THREE.Color(0xfbfbfa);
    cs.textures = [];
    const spans = { '-1': [-1, -1 + b], '0': [-1 + b, 1 - b], '1': [1 - b, 1] };
    for (const [label, n, r, u] of faces) {
      const N = V(n), R = V(r), U = V(u);
      for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) {
        const dir = N.clone().addScaledVector(R, i).addScaledVector(U, j);
        const key = `${Math.round(dir.x)},${Math.round(dir.y)},${Math.round(dir.z)}`;
        const [x0, x1] = spans[i], [y0, y1] = spans[j];
        const geo = new THREE.BufferGeometry();
        const P = (x, y) => N.clone().add(R.clone().multiplyScalar(x)).add(U.clone().multiplyScalar(y));
        const pts = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
        const uv = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [(x - (-1 + b)) / (2 - 2 * b), (y - (-1 + b)) / (2 - 2 * b)]);
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        let mat;
        if (i === 0 && j === 0) {
          const tex = this._cubeLabelTexture(label);
          cs.textures.push([tex, label]);
          mat = new THREE.MeshBasicMaterial({ map: tex, color: base.clone(), toneMapped: false });
        } else {
          if (!regionMat.has(key)) regionMat.set(key, new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(0.965), toneMapped: false }));
          mat = regionMat.get(key);
        }
        const m = new THREE.Mesh(geo, mat);
        m.userData.dir = [Math.round(dir.x), Math.round(dir.y), Math.round(dir.z)];
        m.userData.key = key;
        group.add(m);
        cs.regions.push(m);
      }
    }
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x9a9a9a, toneMapped: false }));
    group.add(box);
    // axis triad from the back-left-bottom corner
    const o = new THREE.Vector3(-1.32, -1.32, -1.32);
    const axes = [[[1, 0, 0], 0xd0453a, 'X'], [[0, 1, 0], 0x3f9a52, 'Y'], [[0, 0, 1], 0x3a66d0, 'Z']];
    for (const [d, col, name] of axes) {
      const end = o.clone().addScaledVector(V(d), 1.25);
      const g = new THREE.BufferGeometry().setFromPoints([o, end]);
      group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, toneMapped: false })));
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._axisTexture(name, col), toneMapped: false, depthTest: false }));
      sp.position.copy(end).addScaledVector(V(d), 0.22);
      sp.scale.setScalar(0.42);
      group.add(sp);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        for (const [tex, label] of cs.textures) { this._drawCubeLabel(tex.image, label); tex.needsUpdate = true; }
        this._dirty = true;
      });
    }
  }

  _cubeLabelTexture(label) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    this._drawCubeLabel(c, label);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  _drawCubeLabel(c, label) {
    const g = c.getContext('2d');
    g.fillStyle = '#fbfbfa'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#2a2a2a';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const size = label.length > 5 ? 38 : 44;
    g.font = `${size}px Michroma, Geist, sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = '2px';
    g.fillText(label, 128, 132);
  }

  _axisTexture(name, col) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#' + col.toString(16).padStart(6, '0');
    g.font = '600 40px Geist, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _initOverlay() {
    const o = this.overlay = el('div', 'vc-overlay');
    this.labelLayer = el('div', 'vc-labels');
    this.tip = el('div', 'vc-tip');
    this.toast = el('div', 'vc-toast');
    o.append(this.labelLayer, this.tip, this.toast);
    this.container.appendChild(o);
    this.helpEl = el('div', 'vc-help', `
      <div class="vc-help-card">
        <div class="vc-help-head"><span>Keyboard</span><button class="vc-x" aria-label="Close">×</button></div>
        <div class="vc-help-grid">
          <kbd>F</kbd><span>Fit to view</span>
          <kbd>1–7</kbd><span>Iso · Front · Back · Left · Right · Top · Bottom</span>
          <kbd>P</kbd><span>Perspective / orthographic</span>
          <kbd>S</kbd><span>Section plane</span>
          <kbd>M</kbd><span>Measure</span>
          <kbd>X</kbd><span>Explode assembly</span>
          <kbd>W</kbd><span>Cycle render mode</span>
          <kbd>B</kbd><span>Bounding box dimensions</span>
          <kbd>Esc</kbd><span>Clear selection</span>
          <kbd>?</kbd><span>This help</span>
        </div>
        <div class="vc-help-head" style="margin-top:18px"><span>Mouse</span></div>
        <div class="vc-help-grid">
          <kbd>Drag</kbd><span>Orbit</span>
          <kbd>Right / middle drag</kbd><span>Pan</span>
          <kbd>Wheel</kbd><span>Zoom to cursor</span>
          <kbd>Click</kbd><span>Select face / edge &nbsp;·&nbsp; Shift adds</span>
          <kbd>Double-click</kbd><span>Set orbit pivot &nbsp;·&nbsp; Alt: look normal to face</span>
        </div>
      </div>`);
    this.helpEl.addEventListener('click', (e) => { if (e.target === this.helpEl || e.target.closest('.vc-x')) this.toggleHelp(false); });
    this.container.appendChild(this.helpEl);
  }

  _initEvents() {
    const dom = this.renderer.domElement;
    this._mouse = { x: 0, y: 0, inside: false };
    let down = null;
    dom.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      if (moved < 5 && dt < 500 && down.button === 0) this._onClick(e);
      down = null;
    });
    dom.addEventListener('pointermove', (e) => {
      const r = dom.getBoundingClientRect();
      this._mouse = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true, buttons: e.buttons, cx: e.clientX, cy: e.clientY };
      if (!e.buttons) this._hoverPending = true;
    });
    dom.addEventListener('pointerleave', () => {
      this._mouse.inside = false;
      this._setHover(null);
      this._cubeHover(null);
    });
    dom.addEventListener('dblclick', (e) => this._onDblClick(e));
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _initShortcuts() {
    this._onKey = (e) => {
      if (this._disposed) return;
      const t = e.target;
      if (t && (t.closest?.('input,textarea,select,[contenteditable="true"],.CodeMirror'))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.container.offsetParent && getComputedStyle(this.container).position !== 'fixed') return;
      const k = e.key;
      let handled = true;
      if (k === 'f' || k === 'F') this.fit();
      else if (k >= '1' && k <= '7') this.setView(VIEW_KEYS[+k - 1]);
      else if (k === '0') this.setView('iso');
      else if (k === 's' || k === 'S') this.setSection({ enabled: !this.state.section.enabled });
      else if (k === 'm' || k === 'M') this.setTool(this.state.tool === 'measure' ? 'select' : 'measure');
      else if (k === 'x' || k === 'X') this.animateExplode(this.state.explode > 0.01 ? 0 : 0.6);
      else if (k === 'w' || k === 'W') {
        const i = RENDER_MODES.findIndex((m) => m[0] === this.state.renderMode);
        this.setRenderMode(RENDER_MODES[(i + 1) % RENDER_MODES.length][0]);
        this.flash(RENDER_MODES[(i + 1) % RENDER_MODES.length][1]);
      } else if (k === 'p' || k === 'P') this.setProjection(this.state.projection === 'perspective' ? 'orthographic' : 'perspective');
      else if (k === 'b' || k === 'B') this.setBBox(!this.state.bbox);
      else if (k === 'Escape') {
        if (this.helpEl.classList.contains('on')) this.toggleHelp(false);
        else if (this.state.tool === 'measure' && this.measurePicks.length) this.clearMeasure();
        else if (this.state.tool !== 'select') this.setTool('select');
        else this.clearSelection();
      } else if (k === '?') this.toggleHelp();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', this._onKey);
  }

  // ------------------------------------------------------------ loading

  async load(src, opts = {}) {
    let data = src;
    if (typeof src === 'string') {
      const res = await fetch(src, { headers: opts.headers || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status} loading scene`);
      data = await res.json();
    }
    this.loadScene(data, opts);
    return data;
  }

  loadScene(data, { keepCamera = false, versionId = null, keepSelection = true } = {}) {
    if (!data || !Array.isArray(data.parts)) throw new Error('not a voncad scene');
    const prevSel = keepSelection ? this.selection.slice() : [];
    const prevHidden = new Set(this.parts.filter((p) => !p.visible).map((p) => p.id));
    const sameShape = keepCamera && this.parts.length === data.parts.length;
    this._clearParts();
    this.sceneData = data;
    this.versionId = versionId;
    this._pickTable = [null];
    let tris = 0;
    const box = new THREE.Box3();
    data.parts.forEach((p, pi) => {
      const part = this._buildPart(p, pi);
      if (sameShape && prevHidden.has(part.id)) this._applyPartVisibility(part, false);
      tris += part.triangles;
      box.union(part.box);
      this.parts.push(part);
      this.root.add(part.group);
    });
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.modelBox = box;
    this.modelCenter = box.getCenter(new THREE.Vector3());
    this.modelSize = box.getSize(new THREE.Vector3());
    this.diag = Math.max(this.modelSize.length(), 1e-3);
    this.triangles = tris;
    this._computeExplodeDirs();
    this._applyExplode();
    this._layoutGround();
    this.setRenderMode(this.state.renderMode, true);
    if (this.state.section.enabled) this._applySection();
    if (!keepCamera) this.fit(false, 'iso');
    else this._updateClipRange();
    this.measurePicks = []; this.measureResult = null; this._drawMeasure();
    this.selection = prevSel.filter((id) => this.getEntity(id));
    this.highlighted = this.highlighted.filter((id) => this.getEntity(id));
    this._refreshOverlays();
    if (this.state.bbox) this._drawBBox();
    this._shadowDirty = true;
    this._dirty = true;
    this.dispatchEvent(new CustomEvent('load', { detail: { scene: data, stats: this.stats() } }));
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { ids: this.selection.slice(), entities: this.selection.map((i) => this.getEntity(i)) } }));
  }

  _buildPart(p, pi) {
    const pos = f32(p.positions), nrm = f32(p.normals), idx = u32(p.indices);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nrm.length === pos.length) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    if (nrm.length !== pos.length) geo.computeVertexNormals();
    const nv = pos.length / 3;
    const pick = new Float32Array(nv);
    const faces = p.faces || [];
    const faceMap = new Map();
    faces.forEach((f, fi) => {
      const gid = this._pickTable.length;
      this._pickTable.push({ part: pi, kind: 'face', index: fi });
      faceMap.set(f.id, f);
      f._gid = gid;
      const s = f.start * 3, e = (f.start + f.count) * 3;
      for (let k = s; k < e; k++) pick[idx[k]] = gid;
    });
    geo.setAttribute('pickId', new THREE.BufferAttribute(pick, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const color = new THREE.Color(p.color || '#d9d7d2');
    const hsl = {}; color.getHSL(hsl);
    const dark = hsl.l < 0.12;
    const mat = new THREE.MeshPhysicalMaterial({
      color, roughness: dark ? 0.42 : 0.5, metalness: dark ? 0.15 : 0.02,
      clearcoat: dark ? 0.35 : 0.22, clearcoatRoughness: 0.45, envMapIntensity: 1.0,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.clipPlanes,
    });
    const xray = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false,
      side: THREE.DoubleSide, clippingPlanes: this.clipPlanes,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.enable(1);
    mesh.userData.part = pi;

    // section cap: back faces seen through the cut, flat + hatched
    const capColor = color.clone().multiplyScalar(dark ? 1.6 : 0.78);
    const capMat = new THREE.MeshBasicMaterial({ color: capColor, side: THREE.BackSide, clippingPlanes: this.clipPlanes, toneMapped: false });
    capMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float hl = fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0);
        float line = 1.0 - smoothstep(0.08, 0.16, abs(hl - 0.5));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.72, line);`);
    };
    const cap = new THREE.Mesh(geo, capMat);
    cap.visible = false;
    cap.renderOrder = 1;

    // edges
    const edges = p.edges || [];
    const edgeMap = new Map();
    const segs = [];
    const segIds = [];
    edges.forEach((e, ei) => {
      const gid = this._pickTable.length;
      this._pickTable.push({ part: pi, kind: 'edge', index: ei });
      edgeMap.set(e.id, e);
      e._gid = gid;
      let pts = e.points ? f32(e.points) : null;
      if ((!pts || pts.length < 6) && e.start && e.end) pts = new Float32Array([...e.start, ...e.end]);
      e._seg0 = segIds.length;
      if (pts) {
        for (let k = 0; k + 5 < pts.length; k += 3) {
          segs.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], pts[k + 5]);
          segIds.push(gid);
        }
      }
      e._segN = segIds.length - e._seg0;
    });
    const segArr = new Float32Array(segs);
    let lines = null, lineMat = null;
    if (segIds.length) {
      const lg = new LineSegmentsGeometry();
      lg.setPositions(segArr);
      lg.setAttribute('instanceEdgeId', new THREE.InstancedBufferAttribute(new Float32Array(segIds), 1));
      lineMat = new LineMaterial({ color: dark ? 0x8a8a8a : 0x161616, linewidth: 1.25, worldUnits: false, transparent: true, opacity: dark ? 0.85 : 0.9 });
      lineMat.alphaToCoverage = false;
      lineMat.clippingPlanes = this.clipPlanes;
      this._lineMats.add(lineMat);
      lines = new LineSegments2(lg, lineMat);
      lines.renderOrder = 2;
      lines.userData.part = pi;
      lines.userData.noAO = true;
    }
    const group = new THREE.Group();
    group.add(mesh, cap);
    if (lines) group.add(lines);
    const overlays = new THREE.Group();
    overlays.userData.noAO = true;
    group.add(overlays);

    // stats
    let area = 0;
    for (const f of faces) area += f.area || 0;
    let vol = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      vol += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    return {
      id: p.id || `p${pi}`, name: p.name || `part ${pi}`, color: p.color || '#d9d7d2', index: pi, visible: true,
      data: p, faces, edges, faceMap, edgeMap, segArr, geo, mesh, cap, lines, lineMat, mat, xray, capMat, group, overlays,
      triangles: idx.length / 3, box: geo.boundingBox.clone(), area, volume: Math.abs(vol), offset: new THREE.Vector3(),
    };
  }

  _clearParts() {
    for (const p of this.parts) {
      p.geo.dispose();
      p.lines?.geometry.dispose();
      p.mat.dispose(); p.xray.dispose(); p.capMat.dispose();
      if (p.lineMat) { p.lineMat.dispose(); this._lineMats.delete(p.lineMat); }
      this._disposeOverlays(p);
      this.root.remove(p.group);
    }
    this.parts = [];
    this.sceneData = null;
  }

  _disposeOverlays(p) {
    for (const c of p.overlays.children.slice()) {
      if (c.isLineSegments2) c.geometry.dispose();
      p.overlays.remove(c);
    }
  }

  clear() {
    this._clearParts();
    this.setGhost(null);
    this.selection = []; this.highlighted = [];
    this._clearLabels('measure'); this._clearLabels('bbox');
    this._dirty = true;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    this.clear();
    this.controls.dispose();
    this.composer?.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.helpEl.remove();
  }

  // ------------------------------------------------------------ ground / grid / shadow

  _layoutGround() {
    const box = this._visibleBox();
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const diag = Math.max(size.length(), 1e-3);
    const gz = box.min.z - diag * 0.0015;
    this.groundZ = gz;
    const cell = Math.pow(10, Math.floor(Math.log10(Math.max(diag / 8, 1e-3))));
    this.gridMat.uniforms.uCell.value = cell;
    this.gridMat.uniforms.uCenter.value.copy(c);
    this.gridMat.uniforms.uFade.value = diag * 1.35;
    this.grid.scale.set(diag * 12, diag * 12, 1);
    this.grid.position.set(c.x, c.y, gz - diag * 0.0005);
    const sw = Math.max(size.x, size.y) * 1.25 + diag * 0.35;
    for (const L of this.shadowLayers) {
      L.plane.scale.set(-sw, sw, 1);   // mirrored: the shadow camera looks up
      L.plane.position.set(c.x, c.y, gz + (L.reach < 0.5 ? diag * 0.0002 : 0));
      const sc = L.cam;
      sc.left = -sw / 2; sc.right = sw / 2; sc.top = sw / 2; sc.bottom = -sw / 2;
      sc.near = 0; sc.far = Math.max(L.reach < 0.5 ? diag * L.reach : Math.max(size.z, diag * 0.3) * L.reach, 1e-3);
      sc.up.set(0, 1, 0);
      sc.position.set(c.x, c.y, gz);
      sc.lookAt(c.x, c.y, gz + 1);
      sc.updateProjectionMatrix();
    }
    this._shadowDirty = true;
    this.grid.visible = this.state.grid;
    this.shadowPlane.visible = this.state.shadow;
  }

  _renderShadow() {
    const r = this.renderer;
    const bg = this.scene.background;
    this.scene.background = null;
    const prevClear = r.getClearAlpha();
    const prevColor = r.getClearColor(new THREE.Color());
    r.setClearColor(0x000000, 0);
    for (const L of this.shadowLayers) {
      this.scene.overrideMaterial = L.mat;
      r.setRenderTarget(L.rt);
      r.clear();
      r.render(this.scene, L.cam);
      this.scene.overrideMaterial = null;
      for (const amount of L.blur) {
        this.blurMat.uniforms.tDiffuse.value = L.rt.texture;
        this.blurMat.uniforms.uDir.value.set(amount / L.size, 0);
        r.setRenderTarget(L.rtBlur); r.clear(); r.render(this.fsQuad, this.fsCam);
        this.blurMat.uniforms.tDiffuse.value = L.rtBlur.texture;
        this.blurMat.uniforms.uDir.value.set(0, amount / L.size);
        r.setRenderTarget(L.rt); r.clear(); r.render(this.fsQuad, this.fsCam);
      }
    }
    r.setRenderTarget(null);
    r.setClearColor(prevColor, prevClear);
    this.scene.background = bg;
    this._shadowDirty = false;
  }

  // ------------------------------------------------------------ render loop

  _resize() {
    const w = Math.max(this.container.clientWidth, 1), h = Math.max(this.container.clientHeight, 1);
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this._updateOrthoFrustum();
    for (const m of this._lineMats) if (m !== this.pickLineMat) m.resolution.set(w, h);
    this.composer?.setSize(w, h);
    this.aoPass?.setSize?.(w, h);
    if (this.cube) this.cube.size = w < 520 ? 84 : 112;
    this._dirty = true;
  }

  _updateOrthoFrustum() {
    const H = this._orthoH || 100;
    const a = (this.width || 1) / (this.height || 1);
    const o = this.orthoCam;
    o.left = -H * a / 2; o.right = H * a / 2; o.top = H / 2; o.bottom = -H / 2;
    o.updateProjectionMatrix();
  }

  _loop(t) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._loop);
    if (this._anim) this._stepAnim(t);
    if (this._explodeAnim) this._stepExplode(t);
    if (this.controls.update()) this._dirty = true;
    if (this._hoverPending && this._mouse.inside) { this._hoverPending = false; this._doHover(); }
    if (this._dirty) this.render();
  }

  render() {
    this._dirty = false;
    const cam = this.camera;
    // dynamic near/far for precision at any zoom
    const dist = cam.position.distanceTo(this.controls.target);
    if (cam.isPerspectiveCamera) {
      const d = this.diag || 100;
      const near = Math.max(dist * 0.01, d * 1e-5), far = dist + d * 30;
      if (Math.abs(near - cam.near) / cam.near > 0.05 || Math.abs(far - cam.far) / cam.far > 0.05) {
        cam.near = near; cam.far = far; cam.updateProjectionMatrix();
      }
    } else {
      const d = (this.diag || 100) * 40;
      if (cam.far !== dist + d) { cam.near = -d; cam.far = dist + d; cam.updateProjectionMatrix(); }
    }
    this.lightRig.position.copy(cam.position);
    this.lightRig.quaternion.copy(cam.quaternion);
    if (this.state.shadow && this._shadowDirty && this.parts.length) this._renderShadow();
    const r = this.renderer;
    r.setRenderTarget(null);
    if (this.composer && this.state.ao && !this.state.section.enabled) {
      this.renderPass.camera = cam; this.aoPass.camera = cam;
      this.composer.render();
    } else {
      r.render(this.scene, cam);
    }
    if (this.cube && !this._hideCube) this._renderCube();
    this._updateLabels();
  }

  _renderCube() {
    const r = this.renderer, cs = this.cube;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    cs.camera.position.copy(dir).multiplyScalar(8);
    cs.camera.up.copy(this.camera.up);
    cs.camera.lookAt(0, 0, 0);
    const s = cs.size, m = cs.margin;
    const x = this.width - s - m, y = this.height - s - m - (this.opts.cubeTop || 0);   // top-right (viewport y from bottom)
    r.autoClear = false;
    r.setScissorTest(true);
    r.setViewport(x, y, s, s);
    r.setScissor(x, y, s, s);
    r.clearDepth();
    const prevTM = r.toneMapping;
    r.render(cs.scene, cs.camera);
    r.toneMapping = prevTM;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.autoClear = true;
  }

  _cubeHit(mx, my) {
    if (!this.cube) return null;
    const cs = this.cube, s = cs.size, m = cs.margin;
    const x0 = this.width - s - m, y0 = m + (this.opts.cubeTop || 0);
    if (mx < x0 || mx > x0 + s || my < y0 || my > y0 + s) return null;
    const nx = ((mx - x0) / s) * 2 - 1, ny = -((my - y0) / s) * 2 + 1;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), cs.camera);
    const hit = rc.intersectObjects(cs.regions, false)[0];
    return hit ? hit.object : 'bg';
  }

  _cubeHover(obj) {
    if (!this.cube) return;
    const cs = this.cube;
    const key = obj && obj !== 'bg' ? obj.userData.key : null;
    if (key === cs.hover) return;
    cs.hover = key;
    for (const r of cs.regions) {
      const on = r.userData.key === key;
      const isFace = !!r.material.map;
      r.material.color.set(on ? 0xffd9c9 : (isFace ? 0xfbfbfa : 0xf2f2f0));
    }
    this.renderer.domElement.style.cursor = key ? 'pointer' : '';
    this._dirty = true;
  }

  // ------------------------------------------------------------ camera

  _visibleBox() {
    const box = new THREE.Box3();
    for (const p of this.parts) {
      if (!p.visible) continue;
      const b = p.box.clone().translate(p.offset);
      box.union(b);
    }
    if (box.isEmpty()) {
      if (this.modelBox) return this.modelBox.clone();
      box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    }
    return box;
  }

  _fitParams(box, dir) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const fov = THREE.MathUtils.degToRad(this.perspCam.fov);
    const aspect = this.width / this.height;
    const fovMin = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * aspect) : fov;
    const m = this.opts.fitMargin || 1;
    const dist = (r / Math.sin(fovMin / 2)) * 1.02 * m;
    const H = this._orthoH;
    const zoom = Math.min(H / (2 * r), (H * aspect) / (2 * r)) / (1.1 * m);
    return { target: sphere.center, dist, zoom, r };
  }

  fit(animate = true, view = null) {
    const box = this._visibleBox();
    if (!this._orthoH || !animate) this._orthoH = Math.max(box.getSize(new THREE.Vector3()).length() * 1.2, 1e-2);
    this._updateOrthoFrustum();
    const dir = view ? V(VIEWS[view]).normalize() : new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const { target, dist, zoom } = this._fitParams(box, dir);
    this._flyTo(target, dir, dist, zoom, animate);
  }

  setView(name, animate = true) {
    const v = VIEWS[name];
    if (!v) return;
    const box = this._visibleBox();
    const { target, dist, zoom } = this._fitParams(box);
    this._flyTo(target, V(v).normalize(), dist, zoom, animate);
    this.dispatchEvent(new CustomEvent('viewchange', { detail: { view: name } }));
  }

  viewFromDirection(d, animate = true) {
    const dir = V(d).normalize();
    if (Math.abs(dir.z) > 0.9999) dir.set(0, dir.z > 0 ? -1e-4 : 1e-4, Math.sign(dir.z)).normalize();
    const { target, dist, zoom } = this._fitParams(this._visibleBox());
    this._flyTo(target, dir, dist, zoom, animate);
  }

  _flyTo(target, dir, dist, zoom, animate = true) {
    const cam = this.camera, c = this.controls;
    const fromDir = new THREE.Vector3().subVectors(cam.position, c.target);
    const fromDist = fromDir.length() || dist;
    fromDir.normalize();
    const to = { target: target.clone(), dir: dir.clone().normalize(), dist, zoom };
    if (!animate) {
      this._applyCam(to.target, to.dir, to.dist, cam.isOrthographicCamera ? zoom : null);
      this.orthoCam.zoom = zoom; this.orthoCam.updateProjectionMatrix();
      this._dirty = true;
      return;
    }
    this._anim = { t0: performance.now(), dur: 520, from: { target: c.target.clone(), dir: fromDir, dist: fromDist, zoom: this.orthoCam.zoom }, to };
  }

  _applyCam(target, dir, dist, zoom) {
    const cam = this.camera;
    this.controls.target.copy(target);
    const d = cam.isOrthographicCamera ? Math.max(dist, (this.diag || 100) * 2) : dist;
    cam.position.copy(target).addScaledVector(dir, d);
    cam.lookAt(target);
    if (zoom != null && cam.isOrthographicCamera) { cam.zoom = zoom; cam.updateProjectionMatrix(); }
    if (cam !== this.perspCam) { this.perspCam.position.copy(target).addScaledVector(dir, dist); this.perspCam.lookAt(target); }
    this.controls.update();
  }

  _stepAnim(now) {
    const a = this._anim;
    const t = Math.min((now - a.t0) / a.dur, 1);
    const k = ease(t);
    const target = a.from.target.clone().lerp(a.to.target, k);
    const dir = slerpDir(a.from.dir, a.to.dir, k, new THREE.Vector3());
    const dist = a.from.dist * Math.pow(a.to.dist / a.from.dist, k);
    const zoom = a.from.zoom * Math.pow(a.to.zoom / a.from.zoom, k);
    this._applyCam(target, dir, dist, zoom);
    if (this.camera !== this.orthoCam) { this.orthoCam.zoom = zoom; this.orthoCam.updateProjectionMatrix(); }
    this._dirty = true;
    if (t >= 1) this._anim = null;
  }

  setProjection(mode) {
    if (mode === this.state.projection) return;
    const c = this.controls;
    const dir = new THREE.Vector3().subVectors(this.camera.position, c.target);
    const dist = dir.length(); dir.normalize();
    const tan = Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
    if (!this._orthoH) this._orthoH = (this.diag || 100) * 1.2;
    if (mode === 'orthographic') {
      const zoom = this._orthoH / (2 * dist * tan);
      this.orthoCam.zoom = zoom;
      this.orthoCam.position.copy(c.target).addScaledVector(dir, Math.max(dist, this.diag * 2));
      this.orthoCam.quaternion.copy(this.camera.quaternion);
      this.orthoCam.updateProjectionMatrix();
      this.camera = this.orthoCam;
    } else {
      const d = this._orthoH / (2 * this.orthoCam.zoom * tan);
      this.perspCam.position.copy(c.target).addScaledVector(dir, d);
      this.perspCam.quaternion.copy(this.camera.quaternion);
      this.camera = this.perspCam;
    }
    this._updateOrthoFrustum();
    c.object = this.camera;
    c.update();
    this.state.projection = mode;
    this._emitState();
    this._dirty = true;
  }

  // ------------------------------------------------------------ picking

  _pickAt(x, y) {
    if (!this.parts.length) return null;
    const r = this.renderer, cam = this.camera;
    const swaps = [];
    const hidden = [];
    for (const o of [this.grid, this.shadowPlane, this.sectionHelper, this.helpers, this.ghostRoot]) if (o.visible) { hidden.push(o); o.visible = false; }
    for (const p of this.parts) {
      if (!p.visible) continue;
      if (p.mesh.visible) { swaps.push([p.mesh, p.mesh.material]); p.mesh.material = this.pickMat; }
      if (p.lines && p.lines.visible) { swaps.push([p.lines, p.lines.material]); p.lines.material = this.pickLineMat; }
      if (p.cap.visible) { hidden.push(p.cap); p.cap.visible = false; }
      if (p.overlays.visible) { hidden.push(p.overlays); p.overlays.visible = false; }
    }
    const bg = this.scene.background, env = this.scene.environment;
    this.scene.background = null;
    const prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    this.pickLineMat.resolution.set(1, 1);
    cam.setViewOffset(this.width, this.height, Math.floor(x), Math.floor(y), 1, 1);
    r.setRenderTarget(this.pickRT);
    r.clear();
    r.render(this.scene, cam);
    r.readRenderTargetPixels(this.pickRT, 0, 0, 1, 1, this._pickBuf);
    r.setRenderTarget(null);
    cam.clearViewOffset();
    r.setClearColor(prevColor, prevAlpha);
    this.scene.background = bg; this.scene.environment = env;
    for (const [o, m] of swaps) o.material = m;
    for (const o of hidden) o.visible = true;
    const b = this._pickBuf;
    const id = b[0] * 65536 + b[1] * 256 + b[2];
    const e = this._pickTable?.[id];
    if (!e) return null;
    const part = this.parts[e.part];
    const desc = e.kind === 'face' ? part.faces[e.index] : part.edges[e.index];
    return desc ? desc.id : null;
  }

  _filterId(id) {
    if (!id) return null;
    const f = this.state.filter;
    if (f === 'part') return id.split('/')[0];
    if (f === 'face' && !/\/f\d+$/.test(id)) return null;
    if (f === 'edge' && !/\/e\d+$/.test(id)) return null;
    return id;
  }

  _doHover() {
    const { x, y } = this._mouse;
    const cubeObj = this._cubeHit(x, y);
    if (cubeObj) { this._cubeHover(cubeObj); this._setHover(null); return; }
    this._cubeHover(null);
    if (!this.opts.interactive) return;
    const id = this._filterId(this._pickAt(x, y));
    this._setHover(id);
  }

  _setHover(id) {
    if (id === this.hoverId) { if (id) this._moveTip(); return; }
    this.hoverId = id;
    this._refreshOverlays();
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    if (id) this._showTip(id); else this._hideTip();
    this.dispatchEvent(new CustomEvent('hover', { detail: { id } }));
  }

  _showTip(id) {
    const e = this.getEntity(id);
    if (!e) return;
    let extra = '';
    if (e.kind === 'face') extra = e.radius ? `r ${fmt(e.radius)}` : `${fmt(e.area)} mm²`;
    else if (e.kind === 'edge') extra = e.radius ? `r ${fmt(e.radius)}` : `${fmt(e.length)} mm`;
    else extra = e.name;
    this.tip.innerHTML = `<b>${id}</b><span>${e.kind === 'part' ? 'part' : e.type}</span><span>${extra}</span>`;
    this.tip.classList.add('on');
    this._moveTip();
  }
  _moveTip() {
    const { x, y } = this._mouse;
    const w = this.tip.offsetWidth || 120;
    const tx = x + 16 + w > this.width ? x - w - 12 : x + 16;
    this.tip.style.transform = `translate(${tx}px, ${y + 18}px)`;
  }
  _hideTip() { this.tip.classList.remove('on'); }

  _onClick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const cubeObj = this._cubeHit(x, y);
    if (cubeObj) {
      if (cubeObj !== 'bg') this.viewFromDirection(cubeObj.userData.dir);
      return;
    }
    if (!this.opts.interactive) return;
    const raw = this._pickAt(x, y);
    if (this.state.tool === 'measure') {
      const id = raw && (this.state.filter === 'part' ? raw : raw);
      if (!id) return;
      if (this.measurePicks.length >= 2) this.measurePicks = [];
      this.measurePicks.push(id);
      this.select(this.measurePicks.slice());
      if (this.measurePicks.length === 2) this._runMeasure();
      else { this.measureResult = null; this._drawMeasure(); this.dispatchEvent(new CustomEvent('measure', { detail: { picks: this.measurePicks.slice(), result: null } })); }
      return;
    }
    const id = this._filterId(raw);
    if (!id) { if (!e.shiftKey) this.clearSelection(); return; }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const i = this.selection.indexOf(id);
      const next = this.selection.slice();
      if (i >= 0) next.splice(i, 1); else next.push(id);
      this.select(next);
    } else {
      this.select(this.selection.length === 1 && this.selection[0] === id ? [] : [id]);
    }
  }

  _onDblClick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (this._cubeHit(x, y)) return;
    const id = this._pickAt(x, y);
    if (!id) { this.fit(); return; }
    const ent = this.getEntity(id);
    if (e.altKey && ent?.kind === 'face') { this.lookAtFace(id); return; }
    const pt = this._hitPoint(x, y, id) || this._entityPoint(ent);
    if (!pt) return;
    const cam = this.camera;
    const dir = new THREE.Vector3().subVectors(cam.position, this.controls.target).normalize();
    const dist = cam.position.distanceTo(pt);
    this._flyTo(pt, dir, cam.isPerspectiveCamera ? dist : cam.position.distanceTo(this.controls.target), this.orthoCam.zoom, true);
  }

  _hitPoint(x, y, id) {
    const ent = this.getEntity(id);
    if (!ent) return null;
    const part = this.parts[ent.partIndex];
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const ray = rc.ray.clone();
    ray.origin.sub(part.offset);
    if (ent.kind === 'face') {
      const pos = part.geo.attributes.position.array, idx = part.geo.index.array;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), out = new THREE.Vector3();
      let best = null, bd = Infinity;
      const s = ent.start, n = Math.min(ent.count, 200000);
      for (let t = s; t < s + n; t++) {
        a.fromArray(pos, idx[t * 3] * 3); b.fromArray(pos, idx[t * 3 + 1] * 3); c.fromArray(pos, idx[t * 3 + 2] * 3);
        if (ray.intersectTriangle(a, b, c, false, out)) {
          const d = out.distanceTo(ray.origin);
          if (d < bd) { bd = d; best = out.clone(); }
        }
      }
      return best ? best.add(part.offset) : null;
    }
    return null;
  }

  _entityPoint(ent) {
    if (!ent) return null;
    const part = this.parts[ent.partIndex];
    let p = null;
    if (ent.kind === 'face' && ent.center) p = V(ent.center);
    else if (ent.kind === 'edge') p = ent.center ? V(ent.center) : (ent.start && ent.end ? V(ent.start).lerp(V(ent.end), 0.5) : null);
    else if (ent.kind === 'part') p = part.box.getCenter(new THREE.Vector3());
    return p ? p.add(part.offset) : null;
  }

  // ------------------------------------------------------------ entities & selection

  getEntity(id) {
    if (!id || !this.parts.length) return null;
    const [pid, sub] = String(id).trim().split('/');
    const part = this.parts.find((p) => p.id === pid);
    if (!part) return null;
    if (!sub) {
      return {
        id: pid, kind: 'part', partIndex: part.index, name: part.name, color: part.color,
        faces: part.faces.length, edges: part.edges.length, triangles: part.triangles,
        area: part.area, volume: part.volume, bbox: { min: part.box.min.toArray(), max: part.box.max.toArray(), size: part.box.getSize(new THREE.Vector3()).toArray() },
      };
    }
    const d = sub[0] === 'f' ? part.faceMap.get(id) : part.edgeMap.get(id);
    if (!d) return null;
    const out = { kind: sub[0] === 'f' ? 'face' : 'edge', partIndex: part.index, partName: part.name };
    for (const k in d) if (k[0] !== '_' && k !== 'points') out[k] = d[k];
    return out;
  }

  select(ids, { silent = false } = {}) {
    if (typeof ids === 'string') ids = ids.split(/[\s,]+/).filter(Boolean);
    this.selection = [...new Set((ids || []).filter((i) => this.getEntity(i)))];
    this._refreshOverlays();
    if (!silent) this.dispatchEvent(new CustomEvent('selectionchange', { detail: { ids: this.selection.slice(), entities: this.selection.map((i) => this.getEntity(i)) } }));
  }

  clearSelection() {
    if (!this.selection.length && !this.measurePicks.length) return;
    this.measurePicks = []; this.measureResult = null; this._drawMeasure();
    this.select([]);
  }

  highlight(ids) {
    if (typeof ids === 'string') ids = ids.split(/[\s,]+/).filter(Boolean);
    this.highlighted = (ids || []).filter((i) => this.getEntity(i));
    this._refreshOverlays();
  }

  _refreshOverlays() {
    for (const p of this.parts) this._disposeOverlays(p);
    const add = (id, kind) => {
      const ent = this.getEntity(id);
      if (!ent) return;
      const p = this.parts[ent.partIndex];
      if (ent.kind === 'face' || ent.kind === 'part') {
        const m = new THREE.Mesh(p.geo, this.overlayMats[kind]);
        if (ent.kind === 'face') m.geometry = p.geo, m.userData.range = [ent.start * 3, ent.count * 3];
        m.onBeforeRender = function (r, s, c, geom) { if (this.userData.range) geom.setDrawRange(this.userData.range[0], this.userData.range[1]); };
        m.onAfterRender = function (r, s, c, geom) { geom.setDrawRange(0, Infinity); };
        m.renderOrder = 3;
        m.frustumCulled = false;
        p.overlays.add(m);
      } else {
        const ed = p.edgeMap.get(id);
        if (!ed || !ed._segN) return;
        const arr = p.segArr.subarray(ed._seg0 * 6, (ed._seg0 + ed._segN) * 6);
        const g = new LineSegmentsGeometry(); g.setPositions(arr);
        const l = new LineSegments2(g, this.overlayLineMats[kind]);
        l.renderOrder = 4;
        p.overlays.add(l);
      }
    };
    for (const id of this.highlighted) add(id, 'agent');
    for (const id of this.selection) add(id, 'select');
    if (this.hoverId && !this.selection.includes(this.hoverId)) add(this.hoverId, 'hover');
    this._dirty = true;
  }

  lookAtFace(id) {
    const ent = this.getEntity(id);
    if (!ent || ent.kind !== 'face') return;
    let n = ent.normal ? V(ent.normal) : null;
    if (!n && ent.axis) {   // cylinder: look down the axis
      n = V(ent.axis);
    }
    if (!n) return;
    const p = this._entityPoint(ent) || this.modelCenter;
    const { dist, zoom } = this._fitParams(this._visibleBox());
    if (Math.abs(n.z) > 0.9999) n.set(0, n.z > 0 ? -1e-4 : 1e-4, Math.sign(n.z));
    this._flyTo(p, n.normalize(), dist, zoom, true);
  }

  // ------------------------------------------------------------ parts

  _applyPartVisibility(p, v) {
    p.visible = v;
    p.group.visible = v;
  }
  setPartVisible(id, v) {
    const p = this.parts.find((q) => q.id === id);
    if (!p) return;
    this._applyPartVisibility(p, v);
    this._afterVisibility();
  }
  isolate(id) {
    for (const p of this.parts) this._applyPartVisibility(p, p.id === id);
    this._afterVisibility();
  }
  showAll() {
    for (const p of this.parts) this._applyPartVisibility(p, true);
    this._afterVisibility();
  }
  _afterVisibility() {
    this._shadowDirty = true;
    if (this.state.bbox) this._drawBBox();
    this._dirty = true;
    this.dispatchEvent(new CustomEvent('partschange', { detail: { parts: this.partList() } }));
  }
  partList() {
    return this.parts.map((p) => ({ id: p.id, name: p.name, color: p.color, visible: p.visible, faces: p.faces.length, edges: p.edges.length, triangles: p.triangles }));
  }

  stats() {
    const box = this.modelBox || new THREE.Box3();
    let faces = 0, edges = 0, area = 0, volume = 0;
    for (const p of this.parts) { faces += p.faces.length; edges += p.edges.length; area += p.area; volume += p.volume; }
    const size = box.getSize(new THREE.Vector3());
    return {
      parts: this.parts.length, faces, edges, triangles: this.triangles || 0, area, volume,
      bbox: { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray() },
    };
  }

  // ------------------------------------------------------------ render modes

  setRenderMode(mode, force = false) {
    if (mode === this.state.renderMode && !force) return;
    this.state.renderMode = mode;
    for (const p of this.parts) {
      p.mesh.visible = mode !== 'wireframe';
      p.mesh.material = mode === 'xray' ? p.xray : mode === 'hidden' ? this.depthOnlyMat : p.mat;
      if (p.lines) {
        p.lines.visible = mode !== 'shaded';
        p.lineMat.depthTest = mode !== 'wireframe';
        p.lineMat.opacity = mode === 'xray' ? 0.55 : (p.lineMat.color.r > 0.3 ? 0.85 : 0.9);
      }
    }
    this.shadowPlane.visible = this.state.shadow && mode !== 'wireframe' && mode !== 'hidden';
    this._emitState();
    this._dirty = true;
  }

  setAutoRotate(on, speed = this.opts.autoRotateSpeed || 0.55) {
    this.controls.autoRotate = !!on;
    this.controls.autoRotateSpeed = speed;
  }

  setGrid(v) { this.state.grid = v; this.grid.visible = v; this._emitState(); this._dirty = true; }
  setShadow(v) { this.state.shadow = v; this.shadowPlane.visible = v; this._shadowDirty = true; this._emitState(); this._dirty = true; }

  setFilter(f) { this.state.filter = f; this._emitState(); }

  setTool(tool) {
    if (tool === this.state.tool) return;
    this.state.tool = tool;
    if (tool !== 'measure') { this.measurePicks = []; this.measureResult = null; this._drawMeasure(); }
    else { this.measurePicks = this.selection.slice(-2); if (this.measurePicks.length === 2) this._runMeasure(); }
    this.container.classList.toggle('vc-measuring', tool === 'measure');
    if (tool === 'measure') this.flash('Measure — pick two faces or edges');
    this._emitState();
  }

  async setAO(on) {
    this.state.ao = !!on;
    if (on && !this.composer) {
      try {
        const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { OutputPass }] = await Promise.all([
          import('three/addons/postprocessing/EffectComposer.js'),
          import('three/addons/postprocessing/RenderPass.js'),
          import('three/addons/postprocessing/GTAOPass.js'),
          import('three/addons/postprocessing/OutputPass.js'),
        ]);
        const rt = new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(this.width, this.height);
        this.renderPass = new RenderPass(this.scene, this.camera);
        this.aoPass = new GTAOPass(this.scene, this.camera, this.width, this.height);
        this.aoPass.output = GTAOPass.OUTPUT.Default;
        this.aoPass.blendIntensity = 0.85;
        const d = this.diag || 100;
        this.aoPass.updateGtaoMaterial({ radius: d * 0.04, distanceExponent: 1.5, thickness: d * 0.02, scale: 1.0, samples: 12 });
        this.aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
        const self = this;
        // keep fat lines, helpers and overlays out of the AO g-buffer
        this.aoPass.overrideVisibility = function () {
          const cache = this._visibilityCache;
          this.scene.traverse((o) => {
            cache.set(o, o.visible);
            if (o.isPoints || o.isLine || o.isLineSegments2 || o.userData.noAO || o.userData.helper || o === self.ghostRoot || o === self.helpers) o.visible = false;
          });
        };
        this.composer.addPass(this.renderPass);
        this.composer.addPass(this.aoPass);
        this.composer.addPass(new OutputPass());
      } catch (e) {
        console.warn('AO unavailable', e);
        this.state.ao = false;
      }
    }
    if (this.aoPass && this.diag) {
      const d = this.diag;
      this.aoPass.updateGtaoMaterial({ radius: d * 0.04, thickness: d * 0.02 });
    }
    this._emitState();
    this._dirty = true;
  }

  // ------------------------------------------------------------ section

  setSection(opts = {}) {
    const s = this.state.section;
    const wasOn = s.enabled;
    Object.assign(s, opts);
    if (s.enabled && !wasOn && !opts.axis && !opts.face && s.axis !== 'custom' && opts.flip == null) {
      const toCam = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      s.flip = toCam.dot(V(s.normal)) < 0;
    }
    if (opts.axis && typeof opts.axis === 'string') {
      s.normal = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[opts.axis];
      if (opts.flip == null) {   // keep the half whose cut face looks at the camera
        const toCam = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
        s.flip = toCam.dot(V(s.normal)) < 0;
      }
    }
    if (opts.normal && !opts.axis) s.axis = 'custom';
    if (opts.face) {
      const ent = this.getEntity(opts.face);
      if (ent?.normal) {
        s.normal = ent.normal.slice(); s.axis = 'custom'; s.enabled = true;
        const n = V(s.normal).normalize();
        const [lo, hi] = this._clipRange(n);
        const c = this._entityPoint(ent) || this.modelCenter;
        s.offset = THREE.MathUtils.clamp((n.dot(c) - lo) / (hi - lo || 1) - 0.002, 0, 1);
        s.flip = false;
        const toCam = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
        if (toCam.dot(n) < 0) s.flip = true;
      }
      delete s.face;
    }
    this._applySection();
    this._emitState();
  }

  _clipRange(n) {
    const b = this._visibleBox();
    let lo = Infinity, hi = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const d = n.x * x + n.y * y + n.z * z;
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    const pad = (hi - lo) * 0.01;
    return [lo - pad, hi + pad];
  }
  _updateClipRange() { if (this.state.section.enabled) this._applySection(); }

  _applySection() {
    const s = this.state.section;
    const on = s.enabled && this.parts.length > 0;
    this.clipPlanes.length = 0;
    if (on) {
      const n = V(s.normal).normalize();
      const [lo, hi] = this._clipRange(n);
      const d = lo + (hi - lo) * s.offset;
      // keep the side where n·p < d (or > d when flipped)
      if (!s.flip) this.clipPlane.set(n.clone().negate(), d);
      else this.clipPlane.set(n.clone(), -d);
      this.clipPlanes.push(this.clipPlane);
      this.sectionValue = d;
      // outline helper
      const b = this._visibleBox(), c = b.getCenter(new THREE.Vector3());
      const sz = b.getSize(new THREE.Vector3()).length() * 0.62;
      const p = c.clone().addScaledVector(n, d - n.dot(c));
      this.sectionHelper.position.copy(p);
      this.sectionHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      this.sectionHelper.scale.set(sz, sz, 1);
    }
    this.sectionHelper.visible = on;
    for (const p of this.parts) p.cap.visible = on && p.mesh.visible && this.state.renderMode !== 'xray';
    // ShaderMaterials need a recompile when the number of planes changes
    for (const p of this.parts) { p.mat.needsUpdate = true; p.xray.needsUpdate = true; p.capMat.needsUpdate = true; }
    for (const m of this._lineMats) m.needsUpdate = true;
    for (const m of [this.pickMat, this.depthOnlyMat, ...this.shadowLayers.map((L) => L.mat), ...Object.values(this.overlayMats)]) m.needsUpdate = true;
    this._shadowDirty = true;
    this._dirty = true;
  }

  // ------------------------------------------------------------ explode

  _computeExplodeDirs() {
    const c = this.modelCenter;
    const n = this.parts.length;
    for (const p of this.parts) {
      const pc = p.box.getCenter(new THREE.Vector3());
      const d = pc.sub(c);
      if (d.length() < this.diag * 0.02) {
        const a = (p.index / Math.max(n, 1)) * Math.PI * 2;
        d.set(Math.cos(a), Math.sin(a), 0.3).multiplyScalar(this.diag * 0.15);
      }
      p.explodeDir = d;
    }
  }

  setExplode(t) {
    this.state.explode = THREE.MathUtils.clamp(+t || 0, 0, 1);
    this._applyExplode();
    this._emitState();
  }

  animateExplode(to) {
    this._explodeAnim = { t0: performance.now(), from: this.state.explode, to, dur: 600 };
  }
  _stepExplode(now) {
    const a = this._explodeAnim;
    const t = Math.min((now - a.t0) / a.dur, 1);
    this.state.explode = a.from + (a.to - a.from) * ease(t);
    this._applyExplode();
    if (t >= 1) { this._explodeAnim = null; this._emitState(); }
    else this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }

  _applyExplode() {
    const k = this.state.explode * 1.1;
    for (const p of this.parts) {
      p.offset.copy(p.explodeDir || new THREE.Vector3()).multiplyScalar(k);
      p.group.position.copy(p.offset);
    }
    if (this.parts.length) this._layoutGround();
    if (this.state.section.enabled) this._applySection();
    if (this.state.bbox) this._drawBBox();
    if (this.measureResult) this._drawMeasure();
    this._shadowDirty = true;
    this._dirty = true;
  }

  // ------------------------------------------------------------ ghost (steps timeline)

  setGhost(scene) {
    for (const c of this.ghostRoot.children.slice()) {
      c.geometry?.dispose(); this.ghostRoot.remove(c);
    }
    if (!scene || !scene.parts) { this._dirty = true; return; }
    const mat = this._ghostMat || (this._ghostMat = new THREE.MeshBasicMaterial({ color: 0x5b6b8a, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: this.clipPlanes }));
    const lmat = this._ghostLineMat || (this._ghostLineMat = new THREE.LineBasicMaterial({ color: 0x5b6b8a, transparent: true, opacity: 0.35, depthWrite: false }));
    for (const p of scene.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(f32(p.positions), 3));
      g.setIndex(new THREE.BufferAttribute(u32(p.indices), 1));
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 5;
      this.ghostRoot.add(m);
      const segs = [];
      for (const e of p.edges || []) {
        const pts = e.points ? f32(e.points) : null;
        if (!pts) continue;
        for (let k = 0; k + 5 < pts.length; k += 3) segs.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], pts[k + 5]);
      }
      if (segs.length) {
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
        const l = new THREE.LineSegments(lg, lmat);
        l.renderOrder = 5;
        this.ghostRoot.add(l);
      }
    }
    this._dirty = true;
  }

  // ------------------------------------------------------------ measure

  _measureGeom(id) {
    const e = this.getEntity(id);
    if (!e) return null;
    const off = this.parts[e.partIndex].offset;
    if (e.kind === 'face') return { e, off, point: e.center ? V(e.center) : null, normal: e.normal ? V(e.normal).normalize() : null, axis: e.axis ? V(e.axis).normalize() : null };
    if (e.kind === 'edge') {
      const a = e.start ? V(e.start) : null, b = e.end ? V(e.end) : null;
      const point = e.center ? V(e.center) : (a && b ? a.clone().lerp(b, 0.5) : a);
      const dir = e.type === 'line' && a && b ? b.clone().sub(a).normalize() : null;
      return { e, off, point, a, b, dir };
    }
    const part = this.parts[e.partIndex];
    return { e, off, point: part.box.getCenter(new THREE.Vector3()) };
  }

  _runMeasure() {
    const [ia, ib] = this.measurePicks;
    const A = this._measureGeom(ia), B = this._measureGeom(ib);
    if (!A || !B || !A.point || !B.point) return;
    let p1 = A.point.clone(), p2 = B.point.clone();
    let distance = p1.distanceTo(p2), angle = null, kind = 'center-to-center';
    if (A.normal && B.normal) {
      angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(Math.abs(A.normal.dot(B.normal)), -1, 1)));
      if (angle < 0.05) {
        const d = B.point.clone().sub(A.point).dot(A.normal);
        distance = Math.abs(d);
        p2 = p1.clone().addScaledVector(A.normal, d);
        kind = 'parallel planes';
        angle = 0;
      }
    } else if (A.dir && B.dir) {
      angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(Math.abs(A.dir.dot(B.dir)), 0, 1)));
      const seg = segSegClosest(A.a, A.b, B.a, B.b);
      p1 = seg[0]; p2 = seg[1]; distance = p1.distanceTo(p2); kind = 'minimum';
    } else if ((A.normal && B.e.kind === 'edge') || (B.normal && A.e.kind === 'edge')) {
      const F = A.normal ? A : B, E = A.normal ? B : A;
      const d = E.point.clone().sub(F.point).dot(F.normal);
      if (E.dir) angle = 90 - THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(Math.abs(E.dir.dot(F.normal)), 0, 1)));
      if (!E.dir || Math.abs(E.dir.dot(F.normal)) < 1e-3) {
        distance = Math.abs(d);
        const pe = E.point.clone(), pf = pe.clone().addScaledVector(F.normal, -d);
        if (F === A) { p1 = pf; p2 = pe; } else { p1 = pe; p2 = pf; }
        kind = 'to plane';
      }
    } else if (A.axis && B.axis && Math.abs(A.axis.dot(B.axis)) > 0.9999) {
      const w = B.point.clone().sub(A.point);
      const perp = w.clone().addScaledVector(A.axis, -w.dot(A.axis));
      distance = perp.length(); p2 = p1.clone().add(perp); kind = 'axis to axis';
    }
    const delta = p2.clone().sub(p1);
    const res = { a: ia, b: ib, distance, angle_deg: angle, kind, delta: [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)], p1: p1.toArray(), p2: p2.toArray(), source: 'viewer' };
    this.measureResult = res;
    this._mA = A; this._mB = B;
    this._drawMeasure();
    this.dispatchEvent(new CustomEvent('measure', { detail: { picks: this.measurePicks.slice(), result: res } }));
    if (this.opts.measureProvider && this.versionId) {
      const picks = this.measurePicks.slice();
      Promise.resolve(this.opts.measureProvider(ia, ib, this.versionId)).then((api) => {
        if (!api || this.measurePicks.join() !== picks.join() || api.distance == null) return;
        Object.assign(res, { distance: api.distance, angle_deg: api.angle_deg ?? res.angle_deg, source: 'kernel', kind: api.parallel ? 'minimum · parallel' : api.perpendicular ? 'minimum · perpendicular' : 'minimum (exact)', center_distance: api.center_distance });
        const pts = api.closest_points || api.points;
        if (pts && pts.length === 2) { res.p1 = pts[0]; res.p2 = pts[1]; res.delta = pts[0].map((x, i) => Math.abs(pts[1][i] - x)); }
        this._drawMeasure();
        this.dispatchEvent(new CustomEvent('measure', { detail: { picks, result: res } }));
      }).catch(() => {});
    }
  }

  clearMeasure() {
    this.measurePicks = []; this.measureResult = null; this._drawMeasure();
    this.select([]);
    this.dispatchEvent(new CustomEvent('measure', { detail: { picks: [], result: null } }));
  }

  _drawMeasure() {
    const old = this.helpers.getObjectByName('measure');
    if (old) { old.traverse((o) => o.geometry?.dispose()); this.helpers.remove(old); }
    this._clearLabels('measure');
    const r = this.measureResult;
    if (!r) { this._dirty = true; return; }
    const offA = this._mA?.off || new THREE.Vector3(), offB = this._mB?.off || new THREE.Vector3();
    const p1 = V(r.p1).add(offA), p2 = V(r.p2).add(offB);
    const g = new THREE.Group(); g.name = 'measure';
    const lg = new LineSegmentsGeometry(); lg.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
    const line = new LineSegments2(lg, this.overlayLineMats.measure);
    line.renderOrder = 10;
    g.add(line);
    const dotGeo = new THREE.SphereGeometry(1, 16, 12);
    const dotMat = this._dotMat || (this._dotMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, toneMapped: false }));
    for (const p of [p1, p2]) {
      const d = new THREE.Mesh(dotGeo, dotMat);
      d.position.copy(p); d.renderOrder = 11; d.userData.screenSize = 4;
      g.add(d);
    }
    this.helpers.add(g);
    const mid = p1.clone().lerp(p2, 0.5);
    let html = `<b>${fmt(r.distance)}</b> mm`;
    if (r.angle_deg != null && r.angle_deg > 0.05) html += `<i>∠ ${fmt(r.angle_deg, 1)}°</i>`;
    this._addLabel('measure', mid, html, 'vc-label vc-label-measure');
    this._dirty = true;
  }

  // ------------------------------------------------------------ bbox

  setBBox(on) {
    this.state.bbox = !!on;
    this._drawBBox();
    this._emitState();
  }

  _drawBBox() {
    const old = this.helpers.getObjectByName('bbox');
    if (old) { old.traverse((o) => o.geometry?.dispose()); this.helpers.remove(old); }
    this._clearLabels('bbox');
    if (!this.state.bbox || !this.parts.length) { this._dirty = true; return; }
    const b = this._visibleBox();
    const g = new THREE.Group(); g.name = 'bbox';
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(...b.getSize(new THREE.Vector3()).toArray()));
    const mat = this._bboxMat || (this._bboxMat = new THREE.LineDashedMaterial({ color: 0x6b6b6b, dashSize: 1, gapSize: 1, transparent: true, opacity: 0.7 }));
    const s = b.getSize(new THREE.Vector3());
    const dash = s.length() / 120;
    mat.dashSize = dash; mat.gapSize = dash * 0.8;
    const ls = new THREE.LineSegments(geo, mat);
    ls.computeLineDistances();
    ls.position.copy(b.getCenter(new THREE.Vector3()));
    g.add(ls);
    this.helpers.add(g);
    const { min, max } = b;
    this._addLabel('bbox', new THREE.Vector3((min.x + max.x) / 2, min.y, min.z), `<span>X</span>${fmt(s.x)}`, 'vc-label vc-label-dim');
    this._addLabel('bbox', new THREE.Vector3(max.x, (min.y + max.y) / 2, min.z), `<span>Y</span>${fmt(s.y)}`, 'vc-label vc-label-dim');
    this._addLabel('bbox', new THREE.Vector3(max.x, min.y, (min.z + max.z) / 2), `<span>Z</span>${fmt(s.z)}`, 'vc-label vc-label-dim');
    this._dirty = true;
  }

  // ------------------------------------------------------------ labels

  _addLabel(group, pos, html, cls) {
    const e = el('div', cls, html);
    this.labelLayer.appendChild(e);
    this._labels.push({ group, pos: pos.clone(), el: e });
  }
  _clearLabels(group) {
    this._labels = this._labels.filter((l) => { if (l.group === group) { l.el.remove(); return false; } return true; });
  }
  _updateLabels() {
    const v = new THREE.Vector3();
    for (const l of this._labels) {
      v.copy(l.pos).project(this.camera);
      if (v.z > 1 || v.z < -1) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      const x = (v.x * 0.5 + 0.5) * this.width, y = (-v.y * 0.5 + 0.5) * this.height;
      l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
    // keep measure dots a constant screen size
    const m = this.helpers.getObjectByName('measure');
    if (m) {
      for (const o of m.children) if (o.userData.screenSize) {
        const s = this._worldPerPixel(o.position) * o.userData.screenSize;
        o.scale.setScalar(s);
      }
    }
  }
  _worldPerPixel(p) {
    const cam = this.camera;
    if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / this.height;
    const d = cam.position.distanceTo(p);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / this.height;
  }

  // ------------------------------------------------------------ misc

  flash(text) {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toast.classList.remove('on'), 1600);
  }

  toggleHelp(on) {
    const v = on == null ? !this.helpEl.classList.contains('on') : on;
    this.helpEl.classList.toggle('on', v);
  }

  async screenshot({ scale = 2, download = false, name = 'voncad.png' } = {}) {
    const r = this.renderer;
    const prev = r.getPixelRatio();
    r.setPixelRatio(Math.min(prev * scale, 4));
    r.setSize(this.width, this.height, false);
    this.composer?.setPixelRatio(r.getPixelRatio()); this.composer?.setSize(this.width, this.height);
    this._hideCube = true;
    this._shadowDirty = true;
    this.render();
    const url = r.domElement.toDataURL('image/png');
    this._hideCube = false;
    r.setPixelRatio(prev);
    r.setSize(this.width, this.height, false);
    this.composer?.setPixelRatio(prev); this.composer?.setSize(this.width, this.height);
    this._dirty = true;
    if (download) {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
    }
    return url;
  }

  _emitState() {
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }
}

function segSegClosest(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return [p1.clone(), p2.clone()];
  if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den !== 0 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return [p1.clone().addScaledVector(d1, s), p2.clone().addScaledVector(d2, t)];
}

// ================================================================ shared DOM components

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICONS = {
  select: svg('<path d="M5 3.5l13 7.2-5.6 1.6 3.4 6.3-2.2 1.2-3.4-6.3L6 17.4z"/>'),
  measure: svg('<path d="M3.5 15.5l12-12 5 5-12 12z"/><path d="M7 12l2 2M10 9l1.5 1.5M13 6l2 2"/>'),
  section: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M3 12.5l18-3" stroke-dasharray="2 2"/><path d="M4 12.3v4.2L12 21l8-4.5V9.3z" fill="currentColor" fill-opacity=".12" stroke="none"/>'),
  explode: svg('<rect x="9" y="9" width="6" height="6"/><path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3"/><path d="M4 7.5V4h3.5M20 7.5V4h-3.5M4 16.5V20h3.5M20 16.5V20h-3.5"/>'),
  cube: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8.5" y="8.5" width="7" height="7"/>'),
  persp: svg('<path d="M3 7l18-3v16L3 17z"/><path d="M3 12h18" stroke-dasharray="2 2"/>'),
  ortho: svg('<rect x="4" y="5" width="16" height="14"/><path d="M4 12h16" stroke-dasharray="2 2"/>'),
  shaded: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".18"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  bbox: svg('<rect x="4" y="4" width="16" height="16" stroke-dasharray="2.5 2"/><path d="M4 22h16M2 4v16"/>'),
  camera: svg('<path d="M3.5 8h4l1.5-2.5h6L16.5 8h4v11h-17z"/><circle cx="12" cy="13" r="3.5"/>'),
  tree: svg('<path d="M4 5h6M4 12h6M4 19h6"/><rect x="13" y="3" width="7" height="4"/><rect x="13" y="10" width="7" height="4"/><rect x="13" y="17" width="7" height="4"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 014.8.9c0 1.7-2.4 2.1-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  ao: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 000 16" fill="currentColor" fill-opacity=".2"/>'),
  grid: svg('<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svg('<path d="M4 4l16 16"/><path d="M9.9 6A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-2.8 3.5M6.3 7.6C3.9 9.4 2.5 12 2.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1"/>'),
  target: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>'),
  flip: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M8 7L3 12l5 5zM16 7l5 5-5 5z"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  // operation glyphs for the steps timeline
  op_sketch: svg('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>'),
  op_extrude: svg('<path d="M5 15l7 4 7-4-7-4z"/><path d="M5 15V8l7-4 7 4v7" stroke-dasharray="2 2"/><path d="M12 11V4"/><path d="M10 6l2-2 2 2"/>'),
  op_revolve: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M17 7a6 3 0 11-10 0"/><path d="M7 7l-1.5 2.5M7 7l2.5 1"/>'),
  op_fillet: svg('<path d="M4 20V10a6 6 0 016-6h10"/><path d="M4 4h4M4 4v4" stroke-opacity=".4"/>'),
  op_chamfer: svg('<path d="M4 20V10l6-6h10"/><path d="M4 4h4M4 4v4" stroke-opacity=".4"/>'),
  op_hole: svg('<ellipse cx="12" cy="7" rx="6" ry="2.5"/><path d="M6 7v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7"/><path d="M9 8.6v8" stroke-dasharray="1.5 2"/>'),
  op_boolean: svg('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
  op_cut: svg('<rect x="3.5" y="6" width="17" height="12"/><circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity=".25"/>'),
  op_shell: svg('<path d="M4 7h16v13H4z"/><path d="M7 7v10h10V7"/>'),
  op_pattern: svg('<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/>'),
  op_mirror: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5zM15 7l5 10h-5z"/>'),
  op_loft: svg('<path d="M6 18h12M8 6h8"/><path d="M6 18L8 6M18 18L16 6"/>'),
  op_primitive: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  op_step: svg('<circle cx="12" cy="12" r="3.5"/>'),
};

export function opIcon(op = '') {
  const o = String(op).toLowerCase();
  const map = [
    [/sketch|line|polyline|circle|rect|make_face|polygon|arc/, 'op_sketch'],
    [/extrude|prism/, 'op_extrude'], [/revolve/, 'op_revolve'], [/fillet/, 'op_fillet'], [/chamfer/, 'op_chamfer'],
    [/hole|bore|counter/, 'op_hole'], [/subtract|cut|split/, 'op_cut'], [/union|add|fuse|boolean|intersect/, 'op_boolean'],
    [/shell|offset/, 'op_shell'], [/pattern|polar|grid|array|locations/, 'op_pattern'], [/mirror/, 'op_mirror'],
    [/loft|sweep/, 'op_loft'], [/box|cylinder|sphere|cone|torus|primitive|wedge/, 'op_primitive'],
  ];
  for (const [re, k] of map) if (re.test(o)) return ICONS[k];
  return ICONS.op_step;
}

/** Floating toolbar. items: list of keys or '|' separators. */
export function mountToolbar(viewer, root, items = ['select', 'measure', 'section', 'explode', '|', 'views', 'fit', 'projection', '|', 'render', 'bbox', 'screenshot', 'help']) {
  root.classList.add('vc-toolbar');
  const btns = {};
  const pops = [];
  const closePops = (except) => pops.forEach((p) => { if (p !== except) p.classList.remove('on'); });
  document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) closePops(); });
  const mk = (key, icon, title, onClick) => {
    const b = el('button', 'vc-tb', icon);
    b.title = title; b.setAttribute('aria-label', title); b.dataset.key = key;
    b.addEventListener('click', onClick);
    btns[key] = b;
    return b;
  };
  const withPop = (btn, pop) => {
    const wrap = el('div', 'vc-tbw');
    pop.classList.add('vc-pop');
    wrap.append(btn, pop);
    pops.push(pop);
    btn.addEventListener('click', () => { const on = !pop.classList.contains('on'); closePops(); pop.classList.toggle('on', on); });
    return wrap;
  };
  for (const key of items) {
    if (key === '|') { root.appendChild(el('span', 'vc-tbsep')); continue; }
    if (key === 'select') root.appendChild(mk('select', ICONS.select, 'Select (Esc)', () => viewer.setTool('select')));
    else if (key === 'measure') root.appendChild(mk('measure', ICONS.measure, 'Measure (M)', () => viewer.setTool(viewer.state.tool === 'measure' ? 'select' : 'measure')));
    else if (key === 'section') {
      const b = mk('section', ICONS.section, 'Section plane (S)', () => {});
      const pop = el('div', '', `
        <div class="vc-pop-h"><span>Section</span><label class="vc-switch"><input type="checkbox" data-k="on"><i></i></label></div>
        <div class="vc-seg" data-k="axis"><button data-v="x">X</button><button data-v="y">Y</button><button data-v="z">Z</button><button data-v="face" title="Use selected planar face">Face</button></div>
        <input type="range" min="0" max="1" step="0.001" data-k="offset">
        <div class="vc-pop-row"><span class="vc-mono" data-k="val">—</span><button class="vc-mini" data-k="flip">${ICONS.flip}<span>Flip</span></button></div>`);
      pop.querySelector('[data-k=on]').addEventListener('change', (e) => viewer.setSection({ enabled: e.target.checked }));
      pop.querySelectorAll('[data-k=axis] button').forEach((x) => x.addEventListener('click', () => {
        const v = x.dataset.v;
        if (v === 'face') {
          const f = viewer.selection.find((id) => viewer.getEntity(id)?.normal);
          if (!f) { viewer.flash('Select a planar face first'); return; }
          viewer.setSection({ face: f });
        } else viewer.setSection({ axis: v, enabled: true });
      }));
      pop.querySelector('[data-k=offset]').addEventListener('input', (e) => viewer.setSection({ offset: +e.target.value, enabled: true }));
      pop.querySelector('[data-k=flip]').addEventListener('click', () => viewer.setSection({ flip: !viewer.state.section.flip }));
      root.appendChild(withPop(b, pop));
      b._pop = pop;
    } else if (key === 'explode') {
      const b = mk('explode', ICONS.explode, 'Explode (X)', () => {});
      const pop = el('div', '', `<div class="vc-pop-h"><span>Explode</span><span class="vc-mono" data-k="val">0%</span></div><input type="range" min="0" max="1" step="0.005" data-k="t">`);
      pop.querySelector('[data-k=t]').addEventListener('input', (e) => viewer.setExplode(+e.target.value));
      root.appendChild(withPop(b, pop));
      b._pop = pop;
    } else if (key === 'views') {
      const b = mk('views', ICONS.cube, 'Standard views (1–7)', () => {});
      const pop = el('div', 'vc-menu');
      VIEW_KEYS.forEach((v, i) => {
        const it = el('button', 'vc-menu-it', `<span>${v[0].toUpperCase() + v.slice(1)}</span><kbd>${i + 1}</kbd>`);
        it.addEventListener('click', () => { viewer.setView(v); closePops(); });
        pop.appendChild(it);
      });
      root.appendChild(withPop(b, pop));
    } else if (key === 'fit') root.appendChild(mk('fit', ICONS.fit, 'Fit (F)', () => viewer.fit()));
    else if (key === 'projection') root.appendChild(mk('projection', ICONS.persp, 'Perspective / orthographic (P)', () => viewer.setProjection(viewer.state.projection === 'perspective' ? 'orthographic' : 'perspective')));
    else if (key === 'render') {
      const b = mk('render', ICONS.shaded, 'Render mode (W)', () => {});
      const pop = el('div', 'vc-menu');
      for (const [k, label] of RENDER_MODES) {
        const it = el('button', 'vc-menu-it', `<span>${label}</span>`);
        it.dataset.mode = k;
        it.addEventListener('click', () => { viewer.setRenderMode(k); closePops(); });
        pop.appendChild(it);
      }
      pop.appendChild(el('div', 'vc-menu-sep'));
      for (const [k, label] of [['grid', 'Grid'], ['shadow', 'Ground shadow'], ['ao', 'Ambient occlusion']]) {
        const it = el('button', 'vc-menu-it vc-check', `<span>${label}</span><i></i>`);
        it.dataset.toggle = k;
        it.addEventListener('click', () => {
          if (k === 'grid') viewer.setGrid(!viewer.state.grid);
          else if (k === 'shadow') viewer.setShadow(!viewer.state.shadow);
          else viewer.setAO(!viewer.state.ao);
        });
        pop.appendChild(it);
      }
      root.appendChild(withPop(b, pop));
      b._pop = pop;
    } else if (key === 'bbox') root.appendChild(mk('bbox', ICONS.bbox, 'Bounding box (B)', () => viewer.setBBox(!viewer.state.bbox)));
    else if (key === 'screenshot') root.appendChild(mk('screenshot', ICONS.camera, 'Screenshot PNG', () => viewer.screenshot({ download: true, name: (viewer.sceneData?.name || 'voncad') + '.png' })));
    else if (key === 'help') root.appendChild(mk('help', ICONS.help, 'Shortcuts (?)', () => viewer.toggleHelp()));
    else if (typeof key === 'object') root.appendChild(mk(key.key, key.icon, key.title, key.onClick));
  }
  const sync = () => {
    const s = viewer.state;
    btns.select?.classList.toggle('on', s.tool === 'select');
    btns.measure?.classList.toggle('on', s.tool === 'measure');
    btns.bbox?.classList.toggle('on', s.bbox);
    btns.section?.classList.toggle('on', s.section.enabled);
    btns.explode?.classList.toggle('on', s.explode > 0.001);
    if (btns.projection) btns.projection.innerHTML = s.projection === 'perspective' ? ICONS.persp : ICONS.ortho;
    const sp = btns.section?._pop;
    if (sp) {
      sp.querySelector('[data-k=on]').checked = s.section.enabled;
      sp.querySelectorAll('[data-k=axis] button').forEach((x) => x.classList.toggle('on', s.section.axis === x.dataset.v || (x.dataset.v === 'face' && s.section.axis === 'custom')));
      const r = sp.querySelector('[data-k=offset]');
      if (document.activeElement !== r) r.value = s.section.offset;
      sp.querySelector('[data-k=val]').textContent = s.section.enabled && viewer.sectionValue != null ? `${s.section.axis === 'custom' ? 'd' : s.section.axis.toUpperCase()} = ${fmt(viewer.sectionValue)} mm` : 'off';
    }
    const ep = btns.explode?._pop;
    if (ep) {
      const r = ep.querySelector('[data-k=t]');
      if (document.activeElement !== r) r.value = s.explode;
      ep.querySelector('[data-k=val]').textContent = Math.round(s.explode * 100) + '%';
    }
    const rp = btns.render?._pop;
    if (rp) {
      rp.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === s.renderMode));
      rp.querySelectorAll('[data-toggle]').forEach((x) => x.classList.toggle('on', !!s[x.dataset.toggle]));
    }
  };
  viewer.addEventListener('statechange', sync);
  viewer.addEventListener('load', () => {
    if (btns.explode) btns.explode.parentElement.style.display = viewer.parts.length > 1 ? '' : 'none';
    sync();
  });
  sync();
  return { buttons: btns, sync };
}

/** Part tree: swatch, name, id, show/hide, isolate. */
export class PartTree {
  constructor(viewer, root) {
    this.viewer = viewer; this.root = root;
    root.classList.add('vc-tree');
    viewer.addEventListener('load', () => this.render());
    viewer.addEventListener('partschange', () => this.render());
    viewer.addEventListener('selectionchange', () => this.sync());
    this.render();
  }
  render() {
    const v = this.viewer;
    const parts = v.partList();
    this.root.innerHTML = '';
    if (!parts.length) { this.root.innerHTML = '<div class="vc-empty">No parts</div>'; return; }
    for (const p of parts) {
      const row = el('div', 'vc-tree-row' + (p.visible ? '' : ' off'));
      row.dataset.id = p.id;
      row.innerHTML = `<span class="vc-sw" style="background:${p.color}"></span><span class="vc-tree-name" title="${p.name}">${p.name}</span><span class="vc-tree-id">${p.id}</span>
        <button class="vc-ib" data-a="iso" title="Isolate">${ICONS.target}</button><button class="vc-ib" data-a="vis" title="${p.visible ? 'Hide' : 'Show'}">${p.visible ? ICONS.eye : ICONS.eyeOff}</button>`;
      row.addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'vis') v.setPartVisible(p.id, !p.visible);
        else if (a === 'iso') {
          const only = parts.every((q) => (q.id === p.id) === q.visible);
          only ? v.showAll() : v.isolate(p.id);
        } else v.select(e.shiftKey ? [...v.selection, p.id] : [p.id]);
      });
      this.root.appendChild(row);
    }
    this.sync();
  }
  sync() {
    const sel = new Set(this.viewer.selection.map((id) => id.split('/')[0]));
    this.root.querySelectorAll('.vc-tree-row').forEach((r) => r.classList.toggle('sel', sel.has(r.dataset.id)));
  }
}

/** Selection inspector with "Copy reference". */
export class SelectionPanel {
  constructor(viewer, root, { onLook, onSection } = {}) {
    this.viewer = viewer; this.root = root;
    root.classList.add('vc-sel');
    viewer.addEventListener('selectionchange', () => this.render());
    viewer.addEventListener('measure', () => this.render());
    viewer.addEventListener('statechange', () => this.render());
    this.render();
  }
  render() {
    const v = this.viewer;
    const ids = v.selection;
    const m = v.measureResult;
    const measuring = v.state.tool === 'measure';
    if (!ids.length) {
      this.root.innerHTML = `<div class="vc-sel-empty">${measuring ? 'Pick two faces or edges to measure.' : 'Click a face or edge. <span>Shift</span> adds to the selection. The ids are what an agent sees.'}</div>`;
      return;
    }
    const rows = (pairs) => pairs.filter(([, val]) => val != null && val !== '—').map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
    let body = '';
    if (m && measuring) {
      body += `<div class="vc-measure"><div class="vc-measure-v">${fmt(m.distance, 3)}<small>mm</small></div>
        <dl>${rows([['Kind', m.kind], ['Angle', m.angle_deg != null ? fmt(m.angle_deg, 2) + '°' : null], ['ΔX ΔY ΔZ', fmtVec(m.delta)], ['Source', m.source === 'kernel' ? 'kernel (exact)' : 'viewer']])}</dl></div>`;
    }
    if (ids.length === 1 || (ids.length === 2 && measuring)) {
      for (const id of ids) {
        const e = v.getEntity(id);
        if (!e) continue;
        let pairs;
        if (e.kind === 'face') pairs = [['Type', e.type], ['Area', fmt(e.area, 3) + ' mm²'], ['Radius', e.radius != null ? fmt(e.radius, 3) + ' mm' : null], ['Diameter', e.radius != null ? '⌀ ' + fmt(e.radius * 2, 3) : null], ['Normal', e.normal ? fmtVec(e.normal, 3) : null], ['Axis', e.axis ? fmtVec(e.axis, 3) : null], ['Center', fmtVec(e.center)], ['Part', e.partName]];
        else if (e.kind === 'edge') pairs = [['Type', e.type], ['Length', fmt(e.length, 3) + ' mm'], ['Radius', e.radius != null ? fmt(e.radius, 3) + ' mm' : null], ['Center', e.center ? fmtVec(e.center) : null], ['Start', fmtVec(e.start)], ['End', fmtVec(e.end)], ['Part', e.partName]];
        else pairs = [['Name', e.name], ['Faces', e.faces], ['Edges', e.edges], ['Triangles', e.triangles.toLocaleString()], ['Size', fmtVec(e.bbox.size)], ['Area', fmt(e.area, 1) + ' mm²'], ['Volume', fmt(e.volume / 1000, 3) + ' cm³']];
        body += `<div class="vc-ent"><div class="vc-ent-h"><span class="vc-ent-id">${id}</span><span class="vc-ent-k">${e.kind}</span></div><dl>${rows(pairs)}</dl></div>`;
      }
    } else {
      let area = 0, len = 0, nf = 0, ne = 0;
      for (const id of ids) {
        const e = v.getEntity(id);
        if (e?.kind === 'face') { area += e.area || 0; nf++; } else if (e?.kind === 'edge') { len += e.length || 0; ne++; }
      }
      body += `<div class="vc-ent"><div class="vc-ent-h"><span class="vc-ent-id">${ids.length} selected</span></div><div class="vc-chips">${ids.map((i) => `<span>${i}</span>`).join('')}</div>
        <dl>${rows([['Faces', nf || null], ['Total area', nf ? fmt(area, 3) + ' mm²' : null], ['Edges', ne || null], ['Total length', ne ? fmt(len, 3) + ' mm' : null]])}</dl></div>`;
    }
    const one = ids.length === 1 ? v.getEntity(ids[0]) : null;
    body += `<div class="vc-sel-actions">
      <button class="vc-btn vc-btn-dark" data-a="copy">${ICONS.copy}<span>Copy reference</span></button>
      ${one && one.kind === 'face' && (one.normal || one.axis) ? `<button class="vc-btn" data-a="look" title="Look normal to face">${ICONS.target}</button>` : ''}
      ${one && one.kind === 'face' && one.normal ? `<button class="vc-btn" data-a="section" title="Section on this face">${ICONS.section}</button>` : ''}
    </div>`;
    this.root.innerHTML = body;
    this.root.querySelector('[data-a=copy]')?.addEventListener('click', async (e) => {
      const text = ids.join(', ');
      try { await navigator.clipboard.writeText(text); } catch (err) {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const b = e.currentTarget.querySelector('span');
      b.textContent = 'Copied ' + text.slice(0, 28) + (text.length > 28 ? '…' : '');
      setTimeout(() => { b.textContent = 'Copy reference'; }, 1400);
    });
    this.root.querySelector('[data-a=look]')?.addEventListener('click', () => v.lookAtFace(ids[0]));
    this.root.querySelector('[data-a=section]')?.addEventListener('click', () => v.setSection({ face: ids[0] }));
  }
}

/** Paint the filled part of a range input (webkit has no progress pseudo-element). */
export function paintRange(r) {
  const min = +r.min || 0, max = +r.max || 1;
  r.style.setProperty('--fill', ((+r.value - min) / (max - min || 1)) * 100 + '%');
}
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => { if (e.target?.type === 'range') paintRange(e.target); }, true);
}

/**
 * Steps timeline: replays how a model was built, one operation at a time.
 * steps: [{index, op, description, volume, faces, scene_url}]. `loadStepScene(step)` returns a scene
 * (or null). The previous step is ghosted behind the current one so added/removed material reads clearly.
 */
export class StepsBar {
  constructor(viewer, root, { loadStepScene, onChange } = {}) {
    this.viewer = viewer; this.root = root;
    this.loadStepScene = loadStepScene;
    this.onChange = onChange;
    this.steps = [];
    this.cache = new Map();
    this.current = -1;
    this.final = null;
    root.classList.add('vc-steps');
    root.innerHTML = `
      <div class="vc-steps-head">
        <button class="vc-steps-play" title="Replay build">${ICONS.play}</button>
        <div class="vc-steps-cap"><span class="vc-steps-n"></span><span class="vc-steps-d"></span></div>
        <span class="vc-steps-meta"></span>
        <button class="vc-steps-final vc-mini" title="Show final model">Final</button>
      </div>
      <div class="vc-steps-track"></div>`;
    this.track = root.querySelector('.vc-steps-track');
    this.playBtn = root.querySelector('.vc-steps-play');
    this.playBtn.addEventListener('click', () => (this.playing ? this.stop() : this.play()));
    root.querySelector('.vc-steps-final').addEventListener('click', () => this.showFinal());
    root.hidden = true;
  }

  setSteps(steps, { finalScene = null } = {}) {
    this.stop();
    this.steps = Array.isArray(steps) ? steps.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
    this.cache.clear();
    this.final = finalScene;
    this.current = this.steps.length - 1;
    this.root.hidden = this.steps.length < 2;
    this.track.innerHTML = '';
    this.steps.forEach((s, i) => {
      const b = el('button', 'vc-step', `${opIcon(s.icon || s.op)}<span class="vc-step-i">${i + 1}</span><span class="vc-step-op">${(s.label || s.op || 'step').replace(/_/g, ' ')}</span>`);
      b.title = s.description || s.op || '';
      const avail = !!s.scene_url || i === this.steps.length - 1;
      if (!avail) b.classList.add('na');
      b.addEventListener('click', () => this.go(i));
      this.track.appendChild(b);
    });
    this._caption();
  }

  async _scene(i) {
    if (i < 0 || i >= this.steps.length) return null;
    if (this.cache.has(i)) return this.cache.get(i);
    const s = this.steps[i];
    let sc = null;
    if (s.scene) sc = s.scene;
    else if (i === this.steps.length - 1 && this.final) sc = this.final;
    else if (s.scene_url && this.loadStepScene) {
      try { sc = await this.loadStepScene(s); } catch (e) { sc = null; }
    }
    this.cache.set(i, sc);
    return sc;
  }

  async go(i) {
    if (i === this.current && !this.playing) return;
    const sc = await this._scene(i);
    if (!sc) { this.viewer.flash('Save the model to replay its steps'); return; }
    this.current = i;
    const isFinal = i === this.steps.length - 1;
    this.viewer.loadScene(sc, { keepCamera: true, versionId: this.viewer.versionId });
    const prev = i > 0 ? await this._scene(i - 1) : null;
    this.viewer.setGhost(isFinal ? null : prev);
    this._caption();
    this.onChange?.(i, this.steps[i]);
  }

  showFinal() { this.stop(); this.go(this.steps.length - 1); }

  async play() {
    if (this.steps.length < 2) return;
    this.playing = true;
    this.playBtn.innerHTML = ICONS.pause;
    this.root.classList.add('playing');
    let i = this.current >= this.steps.length - 1 ? 0 : this.current + 1;
    while (this.playing && i < this.steps.length) {
      const sc = await this._scene(i);
      if (sc) { this.current = -2; await this.go(i); }
      await new Promise((r) => setTimeout(r, 1100));
      i++;
    }
    this.stop();
  }

  stop() {
    this.playing = false;
    this.playBtn.innerHTML = ICONS.play;
    this.root.classList.remove('playing');
  }

  _caption() {
    const s = this.steps[this.current];
    this.track.querySelectorAll('.vc-step').forEach((b, k) => {
      b.classList.toggle('on', k === this.current);
      b.classList.toggle('past', k < this.current);
    });
    if (!s) return;
    this.root.querySelector('.vc-steps-n').textContent = `Step ${this.current + 1} / ${this.steps.length}`;
    this.root.querySelector('.vc-steps-d').textContent = s.description || s.op || '';
    const meta = [];
    if (s.volume != null) meta.push(`${fmt(s.volume / 1000, 2)} cm³`);
    if (s.faces != null) meta.push(`${s.faces} faces`);
    this.root.querySelector('.vc-steps-meta').textContent = meta.join(' · ');
    this.root.querySelector('.vc-steps-final').classList.toggle('on', this.current === this.steps.length - 1);
    this.track.querySelector('.vc-step.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}
