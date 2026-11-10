/* ==========================================================
   JERCAT — Clip publicitaire premium
   script.js — Three.js (3D, particules, post-traitement),
   GSAP (caméra & typographie), Web Audio (musique, effets),
   Web Speech (voix off française)
   ========================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const gsap = window.gsap;

/* Laisse d'abord le navigateur afficher l'écran de chargement (aperçu + logo),
   puis lance les calculs 3D : l'écran n'est plus figé pendant la préparation */
try {
  await Promise.race([
    Promise.all([document.fonts.load('700 64px "Space Grotesk"'), document.fonts.load('400 11px Inter')]),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
} catch (e) { /* police de secours */ }
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ==========================================================
   1. CONFIGURATION
   ========================================================== */
const params = new URLSearchParams(location.search);
const RECORD = params.has('record');          // ?record  → interface masquée, idéal pour enregistrer une vidéo
const LOOP = params.has('loop');              // ?loop    → le clip recommence automatiquement
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = matchMedia('(pointer: coarse)').matches;
const SMALL = Math.min(innerWidth, innerHeight) < 700;
const CORES = navigator.hardwareConcurrency || 4;

const QUALITY = {
  high: { particles: 9000, dpr: 2,    bokeh: true,  nodes: 220, pulses: 170, streams: 90, afterimage: true,  bloomScale: 1,    texScale: 1,    fps: 0,  minScale: 0.6,  maxPoint: 70 },
  mid:  { particles: 6500, dpr: 1.5,  bokeh: true,  nodes: 170, pulses: 120, streams: 70, afterimage: true,  bloomScale: 1,    texScale: 1,    fps: 0,  minScale: 0.6,  maxPoint: 70 },
  low:  { particles: 3600, dpr: 1.25, bokeh: false, nodes: 110, pulses: 70,  streams: 40, afterimage: true,  bloomScale: 0.75, texScale: 0.75, fps: 60, minScale: 0.6,  maxPoint: 56 },
  lite: { particles: 2400, dpr: 1,    bokeh: false, nodes: 80,  pulses: 48,  streams: 28, afterimage: false, bloomScale: 0.5,  texScale: 0.6,  fps: 60, minScale: 0.55, maxPoint: 46 },
  soft: { particles: 1800, dpr: 0.5,  bokeh: false, nodes: 60,  pulses: 36,  streams: 20, afterimage: false, bloomScale: 0.5,  texScale: 0.5,  fps: 30, minScale: 0.5,  maxPoint: 36 },
};

/* ----------------------------------------------------------
   MODE MOBILE INTELLIGENT : profil de l'appareil
   Puce graphique (GPU), mémoire et processeur → niveau de qualité.
   ?quality=high|mid|low|lite|soft force un niveau (tests).
   ---------------------------------------------------------- */
const UA = navigator.userAgent || '';
const IS_ANDROID = /Android/i.test(UA);
const IS_MOBILE = IS_ANDROID || /iPhone|iPad|iPod/i.test(UA) || COARSE;
const MEMORY = navigator.deviceMemory || 4;   // Go (Chrome Android : 0,5 à 8)

const GL_PROBE = (() => {
  try {
    const c = document.createElement('canvas');
    const gl = window.WebGL2RenderingContext && c.getContext('webgl2');
    if (!gl) return { ok: false, gpu: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();             // libère tout de suite ce contexte de test
    return { ok: true, gpu };
  } catch (e) {
    return { ok: false, gpu: '' };
  }
})();

/* Classe de la puce graphique : soft (rendu logiciel), low, mid, high, desktop */
function gpuClass(name) {
  const r = name.toLowerCase();
  let m;
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(r)) return 'soft';
  if (/apple|immortalis|xclipse/.test(r)) return 'high';
  if ((m = r.match(/adreno[^\d]*(\d{3})/))) {
    const n = Number(m[1]);
    if (n >= 725 || (n >= 650 && n < 700)) return 'high';   // Snapdragon 8 Gen x, 865/888… (Galaxy S, Poco F)
    if (n >= 618) return 'mid';                             // Snapdragon 7xx/6 Gen (Galaxy A5x, Redmi Note Pro)
    return 'low';                                           // Snapdragon 4xx/6xx d'entrée (Galaxy A0x/A1x, Redmi)
  }
  if ((m = r.match(/mali-g(\d+)/))) {
    const n = Number(m[1]);
    if (n >= 600 || (n >= 76 && n < 100)) return 'high';    // G710/G715/G76/G77/G78 (Dimensity haut de gamme, Exynos)
    if (n >= 68) return 'mid';                              // G68/G72 (Galaxy A3x/A5x Exynos, Dimensity 1080)
    return 'low';                                           // G52/G57/G31/G51 (Helio G85-G99 : Redmi, Realme, Oppo A)
  }
  if (/mali|powervr|ge8\d{3}|vivante|videocore/.test(r)) return 'low';
  return IS_MOBILE ? 'unknown' : 'desktop';
}

const GPU = gpuClass(GL_PROBE.gpu);

function detectTier() {
  if (QUALITY[params.get('quality')]) return params.get('quality');
  if (GPU === 'soft') return 'soft';
  if (!IS_MOBILE && !SMALL) return CORES >= 8 ? 'high' : 'mid';
  // Téléphones et tablettes
  if (MEMORY <= 2 || CORES <= 4) return 'lite';
  if (GPU === 'high' || GPU === 'mid') return 'low';      // même qualité qu'avant, avec 60 i/s garanties
  if (GPU === 'low') return 'lite';
  return MEMORY >= 6 ? 'low' : 'lite';
}

const TIER = detectTier();
const Q = { ...QUALITY[TIER] };
if (REDUCED) { Q.bokeh = false; Q.afterimage = false; }

/* Effets CSS allégés sur mobile (flous d'arrière-plan, modes de fusion…) */
const LITE_FX = IS_MOBILE || TIER === 'lite' || TIER === 'soft';
document.documentElement.classList.add(`perf-${TIER}`);
if (LITE_FX) document.documentElement.classList.add('fx-lite');

const COLORS = {
  cyan:   new THREE.Color('#3ee8ff'),
  blue:   new THREE.Color('#4f8bff'),
  violet: new THREE.Color('#9b6bff'),
  white:  new THREE.Color('#ffffff'),
  mint:   new THREE.Color('#3dffb4'),
};

/* Minutage des scènes (secondes) */
const T = { s1: 0, s2: 6, s3: 12.5, s4: 20, s5: 26.5, s6: 35, end: 44 };

/* Voix off */
const VOICE = [
  { t: 0.8,          text: 'Jercat. Développeur web freelance.' },
  { t: T.s2 + 0.4,   text: "Aujourd'hui, vos clients vous cherchent en ligne." },
  { t: T.s3 + 0.3,   text: 'Je crée des sites web sur mesure, qui travaillent pour vous, jour et nuit.' },
  { t: T.s4 + 0.3,   text: 'Rapides, sécurisés, et pensés pour Google.' },
  { t: T.s5 + 0.3,   text: 'Livré en sept jours. Devis gratuit sous vingt-quatre heures. À partir de quatre-vingt-dix-neuf euros.' },
  { t: T.s6 + 0.6,   text: 'Votre site web, créé par Jercat. Demandez votre devis gratuit sur dev point jercat point f r.' },
];
/* Voix off enregistrée : un fichier MP3 par réplique (dossier voix/).
   Elle est jouée par le moteur audio du site, comme la musique : on l'entend
   sur le site ET elle est incluse dans la vidéo téléchargée. */
const VOICE_VERSION = '20261110';
VOICE.forEach((line, i) => { line.index = i; line.file = `voix/voix-${i + 1}.mp3?v=${VOICE_VERSION}`; });

/* Positions clés dans le monde 3D */
const POS = {
  logo:   new THREE.Vector3(0, 0.3, 0),
  panels: new THREE.Vector3(0, 0.2, -100),
  holo:   new THREE.Vector3(0, 0, -160),
  outro:  new THREE.Vector3(0, 4.6, -200),
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ==========================================================
   2. VÉRIFICATIONS
   ========================================================== */
function webglAvailable() {
  return GL_PROBE.ok;   // test fait une seule fois, au démarrage (voir MODE MOBILE INTELLIGENT)
}

if (!gsap || !webglAvailable()) {
  $('#loader').style.display = 'none';
  $('#webglError').hidden = false;
  throw new Error('GSAP ou WebGL2 indisponible');
}


const loaderBar = $('#loaderBar');
const setLoad = (p) => { loaderBar.style.width = `${Math.round(p * 100)}%`; };
setLoad(0.1);

/* ==========================================================
   3. RENDU THREE.JS
   ========================================================== */
const canvas = $('#webgl');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  stencil: false,
});
let pixelRatio = Math.min(window.devicePixelRatio || 1, Q.dpr);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x03040a, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x03040a, 0.012);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 420);
camera.position.set(0, 0, 26);

/* Environnement pour les reflets métalliques */
/* Calculé après le démarrage, pendant un temps mort (l'hologramme n'apparaît qu'à 20 s) :
   le chargement n'attend plus ce calcul lourd */
function buildEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
  // Précompile tout de suite les matériaux métalliques avec ces reflets (évite un à-coup à 20 s)
  const wasVisible = holo.visible;
  holo.visible = true;
  try { renderer.compile(holo, camera, scene); } catch (e) { /* compilé au premier affichage */ }
  holo.visible = wasVisible;
}

scene.add(new THREE.HemisphereLight(0x6fa8ff, 0x05060f, 0.35));
const keyLight = new THREE.PointLight(0x3ee8ff, 60, 60, 2);
keyLight.position.set(6, 6, -150);
scene.add(keyLight);
const rimLight = new THREE.PointLight(0x9b6bff, 60, 60, 2);
rimLight.position.set(-7, -3, -166);
scene.add(rimLight);

/* ==========================================================
   4. OUTILS GÉNÉRIQUES (points lumineux)
   ========================================================== */
const glowVertex = /* glsl */`
  attribute vec3 aColor;
  attribute float aScale;
  attribute float aAlpha;
  uniform float uSize;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(uSize * uPixelRatio * aScale / -mv.z, 90.0 * uPixelRatio);
    vColor = aColor;
    vAlpha = aAlpha * smoothstep(0.3, 2.5, -mv.z);
  }
`;

const glowFragment = /* glsl */`
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float glow = pow(core, 2.2);
    vec3 col = vColor * (glow * 1.3 + pow(core, 9.0) * 1.6);
    gl_FragColor = vec4(col, glow * vAlpha * uOpacity);
  }
`;

const glowMaterials = [];
function glowMaterial(size = 60, opacity = 1) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: size },
      uPixelRatio: { value: pixelRatio },
      uOpacity: { value: opacity },
    },
    vertexShader: glowVertex,
    fragmentShader: glowFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  glowMaterials.push(m);
  return m;
}

function makeGlowPoints(count, { size = 60, opacity = 1, color = COLORS.cyan, scale = 1 } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const scl = new Float32Array(count).fill(scale);
  const alp = new Float32Array(count).fill(1);
  for (let i = 0; i < count; i++) {
    col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aScale', new THREE.BufferAttribute(scl, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
  const pts = new THREE.Points(geo, glowMaterial(size, opacity));
  pts.frustumCulled = false;
  return pts;
}

function pickColor() {
  const r = Math.random();
  if (r < 0.42) return COLORS.cyan;
  if (r < 0.70) return COLORS.blue;
  if (r < 0.90) return COLORS.violet;
  return COLORS.white;
}

/* ==========================================================
   5. PARTICULES PRINCIPALES (champ + morphing du logo)
   ========================================================== */
const particleUniforms = {
  uTime: { value: 0 },
  uMorph: { value: 0 },
  uSize: { value: Q.particles < 5000 ? 95 : 72 },
  uPixelRatio: { value: pixelRatio },
  uMouse: { value: new THREE.Vector3(999, 999, 999) },
  uMouseStrength: { value: 1 },
  uTargetOffset: { value: POS.logo.clone() },
  uTargetScale: { value: 0.85 },
  uOpacity: { value: 1 },
  uMaxSize: { value: Q.maxPoint },   // taille maxi d'une particule (px) : limite la surcharge du GPU sur mobile
};

const particleGeo = new THREE.BufferGeometry();
{
  const n = Q.particles;
  const pos = new Float32Array(n * 3);
  const tgt = new Float32Array(n * 3);
  const rnd = new Float32Array(n);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 84;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 40;
    pos[i * 3 + 2] = 32 - Math.random() * 262;
    rnd[i] = Math.random();
    const c = pickColor();
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  particleGeo.setAttribute('aTarget', new THREE.BufferAttribute(tgt, 3));
  particleGeo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 1));
  particleGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
}

const particleMat = new THREE.ShaderMaterial({
  uniforms: particleUniforms,
  vertexShader: /* glsl */`
    uniform float uTime;
    uniform float uMorph;
    uniform float uSize;
    uniform float uPixelRatio;
    uniform vec3 uMouse;
    uniform float uMouseStrength;
    uniform vec3 uTargetOffset;
    uniform float uTargetScale;
    uniform float uMaxSize;
    attribute vec3 aTarget;
    attribute float aRandom;
    attribute vec3 aColor;
    varying vec3 vColor;
    varying float vAlpha;

    void main() {
      float inLogo = step(aRandom, 0.8);
      float m = clamp(uMorph * 1.6 - aRandom * 0.6, 0.0, 1.0);
      m = m * m * (3.0 - 2.0 * m) * inLogo;

      vec3 drift = vec3(
        sin(uTime * 0.25 + aRandom * 40.0),
        cos(uTime * 0.21 + aRandom * 31.0),
        sin(uTime * 0.17 + aRandom * 17.0)
      ) * (0.6 + aRandom);

      vec3 p = mix(position + drift, aTarget * uTargetScale + uTargetOffset + drift * 0.035, m);

      // Tourbillon pendant la transformation
      float swirl = sin(m * 3.14159);
      float ang = aRandom * 6.28318 + uTime * 1.3;
      p.x += sin(ang) * swirl * 2.2;
      p.y += cos(ang) * swirl * 1.4;
      p.z += sin(ang * 0.7) * swirl * 3.0;

      // Interaction souris : répulsion douce
      vec3 d = p - uMouse;
      float dist = length(d);
      float force = (1.0 - smoothstep(0.0, 4.5, dist)) * uMouseStrength;
      p += normalize(d + vec3(0.0001)) * force * 2.4;

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;

      float twinkle = 0.62 + 0.38 * sin(uTime * 2.2 + aRandom * 60.0);
      gl_PointSize = min(uSize * uPixelRatio * (0.32 + aRandom * 0.9) * mix(1.0, 0.7, m) / -mv.z, uMaxSize * uPixelRatio);

      vColor = mix(aColor, vec3(0.78, 0.96, 1.0), m * 0.55) * (1.0 + force * 2.5);
      vAlpha = mix(twinkle * 0.8, 1.0, m) * smoothstep(0.4, 3.0, -mv.z);
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uOpacity;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      float core = 1.0 - smoothstep(0.0, 0.5, d);
      float glow = pow(core, 2.0);
      vec3 col = vColor * (glow * 1.25 + pow(core, 10.0) * 1.8);
      gl_FragColor = vec4(col, glow * vAlpha * uOpacity);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const particles = new THREE.Points(particleGeo, particleMat);
particles.frustumCulled = false;
scene.add(particles);

/* Échantillonne le texte "JERCAT" pour la forme du logo */
let logoWidthUsed = 0;
function logoWidthForViewport() {
  const dist = 17;
  const visH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(50 / 2));
  const visW = visH * (innerWidth / innerHeight);
  return Math.min(17, visW * 0.84);
}

function buildLogoTargets() {
  const width = logoWidthForViewport();
  if (Math.abs(width - logoWidthUsed) < 0.4) return;
  logoWidthUsed = width;

  const W = 1400, H = 380;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 270px "Space Grotesk", "Inter", Arial, sans-serif';
  if ('letterSpacing' in g) g.letterSpacing = '18px';
  g.fillText('JERCAT', W / 2, H / 2 + 8);

  const data = g.getImageData(0, 0, W, H).data;
  const pts = [];
  let minX = W, maxX = 0;
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      if (data[(y * W + x) * 4 + 3] > 128) {
        pts.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (!pts.length) return;
  const textW = Math.max(1, maxX - minX);
  const scale = width / textW;
  const cx = (minX + maxX) / 2;
  const tgt = particleGeo.attributes.aTarget.array;
  const n = Q.particles;
  const count = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.random() * count) * 2;
    tgt[i * 3]     = (pts[k] - cx) * scale + (Math.random() - 0.5) * scale * 3;
    tgt[i * 3 + 1] = -(pts[k + 1] - H / 2) * scale + (Math.random() - 0.5) * scale * 3;
    tgt[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
  }
  particleGeo.attributes.aTarget.needsUpdate = true;
}

/* ==========================================================
   6. GRILLE NUMÉRIQUE (sol + plafond holographiques)
   ========================================================== */
function makeGrid(y, opacity) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uCam: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uCam;
      varying vec3 vWorld;

      float gridLine(vec2 p, float s) {
        vec2 g = p / s;
        vec2 a = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        return 1.0 - min(min(a.x, a.y), 1.0);
      }

      void main() {
        vec2 p = vWorld.xz;
        float g1 = gridLine(p, 2.0);
        float g2 = gridLine(p, 10.0);
        float dist = length(p - uCam.xz);
        float fade = 1.0 - smoothstep(8.0, 85.0, dist);

        float ring = mod(uTime * 16.0, 150.0);
        float wave = 1.0 - smoothstep(0.0, 3.5, abs(dist - ring));
        float flow = 0.5 + 0.5 * sin(p.y * 0.18 + uTime * 2.6);

        vec3 cA = vec3(0.18, 0.85, 1.0);
        vec3 cB = vec3(0.55, 0.38, 1.0);
        vec3 col = mix(cA, cB, 0.5 + 0.5 * sin(p.x * 0.05 + uTime * 0.3));

        float a = (g1 * 0.16 + g2 * 0.45) * (0.55 + 0.45 * flow) + (g1 + g2) * wave * 1.1;
        gl_FragColor = vec4(col * (1.0 + wave * 2.2), a * fade * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(420, 420, 1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, y, -100);
  scene.add(mesh);
  return mesh;
}

const floorGrid = makeGrid(-7, 1);
const ceilGrid = makeGrid(15, 0.3);

/* ==========================================================
   7. FLUX DE DONNÉES LUMINEUX (lignes holographiques)
   ========================================================== */
const streamMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
  vertexShader: /* glsl */`
    attribute float aT;
    attribute float aOffset;
    attribute float aSpeed;
    attribute vec3 aColor;
    varying float vT;
    varying float vOffset;
    varying float vSpeed;
    varying vec3 vColor;
    void main() {
      vT = aT; vOffset = aOffset; vSpeed = aSpeed; vColor = aColor;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    uniform float uOpacity;
    varying float vT;
    varying float vOffset;
    varying float vSpeed;
    varying vec3 vColor;
    void main() {
      float head = fract(uTime * vSpeed + vOffset) * 1.4 - 0.2;
      float behind = head - vT;
      float trail = step(0.0, behind) * exp(-behind * 7.0);
      float tip = 1.0 - smoothstep(0.0, 0.02, abs(behind));
      float a = (trail * 0.9 + tip * 1.5 + 0.04) * uOpacity;
      gl_FragColor = vec4(vColor * (1.0 + tip * 2.0), a);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

function buildStreams() {
  const n = Q.streams;
  const total = n * 2;               // verticales + horizontales au sol
  const pos = new Float32Array(total * 2 * 3);
  const aT = new Float32Array(total * 2);
  const aOff = new Float32Array(total * 2);
  const aSpd = new Float32Array(total * 2);
  const aCol = new Float32Array(total * 2 * 3);

  for (let i = 0; i < total; i++) {
    const vertical = i < n;
    let ax, ay, az, bx, by, bz;
    if (vertical) {
      const side = Math.random() < 0.5 ? -1 : 1;
      ax = bx = side * (7 + Math.random() * 30);
      az = bz = 22 - Math.random() * 235;
      ay = 15; by = -7;
    } else {
      ax = bx = (Math.random() - 0.5) * 70;
      ay = by = -6.95;
      az = 25 - Math.random() * 235;
      bz = az - (14 + Math.random() * 26);
    }
    const o = Math.random();
    const s = 0.25 + Math.random() * 0.55;
    const c = pickColor();
    const v0 = i * 2, v1 = i * 2 + 1;
    pos.set([ax, ay, az], v0 * 3);
    pos.set([bx, by, bz], v1 * 3);
    aT[v0] = 0; aT[v1] = 1;
    aOff[v0] = aOff[v1] = o;
    aSpd[v0] = aSpd[v1] = s;
    aCol.set([c.r, c.g, c.b], v0 * 3);
    aCol.set([c.r, c.g, c.b], v1 * 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aOffset', new THREE.BufferAttribute(aOff, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(aSpd, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aCol, 3));
  const lines = new THREE.LineSegments(geo, streamMat);
  lines.frustumCulled = false;
  scene.add(lines);
  return lines;
}
buildStreams();

/* ==========================================================
   8. RÉSEAU NUMÉRIQUE (nœuds, connexions, impulsions)
   ========================================================== */
const network = (() => {
  const N = Q.nodes;
  const nodes = [];
  for (let i = 0; i < N; i++) {
    let x = (Math.random() - 0.5) * 50;
    let y = (Math.random() - 0.5) * 24;
    const z = 12 - Math.random() * 205;
    if (Math.abs(x) < 3.5 && Math.abs(y) < 2.5) x += Math.sign(x || 1) * 5;
    nodes.push(new THREE.Vector3(x, y, z));
  }

  const edges = [];
  const adj = nodes.map(() => []);
  const key = new Set();
  for (let i = 0; i < N; i++) {
    const near = [];
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const d = nodes[i].distanceToSquared(nodes[j]);
      if (d < 110) near.push([d, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, 3)) {
      const k = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (key.has(k)) continue;
      key.add(k);
      const e = edges.length;
      edges.push([i, j]);
      adj[i].push(e);
      adj[j].push(e);
    }
  }

  // Connexions
  const lPos = new Float32Array(edges.length * 6);
  const lCol = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], e) => {
    lPos.set([nodes[a].x, nodes[a].y, nodes[a].z, nodes[b].x, nodes[b].y, nodes[b].z], e * 6);
    const c1 = pickColor(), c2 = pickColor();
    lCol.set([c1.r, c1.g, c1.b, c2.r, c2.g, c2.b], e * 6);
  });
  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
  lGeo.setAttribute('color', new THREE.BufferAttribute(lCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // Nœuds
  const nodePts = makeGlowPoints(N, { size: 150, opacity: 0.95 });
  const nPos = nodePts.geometry.attributes.position.array;
  const nCol = nodePts.geometry.attributes.aColor.array;
  const nScl = nodePts.geometry.attributes.aScale.array;
  nodes.forEach((p, i) => {
    nPos.set([p.x, p.y, p.z], i * 3);
    const c = pickColor();
    nCol.set([c.r, c.g, c.b], i * 3);
    nScl[i] = 0.5 + Math.random() * 0.9;
  });
  nodePts.geometry.attributes.position.needsUpdate = true;
  scene.add(nodePts);

  // Impulsions de données circulant sur le graphe
  const P = Q.pulses;
  const pulsePts = makeGlowPoints(P, { size: 120, opacity: 1, color: COLORS.white, scale: 1 });
  const pulses = [];
  const pCol = pulsePts.geometry.attributes.aColor.array;
  for (let i = 0; i < P; i++) {
    const e = Math.floor(Math.random() * edges.length);
    pulses.push({ e, t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1, speed: 0.35 + Math.random() * 0.9 });
    const c = Math.random() < 0.5 ? COLORS.cyan : COLORS.white;
    pCol.set([c.r, c.g, c.b], i * 3);
  }
  scene.add(pulsePts);
  const pPos = pulsePts.geometry.attributes.position.array;

  function update(dt) {
    if (!edges.length) return;
    for (let i = 0; i < P; i++) {
      const p = pulses[i];
      p.t += dt * p.speed;
      if (p.t >= 1) {
        const [a, b] = edges[p.e];
        const end = p.dir === 1 ? b : a;
        const options = adj[end];
        const ne = options[Math.floor(Math.random() * options.length)];
        p.e = ne;
        p.dir = edges[ne][0] === end ? 1 : -1;
        p.t = 0;
      }
      const [a, b] = edges[p.e];
      const A = p.dir === 1 ? nodes[a] : nodes[b];
      const B = p.dir === 1 ? nodes[b] : nodes[a];
      pPos[i * 3]     = lerp(A.x, B.x, p.t);
      pPos[i * 3 + 1] = lerp(A.y, B.y, p.t);
      pPos[i * 3 + 2] = lerp(A.z, B.z, p.t);
    }
    pulsePts.geometry.attributes.position.needsUpdate = true;
  }

  return { update, lineMat, nodePts, pulsePts };
})();

/* ==========================================================
   9. MAQUETTES DE SITES EN VERRE (objets flottants 3D)
   ========================================================== */
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrapText(g, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) g.fillText(line, x, yy);
}

const MOCKUPS = [
  { name: 'Boulangerie Martin', url: 'boulangerie-martin.fr', accent: '#f5b942', hero: 'Le bon pain, chaque matin.', kind: 'vitrine' },
  { name: 'Garage Leroy',       url: 'garage-leroy.fr',       accent: '#3ee8ff', hero: 'Votre voiture entre de bonnes mains.', kind: 'vitrine' },
  { name: 'Maison Lumière',     url: 'maison-lumiere.shop',   accent: '#9b6bff', hero: 'Déco & design, livrés chez vous.', kind: 'shop' },
  { name: 'Le Quai',            url: 'restaurant-lequai.fr',  accent: '#ff8a3d', hero: 'Cuisine de saison, au bord de l\'eau.', kind: 'resto' },
  { name: 'Plomberie Express',  url: 'plomberie-express.fr',  accent: '#4f8bff', hero: 'Dépannage rapide, 7 jours sur 7.', kind: 'vitrine' },
  { name: 'Atelier Floral',     url: 'atelier-floral.fr',     accent: '#ff5fa8', hero: 'Des fleurs pour chaque moment.', kind: 'shop' },
  { name: 'Studio Forme',       url: 'studio-forme.fr',       accent: '#3dffb4', hero: 'Coaching sportif sur mesure.', kind: 'vitrine' },
];

function makeMockupTexture(spec) {
  const W = 1024, H = 640;
  const k = Q.texScale;                       // mobile : texture plus légère (mémoire GPU / temps de dessin)
  const c = document.createElement('canvas');
  c.width = Math.round(W * k); c.height = Math.round(H * k);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(IS_MOBILE ? 4 : 8, renderer.capabilities.getMaxAnisotropy());
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  // Le dessin est fait plus tard, pendant les temps morts du navigateur (les maquettes n'apparaissent qu'à 12 s)
  deferTask(() => { drawMockup(c, spec, k); tex.needsUpdate = true; });
  return tex;
}

function drawMockup(c, spec, k) {
  const W = 1024, H = 640;
  const g = c.getContext('2d');
  g.scale(k, k);

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0e1426');
  bg.addColorStop(1, '#060912');
  rr(g, 0, 0, W, H, 30);
  g.fillStyle = bg;
  g.fill();

  g.save();
  rr(g, 0, 0, W, H, 30);
  g.clip();

  // Barre du navigateur
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(0, 0, W, 54);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(32 + i * 24, 27, 7, 0, Math.PI * 2);
    g.fill();
  });
  rr(g, W / 2 - 210, 14, 420, 26, 13);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.65)';
  g.font = '500 15px Inter, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(`🔒  ${spec.url}`, W / 2, 27);

  // Navigation
  g.textAlign = 'left';
  g.fillStyle = '#ffffff';
  g.font = '700 26px "Space Grotesk", Arial, sans-serif';
  g.fillText(spec.name, 48, 100);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 3; i++) {
    rr(g, 560 + i * 92, 94, 70, 10, 5);
    g.fill();
  }
  rr(g, 852, 80, 124, 40, 20);
  g.fillStyle = spec.accent;
  g.fill();
  g.fillStyle = '#05060c';
  g.font = '600 15px Inter, Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('Contact', 914, 100);

  // Bloc héros
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.font = '700 44px "Space Grotesk", Arial, sans-serif';
  wrapText(g, spec.hero, 48, 210, 440, 52);
  g.fillStyle = 'rgba(255,255,255,0.28)';
  [0, 1, 2].forEach((i) => { rr(g, 48, 300 + i * 22, 380 - i * 70, 10, 5); g.fill(); });
  rr(g, 48, 380, 170, 50, 25);
  g.fillStyle = spec.accent;
  g.fill();
  g.fillStyle = '#05060c';
  g.font = '600 17px Inter, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(spec.kind === 'shop' ? 'Voir la boutique' : 'Devis gratuit', 133, 405);
  rr(g, 232, 380, 150, 50, 25);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 2;
  g.stroke();

  // Visuel héros
  const hx = 540, hy = 150, hw = 436, hh = 290;
  const hg = g.createLinearGradient(hx, hy, hx + hw, hy + hh);
  hg.addColorStop(0, spec.accent);
  hg.addColorStop(1, '#141a33');
  rr(g, hx, hy, hw, hh, 22);
  g.fillStyle = hg;
  g.fill();
  g.save();
  rr(g, hx, hy, hw, hh, 22);
  g.clip();
  g.globalAlpha = 0.35;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.arc(hx + 60 + i * 80, hy + 220 - (i % 2) * 90, 50 + (i % 3) * 30, 0, Math.PI * 2);
    g.fillStyle = i % 2 ? '#ffffff' : '#000000';
    g.fill();
  }
  g.globalAlpha = 1;
  if (spec.kind === 'shop') {
    for (let i = 0; i < 3; i++) {
      rr(g, hx + 28 + i * 136, hy + 170, 112, 96, 14);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fill();
    }
  }
  g.restore();

  // Cartes
  for (let i = 0; i < 3; i++) {
    const cx = 48 + i * 312, cy = 478;
    rr(g, cx, cy, 288, 130, 18);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1.5;
    g.stroke();
    g.beginPath();
    g.arc(cx + 38, cy + 40, 16, 0, Math.PI * 2);
    g.fillStyle = spec.accent;
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    rr(g, cx + 68, cy + 32, 150, 14, 7);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.25)';
    rr(g, cx + 24, cy + 76, 236, 9, 4.5);
    g.fill();
    rr(g, cx + 24, cy + 96, 180, 9, 4.5);
    g.fill();
  }
  g.restore();

  rr(g, 1, 1, W - 2, H - 2, 30);
  g.strokeStyle = 'rgba(255,255,255,0.2)';
  g.lineWidth = 2;
  g.stroke();
}

/* File de petites tâches exécutées quand le navigateur est libre (ne bloque pas l'affichage) */
const idleQueue = [];
let idleScheduled = false;
function deferTask(fn) {
  idleQueue.push(fn);
  if (idleScheduled) return;
  idleScheduled = true;
  const run = (deadline) => {
    do { const t = idleQueue.shift(); if (t) t(); }
    while (idleQueue.length && deadline && deadline.timeRemaining && deadline.timeRemaining() > 8);
    if (idleQueue.length) schedule(); else idleScheduled = false;
  };
  const schedule = () => (window.requestIdleCallback
    ? requestIdleCallback(run, { timeout: 1500 })
    : setTimeout(() => run(null), 60));
  schedule();
}

const panelGroup = new THREE.Group();
panelGroup.position.copy(POS.panels);
scene.add(panelGroup);
const panels = [];
const panelSheen = { value: -0.4 };
const tmpQuat = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.25)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const haloTex = makeHaloTexture();

function buildPanels() {
  const layout = [
    { a: 0,     y: 0.3,  r: 0 },
    { a: -0.42, y: 2.6,  r: 0 },
    { a: 0.42,  y: -2.3, r: 0 },
    { a: -0.80, y: -2.0, r: 0 },
    { a: 0.80,  y: 2.4,  r: 0 },
    { a: -1.15, y: 0.8,  r: 0 },
    { a: 1.15,  y: -0.6, r: 0 },
  ];
  const panelGeo = new THREE.PlaneGeometry(6.4, 4, 1, 1);
  const camLocal = new THREE.Vector3(0, 0, 18);

  MOCKUPS.forEach((spec, i) => {
    const L = layout[i];
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeMockupTexture(spec) },
        uOpacity: { value: 0 },
        uSheen: panelSheen,
        uEdge: { value: new THREE.Color(spec.accent) },
        uTime: particleUniforms.uTime,
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = cameraPosition - w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform float uSheen;
        uniform vec3 uEdge;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 2.0);
          float band = (vUv.x + vUv.y * 0.55) - uSheen;
          float sweep = 1.0 - smoothstep(0.0, 0.09, abs(band));
          vec2 e = min(vUv, 1.0 - vUv);
          float edge = 1.0 - smoothstep(0.0, 0.012, min(e.x, e.y));
          float scan = 0.04 * sin(vUv.y * 420.0 - uTime * 6.0);
          vec3 col = tex.rgb * (0.78 + scan)
                   + uEdge * edge * 1.8
                   + vec3(0.85, 0.96, 1.0) * sweep * 0.45
                   + uEdge * fres * 0.4;
          float a = tex.a * uOpacity * (0.9 + edge * 0.1);
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(panelGeo, mat);
    const radius = 13;
    mesh.position.set(Math.sin(L.a) * radius, L.y, -Math.cos(L.a) * radius + radius - Math.abs(L.a) * 2.5);
    mesh.lookAt(camLocal);

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTex,
      color: new THREE.Color(spec.accent),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    halo.scale.set(13, 9, 1);
    halo.position.copy(mesh.position).add(new THREE.Vector3(0, 0, -0.6));

    mesh.userData = {
      reveal: 0,
      baseQuat: mesh.quaternion.clone(),
      baseY: mesh.position.y,
      i,
      halo,
      dir: i % 2 ? 1 : -1,
    };
    panelGroup.add(halo);
    panelGroup.add(mesh);
    panels.push(mesh);
  });
}

function updatePanels(t) {
  panelGroup.rotation.y = Math.sin(t * 0.18) * 0.06;
  for (const p of panels) {
    const u = p.userData;
    const r = u.reveal;
    const s = 0.55 + 0.45 * r;
    p.scale.setScalar(s);
    p.position.y = u.baseY + Math.sin(t * 0.6 + u.i * 1.3) * 0.28 - (1 - r) * 3 * u.dir;
    tmpQuat.setFromAxisAngle(AXIS_Y, (1 - r) * 1.5 * u.dir + Math.sin(t * 0.4 + u.i) * 0.05);
    p.quaternion.copy(u.baseQuat).multiply(tmpQuat);
    tmpQuat.setFromAxisAngle(AXIS_Z, Math.sin(t * 0.5 + u.i * 2.1) * 0.025);
    p.quaternion.multiply(tmpQuat);
    p.material.uniforms.uOpacity.value = r * 0.96;
    u.halo.material.opacity = r * 0.22;
    u.halo.position.y = p.position.y;
  }
}

/* ==========================================================
   10. HOLOGRAMME IA / CLOUD (reflets métalliques)
   ========================================================== */
const holo = new THREE.Group();
holo.position.copy(POS.holo);
holo.userData.reveal = 0;
scene.add(holo);

const holoParts = {};
{
  // Noyau métallique
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.7, 6),
    new THREE.MeshStandardMaterial({ color: 0x9cc4ff, metalness: 1, roughness: 0.22, envMapIntensity: 0.9 })
  );
  holo.add(core);
  holoParts.core = core;

  // Cage géométrique
  const cage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.1, 1)),
    new THREE.LineBasicMaterial({ color: 0x3ee8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  holo.add(cage);
  holoParts.cage = cage;

  // Coquille de points
  const shellGeo = new THREE.IcosahedronGeometry(4.3, 4);
  const shellCount = shellGeo.attributes.position.count;
  const shell = makeGlowPoints(shellCount, { size: 34, opacity: 0.9, color: COLORS.cyan });
  shell.geometry.attributes.position.array.set(shellGeo.attributes.position.array);
  const shellCol = shell.geometry.attributes.aColor.array;
  for (let i = 0; i < shellCount; i++) {
    const c = Math.random() < 0.7 ? COLORS.cyan : COLORS.violet;
    shellCol.set([c.r, c.g, c.b], i * 3);
  }
  holo.add(shell);
  holoParts.shell = shell;

  // Anneaux orbitaux
  holoParts.rings = [];
  [5.4, 6.4, 7.5].forEach((r, i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.025, 8, 220),
      new THREE.MeshBasicMaterial({
        color: [0x3ee8ff, 0x4f8bff, 0x9b6bff][i],
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    ring.rotation.set(Math.PI / 2 + (i - 1) * 0.5, i * 0.6, 0);
    holo.add(ring);
    holoParts.rings.push(ring);
  });

  // Satellites "cloud" reliés au noyau
  holoParts.sats = [];
  const satLinesGeo = new THREE.BufferGeometry();
  satLinesGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 6), 3));
  const satLines = new THREE.LineSegments(
    satLinesGeo,
    new THREE.LineBasicMaterial({ color: 0x7fe9ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  satLines.frustumCulled = false;
  holo.add(satLines);
  holoParts.satLines = satLines;
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: i % 2 ? 0x3ee8ff : 0x9b6bff, emissiveIntensity: 1.4, metalness: 0.6, roughness: 0.25 })
    );
    s.userData = { r: 6 + (i % 3) * 0.9, speed: 0.35 + i * 0.07, phase: (i / 6) * Math.PI * 2, tilt: (i % 3 - 1) * 0.6 };
    holo.add(s);
    holoParts.sats.push(s);
  }

  // Faisceau de lumière volumétrique
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: particleUniforms.uTime, uOpacity: { value: 0.0 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float fade = pow(vUv.y, 1.6);
        float stripes = 0.65 + 0.35 * sin(vUv.x * 60.0 + uTime * 2.0) * sin(vUv.y * 14.0 - uTime * 3.0);
        vec3 col = mix(vec3(0.2, 0.55, 1.0), vec3(0.3, 0.95, 1.0), vUv.y);
        gl_FragColor = vec4(col * stripes, fade * 0.09 * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 0.6, 14, 64, 1, true), beamMat);
  beam.position.y = -0.2;
  holo.add(beam);
  holoParts.beam = beam;

  // Socle lumineux au sol
  const baseMat = new THREE.ShaderMaterial({
    uniforms: { uTime: particleUniforms.uTime, uOpacity: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        float band = abs(fract(r * 4.0 - uTime * 0.6) - 0.5);
        float rings = smoothstep(0.40, 0.49, band);
        float glow = (1.0 - smoothstep(0.0, 1.0, r));
        vec3 col = mix(vec3(0.24, 0.9, 1.0), vec3(0.6, 0.42, 1.0), r);
        gl_FragColor = vec4(col, (rings * 0.32 + glow * 0.08) * (1.0 - smoothstep(0.85, 1.0, r)) * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = -6.9;
  holo.add(base);
  holoParts.base = base;
}

function updateHolo(t, dt) {
  const r = holo.userData.reveal;
  const s = Math.max(0.0001, r);
  holo.scale.setScalar(0.2 + 0.8 * s);
  holo.visible = r > 0.001;
  if (!holo.visible) return;   // invisible : aucun calcul ni envoi au GPU
  holoParts.core.rotation.y += dt * 0.4;
  holoParts.cage.rotation.y -= dt * 0.25;
  holoParts.cage.rotation.x += dt * 0.12;
  holoParts.cage.material.opacity = 0.85 * r;
  holoParts.shell.rotation.y += dt * 0.08;
  holoParts.shell.material.uniforms.uOpacity.value = 0.9 * r;
  holoParts.rings.forEach((ring, i) => {
    ring.rotation.z += dt * (0.25 + i * 0.12) * (i % 2 ? -1 : 1);
    ring.material.opacity = 0.9 * r;
  });
  const lp = holoParts.satLines.geometry.attributes.position.array;
  holoParts.sats.forEach((s, i) => {
    const u = s.userData;
    const a = t * u.speed + u.phase;
    s.position.set(Math.cos(a) * u.r, Math.sin(a * 1.3) * 1.6 + u.tilt * 2, Math.sin(a) * u.r);
    lp.set([0, 0, 0, s.position.x, s.position.y, s.position.z], i * 6);
  });
  holoParts.satLines.geometry.attributes.position.needsUpdate = true;
  holoParts.satLines.material.opacity = 0.45 * r;
  holoParts.beam.material.uniforms.uOpacity.value = r;
  holoParts.base.material.uniforms.uOpacity.value = r;
  holoParts.core.position.y = Math.sin(t * 0.9) * 0.15;
}

/* ==========================================================
   11. RAYONS LUMINEUX DYNAMIQUES
   ========================================================== */
const rays = new THREE.Group();
scene.add(rays);
{
  const rayMat = new THREE.ShaderMaterial({
    uniforms: { uTime: particleUniforms.uTime, uOpacity: { value: 0.6 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float across = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5));
        float along = pow(vUv.y, 2.2);
        float flicker = 0.75 + 0.25 * sin(uTime * 1.7 + vUv.y * 6.0);
        vec3 col = mix(vec3(0.3, 0.6, 1.0), vec3(0.4, 0.95, 1.0), vUv.y);
        gl_FragColor = vec4(col, across * across * along * flicker * 0.16 * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 7; i++) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(2.2 + Math.random() * 3, 60), rayMat);
    ray.position.set(0, 0, -6);
    ray.rotation.z = (i / 7) * Math.PI * 2;
    ray.userData.speed = (Math.random() - 0.5) * 0.12;
    ray.translateY(30);
    const pivot = new THREE.Group();
    pivot.add(ray);
    pivot.rotation.z = (i / 7) * Math.PI * 2;
    pivot.userData.speed = 0.03 + Math.random() * 0.05;
    rays.add(pivot);
  }
  rays.userData.mat = rayMat;
}

/* ==========================================================
   12. ÉTINCELLES & ONDES DE CHOC
   ========================================================== */
const sparks = (() => {
  const N = 900;
  const pts = makeGlowPoints(N, { size: 70, opacity: 1, color: COLORS.white, scale: 1 });
  const alpha = pts.geometry.attributes.aAlpha.array;
  alpha.fill(0);
  const pos = pts.geometry.attributes.position.array;
  const col = pts.geometry.attributes.aColor.array;
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  let cursor = 0;
  let alive = 0;          // nombre d'étincelles visibles : 0 = aucun calcul ni envoi au GPU
  scene.add(pts);

  function burst(origin, count = 260, speed = 9, color = COLORS.cyan) {
    for (let k = 0; k < count; k++) {
      const i = cursor;
      cursor = (cursor + 1) % N;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.3 + Math.random() * 0.9);
      vel[i * 3]     = Math.sin(ph) * Math.cos(th) * sp;
      vel[i * 3 + 1] = Math.sin(ph) * Math.sin(th) * sp;
      vel[i * 3 + 2] = Math.cos(ph) * sp * 0.6;
      pos[i * 3] = origin.x; pos[i * 3 + 1] = origin.y; pos[i * 3 + 2] = origin.z;
      const c = Math.random() < 0.6 ? color : COLORS.white;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      life[i] = 0.8 + Math.random() * 1.2;
    }
    alive = N;
    pts.geometry.attributes.aColor.needsUpdate = true;
  }

  function update(dt) {
    if (!alive) return;
    const damp = Math.pow(0.12, dt);
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      count++;
      life[i] -= dt;
      vel[i * 3] *= damp; vel[i * 3 + 1] = vel[i * 3 + 1] * damp - 1.6 * dt; vel[i * 3 + 2] *= damp;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      alpha[i] = clamp(life[i], 0, 1);
    }
    alive = count;
    pts.geometry.attributes.position.needsUpdate = true;
    pts.geometry.attributes.aAlpha.needsUpdate = true;
  }
  return { burst, update };
})();

const shockwaves = [];
{
  const geo = new THREE.RingGeometry(0.92, 1, 128);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x7fefff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.visible = false;
    scene.add(m);
    shockwaves.push(m);
  }
}
let shockIndex = 0;
function shockwave(origin, maxScale = 14) {
  const m = shockwaves[shockIndex];
  shockIndex = (shockIndex + 1) % shockwaves.length;
  m.position.copy(origin);
  m.lookAt(camera.position);
  m.visible = true;
  gsap.killTweensOf(m.scale);
  gsap.killTweensOf(m.material);
  gsap.fromTo(m.scale, { x: 0.2, y: 0.2, z: 0.2 }, { x: maxScale, y: maxScale, z: maxScale, duration: 1.6, ease: 'expo.out' });
  gsap.fromTo(m.material, { opacity: 0.9 }, { opacity: 0, duration: 1.6, ease: 'power2.out', onComplete: () => { m.visible = false; } });
}

/* ==========================================================
   13. POST-TRAITEMENT (profondeur de champ, bloom, flou cinétique)
   ========================================================== */
const composer = new EffectComposer(renderer);
composer.setPixelRatio(pixelRatio);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));

const bokeh = new BokehPass(scene, camera, { focus: 17, aperture: 0.00035, maxblur: 0.005 });
bokeh.enabled = Q.bokeh;
composer.addPass(bokeh);

const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.05, 0.62, 0.16);
bloom.enabled = TIER !== 'soft';   // sans carte graphique (rendu logiciel), le halo serait trop lent
composer.addPass(bloom);

const afterimage = new AfterimagePass(0.55);
afterimage.enabled = Q.afterimage;
composer.addPass(afterimage);

composer.addPass(new OutputPass());

/* ==========================================================
   14. CAMÉRA CINÉMATIQUE
   ========================================================== */
const rig = {
  px: 0, py: 0, pz: 26,
  tx: 0, ty: 0, tz: 0,
  roll: 0, fov: 46,
  focusMul: 1, aperture: 0.00035, maxblur: 0.005,
  trail: 0.55, shake: 0,
};
const camTarget = new THREE.Vector3();
const pointer = { x: 0, y: 0, sx: 0, sy: 0, active: false, last: 0 };
const raycaster = new THREE.Raycaster();
const mouseWorld = new THREE.Vector3(999, 999, 999);
const ndc = new THREE.Vector2();
const tmpTarget = new THREE.Vector3();

function applyCamera(t) {
  pointer.sx = lerp(pointer.sx, pointer.x, 0.045);
  pointer.sy = lerp(pointer.sy, pointer.y, 0.045);
  const shakeX = (Math.random() - 0.5) * rig.shake * 0.25;
  const shakeY = (Math.random() - 0.5) * rig.shake * 0.25;
  const breathe = Math.sin(t * 0.5) * 0.12;

  camera.position.set(
    rig.px + pointer.sx * 1.3 + shakeX,
    rig.py + pointer.sy * 0.8 + shakeY + breathe,
    rig.pz
  );
  camTarget.set(rig.tx + pointer.sx * 0.4, rig.ty + pointer.sy * 0.25, rig.tz);
  camera.lookAt(camTarget);
  camera.rotateZ(rig.roll);

  if (Math.abs(camera.fov - rig.fov) > 0.01) {
    camera.fov = rig.fov;
    camera.updateProjectionMatrix();
  }

  if (bokeh.enabled) {
    const u = bokeh.uniforms;
    u.focus.value = camera.position.distanceTo(camTarget) * rig.focusMul;
    u.aperture.value = rig.aperture;
    u.maxblur.value = rig.maxblur;
  }
  if (afterimage.enabled) afterimage.uniforms.damp.value = rig.trail;

  // Position de la souris dans l'espace 3D (répulsion des particules)
  if (pointer.active) {
    ndc.set(pointer.x, pointer.y);
    raycaster.setFromCamera(ndc, camera);
    tmpTarget.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, 15);
    mouseWorld.lerp(tmpTarget, 0.25);
  } else {
    mouseWorld.set(999, 999, 999);
  }
  particleUniforms.uMouse.value.copy(mouseWorld);

  rays.position.copy(camTarget);
  rays.lookAt(camera.position);
}

/* ==========================================================
   15. TRAÎNÉE LUMINEUSE DE LA SOURIS (canvas 2D)
   ========================================================== */
const trail = (() => {
  const c = $('#trail');
  const g = c.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  const points = [];
  const sparks2d = [];
  let painted = false;    // le canevas contient-il encore quelque chose ?

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    c.width = w * dpr; c.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  c.style.visibility = 'hidden';

  function add(x, y) {
    const now = performance.now();
    const last = points[points.length - 1];
    points.push({ x, y, t: now });
    if (last) {
      const dist = Math.hypot(x - last.x, y - last.y);
      const n = Math.min(6, Math.floor(dist / 14));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 0.6 + Math.random() * 2.6;
        sparks2d.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, hue: Math.random() < 0.6 ? 190 : 265 });
      }
    }
    if (sparks2d.length > 260) sparks2d.splice(0, sparks2d.length - 260);
  }

  function draw() {
    const now = performance.now();
    while (points.length && now - points[0].t > 380) points.shift();
    if (!points.length && !sparks2d.length) {
      // Rien à dessiner : on efface une seule fois puis on masque la couche (plus de fusion plein écran)
      if (painted) { g.clearRect(0, 0, w, h); painted = false; c.style.visibility = 'hidden'; }
      return;
    }
    if (!painted) { c.style.visibility = ''; painted = true; }
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1], p1 = points[i];
      const age = 1 - (now - p1.t) / 380;
      const k = i / points.length;
      g.strokeStyle = `hsla(${190 + k * 75}, 100%, 65%, ${age * 0.18})`;
      g.lineWidth = 14 * age;
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      g.strokeStyle = `hsla(${190 + k * 75}, 100%, 85%, ${age * 0.85})`;
      g.lineWidth = 2.2 * age;
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
    }
    for (let i = sparks2d.length - 1; i >= 0; i--) {
      const s = sparks2d[i];
      s.x += s.vx; s.y += s.vy; s.vx *= 0.94; s.vy = s.vy * 0.94 + 0.03;
      s.life -= 0.028;
      if (s.life <= 0) { sparks2d.splice(i, 1); continue; }
      g.fillStyle = `hsla(${s.hue}, 100%, 75%, ${s.life})`;
      g.beginPath(); g.arc(s.x, s.y, 1.6 * s.life + 0.3, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  return { resize, add, draw };
})();

/* ==========================================================
   16. MOTEUR AUDIO (musique générée + effets + voix off)
   ========================================================== */
class AudioEngine {
  constructor(voiceUrls = []) {
    this.ctx = null;
    this.enabled = false;
    this.voices = [];
    this.voiceUrls = voiceUrls;   // fichiers MP3 de la voix off
    this.voiceFiles = [];         // téléchargements en cours (ArrayBuffer)
    this.voiceReady = [];         // décodage en cours (AudioBuffer)
    this.voiceBuf = [];           // répliques prêtes à jouer
    this.voiceSrc = null;         // réplique en cours de lecture
    if ('speechSynthesis' in window) {
      const load = () => { this.voices = speechSynthesis.getVoices(); };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();

    this.master = c.createGain();
    this.master.gain.value = 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    this.output = comp; // sortie finale du son, utilisée par recorder.js pour l'enregistrement vidéo

    this.reverb = c.createConvolver();
    this.reverb.buffer = this.impulse(3.4, 2.4);
    const revGain = c.createGain();
    revGain.gain.value = 0.5;
    this.reverb.connect(revGain).connect(this.master);

    this.music = c.createGain();
    this.music.gain.value = 0.55;
    this.music.connect(this.master);
    this.music.connect(this.reverb);

    this.sfx = c.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.sfx.connect(this.reverb);

    // Voix off : même circuit que la musique → haut-parleurs + enregistrement vidéo
    this.voiceGain = c.createGain();
    this.voiceGain.gain.value = 1;
    this.voiceGain.connect(this.master);
    this.decodeVoices();

    const len = c.sampleRate * 2;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.bpm = 100;
    this.eighth = 60 / this.bpm / 2;
    this.step = 0;
    this.nextTime = c.currentTime + 0.12;
    // La mineur — Fa — Do — Sol
    this.chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    this.timer = setInterval(() => this.schedule(), 90);
  }

  midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  impulse(dur, decay) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  schedule() {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    if (!this.enabled) { this.nextTime = c.currentTime + 0.12; return; } // son coupé : aucun oscillateur créé
    while (this.nextTime < c.currentTime + 0.35) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.eighth;
      this.step++;
    }
  }

  playStep(step, t) {
    const inBar = step % 8;
    const bar = Math.floor(step / 8);
    const chord = this.chords[bar % 4];
    if (inBar === 0) this.pad(chord, t, this.eighth * 8);
    if (inBar % 2 === 0) this.kick(t, inBar === 0 ? 1 : 0.5);
    else this.hat(t);
    if (inBar === 0 || inBar === 3 || inBar === 6) this.bass(chord[0] - 24, t, this.eighth * 1.8);
    const arp = [0, 1, 2, 1, 2, 0, 2, 1];
    this.pluck(chord[arp[inBar]] + 12 + (bar % 2 ? 12 : 0), t);
  }

  pad(chord, t, dur) {
    const c = this.ctx;
    chord.forEach((n) => {
      [-8, 0, 8].forEach((det) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = this.midi(n);
        o.detune.value = det;
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = 0.8;
        f.frequency.setValueAtTime(500, t);
        f.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
        f.frequency.linearRampToValueAtTime(650, t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.022, t + 0.9);
        g.gain.setValueAtTime(0.022, t + dur - 0.5);
        g.gain.linearRampToValueAtTime(0, t + dur + 0.6);
        o.connect(f).connect(g).connect(this.music);
        o.start(t);
        o.stop(t + dur + 0.7);
      });
    });
  }

  kick(t, v) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = c.createGain();
    g.gain.setValueAtTime(0.5 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.45);
  }

  hat(t) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.03, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    s.connect(f).connect(g).connect(this.music);
    s.start(t, Math.random());
    s.stop(t + 0.08);
  }

  bass(n, t, d) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = this.midi(n);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + d + 0.05);
  }

  pluck(n, t) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = this.midi(n);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2600;
    const g = c.createGain();
    g.gain.setValueAtTime(0.022, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(f).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.4);
  }

  ready() { return this.enabled && this.ctx && this.ctx.state === 'running'; }

  whoosh(dur = 1.2) {
    if (!this.ready()) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(220, t);
    f.frequency.exponentialRampToValueAtTime(3800, t + dur * 0.7);
    f.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    if (p) {
      p.pan.setValueAtTime(-0.8, t);
      p.pan.linearRampToValueAtTime(0.8, t + dur);
      s.connect(f).connect(g).connect(p).connect(this.sfx);
    } else {
      s.connect(f).connect(g).connect(this.sfx);
    }
    s.start(t);
    s.stop(t + dur + 0.1);
  }

  impact() {
    if (!this.ready()) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 1.5);

    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.35, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(f).connect(g2).connect(this.sfx);
    s.start(t);
    s.stop(t + 0.55);

    [1760, 2637, 3520].forEach((fr, i) => {
      const so = c.createOscillator();
      so.type = 'sine';
      so.frequency.value = fr;
      const sg = c.createGain();
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(0.045 / (i + 1), t + 0.05);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      so.connect(sg).connect(this.sfx);
      so.start(t);
      so.stop(t + 2.5);
    });
  }

  riser(dur = 2) {
    if (!this.ready()) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(880, t + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(5000, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  async setEnabled(on) {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = on;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(on ? 0.9 : 0, t + 0.6);
    if (!on) this.stopVoice();
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.enabled && this.ctx.state === 'suspended') this.ctx.resume(); }

  duck(on) {
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(on ? 0.22 : 0.55, this.ctx.currentTime, 0.25);
  }

  pickVoice() {
    const fr = this.voices.filter((v) => /^fr(-|_|$)/i.test(v.lang));
    const pref = fr.find((v) => /natural|neural|online|premium|google|thomas|am[ée]lie|denise|henri|remy|vivienne/i.test(v.name));
    return pref || fr[0] || null;
  }

  /* Téléchargement des MP3 de la voix off (en arrière-plan, une seule fois) */
  fetchVoices() {
    if (this.voiceFiles.length || !this.voiceUrls.length) return;
    this.voiceFiles = this.voiceUrls.map((u) => fetch(u)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null));
    this.decodeVoices();
  }

  /* Décodage (nécessite le moteur audio, créé au premier clic sur le son) */
  decodeVoices() {
    if (!this.ctx) return;
    if (!this.voiceFiles.length) this.fetchVoices();
    this.voiceFiles.forEach((file, i) => {
      if (this.voiceReady[i]) return;
      this.voiceReady[i] = file
        .then((ab) => (ab ? this.ctx.decodeAudioData(ab) : null))
        .then((buf) => { if (buf) this.voiceBuf[i] = buf; return buf; })
        .catch(() => null);
    });
  }

  /* Joue la réplique `line` ; `offset` (secondes) permet de reprendre en cours de phrase */
  say(line, offset = 0) {
    if (!this.enabled) return;
    const buf = this.voiceBuf[line.index];
    if (buf && this.ctx) { this.playVoice(buf, offset); return; }

    // Fichier pas encore décodé : on le joue dès qu'il est prêt, calé sur le temps écoulé
    const pending = this.voiceReady[line.index];
    if (pending && this.ctx) {
      const asked = this.ctx.currentTime;
      const token = this.voiceToken = (this.voiceToken || 0) + 1;
      pending.then((b) => {
        if (b && this.enabled && token === this.voiceToken) this.playVoice(b, offset + (this.ctx.currentTime - asked));
        else if (!b && token === this.voiceToken) this.speakFallback(line.text, offset);
      });
      return;
    }
    this.speakFallback(line.text, offset);
  }

  playVoice(buf, offset = 0) {
    this.stopVoice(true);
    if (offset >= buf.duration - 0.05) { this.duck(false); return; }
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.voiceGain);
    s.onended = () => { if (this.voiceSrc === s) { this.voiceSrc = null; this.duck(false); } };
    this.voiceSrc = s;
    this.duck(true);
    s.start(0, Math.max(0, offset));
  }

  /* Secours si les fichiers MP3 sont introuvables : synthèse vocale du navigateur
     (audible sur le site, mais elle ne peut pas être enregistrée dans la vidéo) */
  speakFallback(text, offset = 0) {
    if (!this.enabled || !('speechSynthesis' in window) || offset > 2.5) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    const v = this.pickVoice();
    if (v) u.voice = v;
    u.rate = 0.98;
    u.pitch = 0.92;
    u.volume = 1;
    u.onstart = () => this.duck(true);
    u.onend = () => this.duck(false);
    u.onerror = () => this.duck(false);
    speechSynthesis.speak(u);
  }

  stopVoice(keepDuck = false) {
    this.voiceToken = (this.voiceToken || 0) + 1;   // annule une réplique en attente de décodage
    if (this.voiceSrc) {
      const s = this.voiceSrc;
      this.voiceSrc = null;
      s.onended = null;
      try { s.stop(); } catch (e) { /* déjà terminée */ }
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (!keepDuck) this.duck(false);
  }
}

const audio = new AudioEngine(VOICE.map((line) => line.file));

/* ==========================================================
   17. TYPOGRAPHIE : découpage en caractères
   ========================================================== */
function splitText(el) {
  const walk = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(' '));
            return;
          }
          const word = document.createElement('span');
          word.className = 'word';
          for (const ch of part) {
            const s = document.createElement('span');
            s.className = 'char';
            s.textContent = ch;
            word.appendChild(s);
          }
          frag.appendChild(word);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    });
  };
  const label = el.textContent.trim().replace(/\s+/g, ' ');
  walk(el);
  $$('.word', el).forEach((w) => w.setAttribute('aria-hidden', 'true'));
  const sr = document.createElement('span');
  sr.className = 'sr-only';
  sr.textContent = label;
  el.appendChild(sr);
}

$$('.split').forEach(splitText);

/* ==========================================================
   18. TIMELINE CINÉMATOGRAPHIQUE
   ========================================================== */
const sc = (n) => $(`.scene-${n}`);
const flash = $('#flash');
const letterTop = $('.letterbox-top');
const letterBottom = $('.letterbox-bottom');
const raysCss = $('.fx-rays');
const uMorph = particleUniforms.uMorph;
const uOffset = particleUniforms.uTargetOffset.value;

const tl = gsap.timeline({
  paused: true,
  defaults: { ease: 'power3.inOut' },
  onUpdate: onTimelineUpdate,
  onComplete: onTimelineComplete,
});

/* Sur mobile, le flou animé sur chaque lettre est remplacé par le fondu seul (même mouvement 3D) */
const blur = (px) => (LITE_FX ? {} : { filter: `blur(${px}px)` });

/* Sur mobile, les lettres glissent en 2D (pas de calque 3D par lettre) */
const depth = (rx, z) => (LITE_FX ? {} : { rotateX: rx, z });

const charsIn = (el, at, opts = {}) => {
  const chars = $$('.char', el);
  tl.fromTo(chars,
    { opacity: 0, yPercent: 90, ...depth(-80, -140), ...blur(14) },
    {
      opacity: 1, yPercent: 0, ...depth(0, 0), ...blur(0),
      duration: opts.duration || 1.15,
      stagger: { each: opts.each || 0.026, from: opts.from || 'start' },
      ease: 'expo.out',
    }, at);
};

const charsOut = (el, at) => {
  tl.to($$('.char', el), {
    opacity: 0, yPercent: -70, ...(LITE_FX ? {} : { z: 90 }), ...blur(12),
    duration: 0.6, stagger: { each: 0.01, from: 'end' }, ease: 'power2.in',
  }, at);
};

const blocksIn = (els, at, each = 0.12) => {
  tl.fromTo(els,
    { opacity: 0, y: 60, rotateY: -28, rotateX: 18, z: -200, scale: 0.88, ...blur(12) },
    { opacity: 1, y: 0, rotateY: 0, rotateX: 0, z: 0, scale: 1, ...blur(0), duration: 1.3, stagger: each, ease: 'expo.out' },
    at);
};

const blocksOut = (els, at) => {
  tl.to(els, { opacity: 0, y: -40, z: 120, scale: 1.06, ...blur(14), duration: 0.6, stagger: 0.05, ease: 'power2.in' }, at);
};

const showScene = (n, from, to) => {
  tl.set(sc(n), { autoAlpha: 1 }, from);
  if (to !== undefined) tl.set(sc(n), { autoAlpha: 0 }, to);
};

const flashAt = (at, peak = 0.9) => {
  tl.fromTo(flash, { opacity: 0 }, { opacity: peak, duration: 0.12, ease: 'power1.out' }, at)
    .to(flash, { opacity: 0, duration: 0.9, ease: 'power2.out' }, at + 0.12);
};

function buildTimeline() {
  /* ---------- État initial ---------- */
  tl.set(rig, { px: 0, py: 0, pz: 27, tx: 0, ty: 0, tz: 0, roll: 0.09, fov: 44, focusMul: 1, aperture: 0.00035, maxblur: 0.005, trail: 0.55, shake: 0 }, 0);
  tl.set(uMorph, { value: 0 }, 0);
  tl.set(uOffset, { x: POS.logo.x, y: POS.logo.y, z: POS.logo.z }, 0);
  tl.set(particleUniforms.uTargetScale, { value: 0.85 }, 0);
  tl.set(panels.map((p) => p.userData), { reveal: 0 }, 0);
  tl.set(holo.userData, { reveal: 0 }, 0);
  tl.set(panelSheen, { value: -0.4 }, 0);
  tl.set(bloom, { strength: 1.05 }, 0);
  tl.set([letterTop, letterBottom], { scaleY: 1.35 }, 0);
  tl.set(raysCss, { opacity: 0.5 }, 0);
  tl.set(rays.userData.mat.uniforms.uOpacity, { value: 0.9 }, 0);
  tl.set(network.lineMat, { opacity: 0.32 }, 0);

  /* ---------- SCÈNE 1 : révélation du logo (0 → 6 s) ---------- */
  tl.to([letterTop, letterBottom], { scaleY: 1, duration: 2.5, ease: 'power3.out' }, 0);
  tl.to(rig, { pz: 17, roll: 0, fov: 50, duration: 5.4, ease: 'power2.out' }, 0);
  tl.to(uMorph, { value: 1, duration: 3.6, ease: 'power2.inOut' }, 0.3);
  tl.call(() => audio.riser(3.2), null, 0.4);
  tl.call(() => {
    audio.impact();
    sparks.burst(POS.logo, 320, 11, COLORS.cyan);
    shockwave(POS.logo, 16);
  }, null, 3.55);
  tl.to(rig, { shake: 1, duration: 0.08, ease: 'none' }, 3.55).to(rig, { shake: 0, duration: 0.9, ease: 'power2.out' }, 3.63);
  tl.to(bloom, { strength: 2.4, duration: 0.15, ease: 'power2.out' }, 3.55).to(bloom, { strength: 1.05, duration: 1.4, ease: 'power2.out' }, 3.7);
  flashAt(3.55, 0.7);

  showScene(1, 1.9, T.s2 + 0.2);
  charsIn($('.scene-1 .eyebrow'), 2.0, { each: 0.035 });
  charsIn($('.scene-1 .tagline'), 3.9, { each: 0.018, from: 'center' });
  charsOut($('.scene-1 .eyebrow'), 5.2);
  charsOut($('.scene-1 .tagline'), 5.25);

  /* ---------- SCÈNE 2 : travelling dans le réseau (6 → 12,5 s) ---------- */
  tl.to(uMorph, { value: 0, duration: 2.0, ease: 'power2.in' }, T.s2 - 0.6);
  tl.call(() => audio.whoosh(1.4), null, T.s2 - 0.5);
  tl.to(rig, { trail: 0.86, duration: 0.7, ease: 'power2.out' }, T.s2 - 0.5)
    .to(rig, { trail: 0.55, duration: 1.6, ease: 'power2.inOut' }, T.s2 + 1.2);
  tl.to(rig, { pz: -58, py: 1.4, tz: -84, ty: 0.4, roll: -0.12, fov: 60, duration: 6.6, ease: 'power2.inOut' }, T.s2 - 0.5);
  tl.to(raysCss, { opacity: 0.18, duration: 2 }, T.s2);
  tl.to(network.lineMat, { opacity: 0.55, duration: 2 }, T.s2);

  showScene(2, T.s2 + 0.3, T.s3 + 0.1);
  charsIn($('.scene-2 .line:nth-child(1)'), T.s2 + 0.4);
  charsIn($('.scene-2 .line:nth-child(2)'), T.s2 + 1.0, { each: 0.045 });
  charsIn($('.scene-2 .sub'), T.s2 + 2.0, { each: 0.008, duration: 0.9 });
  charsOut($('.scene-2 .headline'), T.s3 - 1.2);
  charsOut($('.scene-2 .sub'), T.s3 - 1.15);

  /* ---------- SCÈNE 3 : sites en verre flottants (12,5 → 20 s) ---------- */
  tl.call(() => audio.whoosh(1.1), null, T.s3 - 1.0);
  tl.to(rig, { px: 0, py: 0.7, pz: -82, tx: 0, ty: 0.2, tz: -100, roll: 0, fov: 48, duration: 3.2, ease: 'expo.inOut' }, T.s3 - 1.0);
  tl.to(rig, { trail: 0.8, duration: 0.6 }, T.s3 - 0.9).to(rig, { trail: 0.55, duration: 1.4 }, T.s3 + 0.3);
  tl.to(network.lineMat, { opacity: 0.25, duration: 2 }, T.s3);
  tl.to(panels.map((p) => p.userData), { reveal: 1, duration: 1.8, stagger: { each: 0.12, from: 'center' }, ease: 'expo.out' }, T.s3 - 0.3);
  tl.call(() => sparks.burst(POS.panels, 220, 8, COLORS.blue), null, T.s3 + 0.2);
  tl.fromTo(panelSheen, { value: -0.4 }, { value: 1.9, duration: 1.8, ease: 'power2.inOut' }, T.s3 + 0.9);
  tl.fromTo(panelSheen, { value: -0.4 }, { value: 1.9, duration: 1.8, ease: 'power2.inOut', immediateRender: false }, T.s3 + 4.2);
  // Travelling latéral + zoom lent
  tl.to(rig, { px: -3.8, py: 1.2, pz: -86, tx: 1.4, roll: 0.03, duration: 5.4, ease: 'sine.inOut' }, T.s3 + 2.0);

  showScene(3, T.s3 + 0.2, T.s4 + 0.1);
  charsIn($('.scene-3 .line:nth-child(1)'), T.s3 + 0.3);
  charsIn($('.scene-3 .line:nth-child(2)'), T.s3 + 0.8, { each: 0.022 });
  blocksIn($$('.scene-3 .chip'), T.s3 + 1.9, 0.1);
  charsOut($('.scene-3 .headline'), T.s4 - 1.2);
  blocksOut($$('.scene-3 .chip'), T.s4 - 1.15);

  /* ---------- SCÈNE 4 : hologramme IA & performance (20 → 26,5 s) ---------- */
  tl.call(() => audio.whoosh(1.3), null, T.s4 - 1.1);
  tl.to(rig, { px: 6.5, py: 2.6, pz: -145, tx: 0, ty: 0, tz: -160, roll: 0.07, fov: 52, duration: 3.4, ease: 'expo.inOut' }, T.s4 - 1.1);
  tl.to(rig, { trail: 0.84, duration: 0.6 }, T.s4 - 1.0).to(rig, { trail: 0.55, duration: 1.5 }, T.s4 + 0.5);
  tl.fromTo(holo.userData, { reveal: 0 }, { reveal: 1, duration: 2.4, ease: 'expo.out', immediateRender: false }, T.s4 - 0.5);
  tl.call(() => {
    audio.impact();
    sparks.burst(POS.holo, 300, 10, COLORS.violet);
    shockwave(POS.holo, 20);
  }, null, T.s4 + 0.1);
  tl.to(bloom, { strength: 1.7, duration: 0.2 }, T.s4 + 0.1).to(bloom, { strength: 0.85, duration: 1.5 }, T.s4 + 0.3);
  tl.to(raysCss, { opacity: 0.6, duration: 2 }, T.s4);
  // Orbite autour de l'hologramme
  tl.to(rig, { px: -6.8, py: 1.3, pz: -148.5, roll: -0.04, duration: 6.2, ease: 'sine.inOut' }, T.s4 + 1.2);

  showScene(4, T.s4 + 0.2, T.s5 + 0.1);
  charsIn($('.scene-4 .line:nth-child(1)'), T.s4 + 0.3);
  charsIn($('.scene-4 .line:nth-child(2)'), T.s4 + 0.9, { each: 0.03 });
  blocksIn($$('.scene-4 .metric'), T.s4 + 1.6, 0.14);
  tl.fromTo($$('.scene-4 .ring-fg'), { strokeDashoffset: 301.6 }, { strokeDashoffset: 0, duration: 1.8, stagger: 0.14, ease: 'power3.out' }, T.s4 + 2.0);
  charsOut($('.scene-4 .headline'), T.s5 - 1.1);
  blocksOut($$('.scene-4 .metric'), T.s5 - 1.05);

  /* ---------- SCÈNE 5 : engagements, profondeur de champ (26,5 → 35 s) ---------- */
  tl.call(() => audio.whoosh(1.0), null, T.s5 - 0.8);
  tl.to(rig, { px: 0, py: 5, pz: -131, tx: 0, ty: 1.2, tz: -160, roll: 0, fov: 44, focusMul: 0.32, aperture: 0.0013, maxblur: 0.012, duration: 3.0, ease: 'expo.inOut' }, T.s5 - 0.8);
  tl.to(rig, { pz: -135.5, py: 5.6, duration: 8.4, ease: 'none' }, T.s5 + 2.2);
  tl.to(raysCss, { opacity: 0.35, duration: 2 }, T.s5);
  tl.to(holo.userData, { reveal: 0.75, duration: 2 }, T.s5);

  showScene(5, T.s5 + 0.1, T.s6 + 0.1);
  charsIn($('.scene-5 .eyebrow'), T.s5 + 0.2, { each: 0.03 });
  blocksIn($$('.scene-5 .stat'), T.s5 + 0.6, 0.24);
  $$('.scene-5 [data-count]').forEach((el, i) => {
    const target = Number(el.dataset.count);
    tl.fromTo(el, { innerText: 0 }, {
      innerText: target,
      snap: { innerText: 1 },
      duration: target > 10 ? 1.6 : 1.0,
      ease: 'power3.out',
    }, T.s5 + 0.9 + i * 0.24);
  });
  charsOut($('.scene-5 .eyebrow'), T.s6 - 1.2);
  blocksOut($$('.scene-5 .stat'), T.s6 - 1.15);

  /* ---------- SCÈNE 6 : appel à l'action (35 → 44 s) ---------- */
  tl.set(uOffset, { x: POS.outro.x, y: POS.outro.y, z: POS.outro.z }, T.s6 - 1.6);
  tl.set(particleUniforms.uTargetScale, { value: 0.68 }, T.s6 - 1.6);
  tl.call(() => { audio.whoosh(1.6); audio.riser(2.6); }, null, T.s6 - 1.2);
  tl.to(rig, { px: 0, py: 0.6, pz: -181, tx: 0, ty: 0.8, tz: -200, roll: 0, fov: 50, focusMul: 1, aperture: 0.00035, maxblur: 0.005, duration: 3.4, ease: 'expo.inOut' }, T.s6 - 1.2);
  tl.to(rig, { trail: 0.88, duration: 0.8 }, T.s6 - 1.1).to(rig, { trail: 0.55, duration: 1.6 }, T.s6 + 0.6);
  tl.to(holo.userData, { reveal: 0, duration: 1.6, ease: 'power2.in' }, T.s6 - 0.6);
  tl.to(uMorph, { value: 1, duration: 3.2, ease: 'power2.inOut' }, T.s6 - 0.4);
  tl.call(() => {
    audio.impact();
    sparks.burst(POS.outro, 360, 12, COLORS.cyan);
    shockwave(POS.outro, 18);
  }, null, T.s6 + 2.6);
  tl.to(rig, { shake: 0.8, duration: 0.08, ease: 'none' }, T.s6 + 2.6).to(rig, { shake: 0, duration: 0.9 }, T.s6 + 2.68);
  tl.to(bloom, { strength: 2.2, duration: 0.15 }, T.s6 + 2.6).to(bloom, { strength: 1.1, duration: 1.6 }, T.s6 + 2.75);
  flashAt(T.s6 + 2.6, 0.55);
  tl.to(raysCss, { opacity: 0.6, duration: 2 }, T.s6 + 2);
  tl.to([letterTop, letterBottom], { scaleY: 0, duration: 1.6, ease: 'power3.inOut' }, T.s6 + 2.2);
  tl.to(rig, { pz: -183.6, duration: 6.4, ease: 'sine.out' }, T.s6 + 2.2);

  showScene(6, T.s6 + 1.0);
  charsIn($('.scene-6 .line:nth-child(1)'), T.s6 + 1.1);
  charsIn($('.scene-6 .line:nth-child(2)'), T.s6 + 1.7, { each: 0.04 });
  charsIn($('.scene-6 .sub'), T.s6 + 2.8, { each: 0.01, duration: 0.9 });
  blocksIn($$('.scene-6 .btn'), T.s6 + 3.3, 0.16);
  blocksIn($('.scene-6 .site-url'), T.s6 + 3.8);

  /* ---------- Voix off ---------- */
  // La réplique démarre à la position exacte de la timeline (même si l'image arrive un peu en retard)
  VOICE.forEach((line) => tl.call(() => audio.say(line, Math.max(0, tl.time() - line.t)), null, line.t));

  /* ---------- Fin ---------- */
  tl.to({}, { duration: 0.01 }, T.end);
}

/* ==========================================================
   19. CONTRÔLES & INTERFACE
   ========================================================== */
const btnPlay = $('#btnPlay');
const btnReplay = $('#btnReplay');
const btnHide = $('#btnHide');
const btnFull = $('#btnFull');
const progress = $('#progress');
const progressBar = $('#progressBar');
const timecode = $('#timecode');
const soundToggle = $('#soundToggle');
const soundIcon = $('#soundIcon');
const soundHint = $('#soundHint');

const ICON_MUTED = '<path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
const ICON_ON = '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>';

const fmt = (s) => {
  const v = Math.max(0, Math.floor(s));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

function buildMarks() {
  const marks = $('#progressMarks');
  [T.s2, T.s3, T.s4, T.s5, T.s6].forEach((t) => {
    const i = document.createElement('i');
    i.style.left = `${(t / T.end) * 100}%`;
    marks.appendChild(i);
  });
}

function onTimelineUpdate() {
  const p = tl.progress();
  const time = tl.time();
  progressBar.style.width = `${p * 100}%`;
  progress.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  timecode.textContent = `${fmt(time)} / ${fmt(T.end)}`;
  sc(6).classList.toggle('is-live', time > T.s6 + 3.2);
}

let loopTimer = null;
function onTimelineComplete() {
  btnPlay.classList.add('is-paused');
  btnPlay.setAttribute('aria-label', 'Lecture');
  if (LOOP) loopTimer = setTimeout(() => replay(), 7000);
}

/* Reprend la voix off exactement là où en est le clip (après pause, saut ou retour sur l'onglet) */
function resumeVoice() {
  if (!audio.enabled || tl.paused()) return;
  const time = tl.time();
  const line = [...VOICE].reverse().find((l) => l.t <= time);
  if (line) audio.say(line, time - line.t);
}

function play() {
  if (tl.progress() >= 1) { replay(); return; }
  tl.play();
  audio.resume();
  resumeVoice();
  btnPlay.classList.remove('is-paused');
  btnPlay.setAttribute('aria-label', 'Pause');
}

function pause() {
  tl.pause();
  audio.stopVoice();
  btnPlay.classList.add('is-paused');
  btnPlay.setAttribute('aria-label', 'Lecture');
}

function replay() {
  clearTimeout(loopTimer);
  audio.stopVoice();
  tl.restart();
  btnPlay.classList.remove('is-paused');
  btnPlay.setAttribute('aria-label', 'Pause');
}

function seek(ratio) {
  clearTimeout(loopTimer);
  audio.stopVoice();
  tl.progress(clamp(ratio, 0, 0.999), true);
  onTimelineUpdate();
  if (!btnPlay.classList.contains('is-paused')) { tl.play(); resumeVoice(); }
}

function toggleUI(force) {
  const hidden = force !== undefined ? force : !document.body.classList.contains('ui-hidden');
  document.body.classList.toggle('ui-hidden', hidden);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

async function toggleSound() {
  const on = !audio.enabled;
  await audio.setEnabled(on);
  soundToggle.classList.toggle('is-on', on);
  soundToggle.setAttribute('aria-pressed', String(on));
  soundToggle.setAttribute('aria-label', on ? 'Couper le son' : 'Activer le son');
  soundToggle.title = on ? 'Couper la voix off' : 'Activer la voix off';
  soundIcon.innerHTML = on ? ICON_ON : ICON_MUTED;
  gsap.to(soundHint, { autoAlpha: 0, x: 10, duration: 0.4 });
  if (on) resumeVoice();   // reprend la phrase en cours, calée sur l'image
}

soundToggle.addEventListener('click', toggleSound);
btnPlay.addEventListener('click', () => (tl.paused() || tl.progress() >= 1 ? play() : pause()));
btnReplay.addEventListener('click', replay);
btnHide.addEventListener('click', () => toggleUI(true));
btnFull.addEventListener('click', toggleFullscreen);

progress.addEventListener('pointerdown', (e) => {
  const rect = progress.getBoundingClientRect();
  seek((e.clientX - rect.left) / rect.width);
});
progress.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') seek(tl.progress() + 0.05);
  if (e.key === 'ArrowLeft') seek(tl.progress() - 0.05);
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && e.target === document.body) {
    e.preventDefault();
    if (tl.paused() || tl.progress() >= 1) play(); else pause();
  }
  if (k === 'r') replay();
  if (k === 'h') toggleUI();
  if (k === 'f') toggleFullscreen();
  if (k === 'm') toggleSound();
  if (k === 'escape') toggleUI(false);
});

/* Souris / tactile */
window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  pointer.active = true;
  pointer.last = performance.now();
  trail.add(e.clientX, e.clientY);
  if (document.body.classList.contains('ui-hidden') && !RECORD) {
    // L'interface reste masquée ; Échap ou H la réaffiche
  }
}, { passive: true });

document.addEventListener('pointerleave', () => { pointer.active = false; });
window.addEventListener('blur', () => { pointer.active = false; });

/* Onglet masqué : pause automatique */
let pausedByVisibility = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (!tl.paused()) { tl.pause(); pausedByVisibility = true; }
    audio.stopVoice();
    audio.suspend();
  } else {
    audio.resume();
    if (pausedByVisibility) { tl.play(); pausedByVisibility = false; resumeVoice(); }
  }
});

/* ==========================================================
   20. REDIMENSIONNEMENT
   ========================================================== */
let resizeTimer = null;
function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  // Le halo lumineux (bloom) est calculé à résolution réduite sur mobile : invisible à l'œil, 2 à 4 fois moins de pixels
  bloom.setSize(Math.round(w * Q.bloomScale), Math.round(h * Q.bloomScale));
  trail.resize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildLogoTargets, 200);
}
window.addEventListener('resize', onResize);

function setPixelRatio(pr) {
  pixelRatio = pr;
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  particleUniforms.uPixelRatio.value = pr;
  glowMaterials.forEach((m) => { m.uniforms.uPixelRatio.value = pr; });
  onResize();
}

/* ==========================================================
   21. BOUCLE DE RENDU
   - cadence adaptée à l'écran (90/120/144 Hz) ;
   - mode économie quand le clip est en pause ou terminé ;
   - qualité adaptative continue (résolution dynamique puis effets).
   ========================================================== */
const clock = new THREE.Clock();
let elapsed = 0;

/* Cadence : on mesure la fréquence de l'écran au démarrage */
const pace = { deltas: [], last: 0, hz: 60, skip: 1, count: 0, measured: false };
function updatePace(now) {
  if (pace.measured) return;
  if (pace.last) pace.deltas.push(now - pace.last);
  pace.last = now;
  if (pace.deltas.length < 40) return;
  const d = pace.deltas.sort((a, b) => a - b)[20];
  pace.hz = Math.round(1000 / d);
  pace.measured = true;
  // Animations du texte (GSAP) à la même cadence que la 3D sur les écrans 120 Hz
  if (Q.fps && skipFor(Q.fps) > 1) gsap.ticker.fps(Math.round(pace.hz / skipFor(Q.fps)));
}
/* Nombre d'images d'écran par image calculée : 120 Hz → 1 sur 2 (60 i/s), 90 Hz → toutes */
function skipFor(target) {
  return target ? Math.max(1, Math.floor(pace.hz / target + 0.25)) : 1;
}

/* Qualité adaptative : si l'appareil n'arrive pas à suivre, on allège
   d'abord la résolution (par paliers), puis les effets les plus coûteux. */
const gov = { started: false, base: pixelRatio, scale: 1, level: 0, frames: 0, t0: 0, good: 0, lastChange: 0 };
const DEGRADE = [
  () => { if (!bokeh.enabled) return false; bokeh.enabled = false; return true; },
  () => { if (!afterimage.enabled) return false; afterimage.enabled = false; return true; },
  () => { if (Q.bloomScale <= 0.5) return false; Q.bloomScale = 0.5; onResize(); return true; },
  () => { particleGeo.setDrawRange(0, Math.floor(Q.particles * 0.7)); return true; },
];
function applyScale() {
  setPixelRatio(Math.max(0.45, Math.round(gov.base * gov.scale * 100) / 100));
}
function govern(now, target) {
  if (!gov.t0) { gov.t0 = now; gov.frames = 0; return; }
  gov.frames++;
  const span = now - gov.t0;
  if (span < 1000) return;
  const fps = (gov.frames * 1000) / span;
  gov.t0 = now;
  gov.frames = 0;
  if (fps < target * 0.85) {
    gov.good = 0;
    if (now - gov.lastChange < 1500) return;
    gov.lastChange = now;
    if (gov.scale > Q.minScale + 0.01) {
      gov.scale = Math.max(Q.minScale, gov.scale - 0.1);
      applyScale();
    } else {
      while (gov.level < DEGRADE.length && !DEGRADE[gov.level++]()) { /* palier suivant */ }
    }
  } else if (fps > target * 0.95) {
    // Remontée prudente de la résolution si l'appareil a de la marge
    if (++gov.good >= 4 && gov.scale < 1 && now - gov.lastChange > 4000) {
      gov.scale = Math.min(1, gov.scale + 0.05);
      gov.lastChange = now;
      gov.good = 0;
      applyScale();
    }
  } else {
    gov.good = 0;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  updatePace(now);

  // Pause ou clip terminé, sans interaction : 30 i/s suffisent (économie de batterie)
  const idle = (tl.paused() || tl.progress() >= 1) && now - pointer.last > 3000;
  const target = idle ? 30 : Q.fps;
  pace.skip = skipFor(target);
  if (++pace.count % pace.skip !== 0) return;

  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  particleUniforms.uTime.value = elapsed;
  floorGrid.material.uniforms.uTime.value = elapsed;
  ceilGrid.material.uniforms.uTime.value = elapsed;
  floorGrid.material.uniforms.uCam.value.copy(camera.position);
  ceilGrid.material.uniforms.uCam.value.copy(camera.position);
  streamMat.uniforms.uTime.value = elapsed;
  rays.children.forEach((pivot) => { pivot.rotation.z += dt * pivot.userData.speed; });

  network.update(dt);
  updatePanels(elapsed);
  updateHolo(elapsed, dt);
  sparks.update(dt);
  applyCamera(elapsed);

  composer.render(dt);
  trail.draw();

  // Pendant un enregistrement vidéo, la qualité reste fixe (image homogène du début à la fin)
  if (gov.started && !idle && pace.measured && !document.body.classList.contains('is-recording')) govern(now, pace.hz / pace.skip);
  else gov.t0 = 0;
}

/* ==========================================================
   22. DÉMARRAGE
   ========================================================== */
async function start() {
  setLoad(0.25);
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('700 120px "Space Grotesk"'),
        document.fonts.load('500 20px Inter'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* police de secours */ }
  setLoad(0.5);

  buildLogoTargets();
  buildPanels();
  setLoad(0.7);
  buildTimeline();
  buildMarks();

  // Compilation des shaders en parallèle quand le navigateur le permet (ne fige pas la page)
  try {
    if (renderer.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile')) {
      await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 4000))]);
    } else {
      renderer.compile(scene, camera);
    }
  } catch (e) { renderer.compile(scene, camera); }
  composer.render(0.016);
  setLoad(1);
  // Sans carte graphique, ce calcul prendrait plusieurs secondes : on garde l'éclairage simple
  if (TIER !== 'soft') deferTask(buildEnvironment);
  deferTask(() => audio.fetchVoices());   // voix off téléchargée en arrière-plan (≈ 210 Ko)

  requestAnimationFrame(frame);

  gsap.to('#loader', {
    autoAlpha: 0,
    duration: 0.9,
    delay: 0.35,
    ease: 'power2.inOut',
    onComplete: () => {
      $('#loader').remove();
      gov.started = true;
      tl.play(0);
      if (RECORD) {
        toggleUI(true);
      } else {
        gsap.to(['.hud-top', '.sound-toggle', '.controls'], { opacity: 1, duration: 1, stagger: 0.12, ease: 'power2.out', delay: 0.6 });
        gsap.fromTo(soundHint, { autoAlpha: 0, x: 10 }, { autoAlpha: 1, x: 0, duration: 0.6, delay: 1.6 });
        gsap.to(soundHint, { autoAlpha: 0, x: 10, duration: 0.6, delay: 9 });
      }
    },
  });
}

/* Mode test : ?debug permet de se placer à un instant précis (window.__seek(secondes)) */
if (params.has('debug')) {
  window.__seek = (s) => { tl.pause(); tl.seek(s, true); onTimelineUpdate(); };
  window.__tl = tl;
  window.__perf = () => ({ tier: TIER, gpu: GL_PROBE.gpu, gpuClass: GPU, hz: pace.hz, skip: pace.skip, pixelRatio, scale: gov.scale, level: gov.level, liteFx: LITE_FX });
}

/* ==========================================================
   23. ENREGISTREMENT & TÉLÉCHARGEMENT DE LA VIDÉO (recorder.js)
   Chargé séparément : en cas de problème, le clip fonctionne normalement.
   ========================================================== */
import('./recorder.js?v=20261110')
  .then(({ initRecorder }) => initRecorder({
    tl, T, audio, replay, toggleUI, toggleSound,
    controls: $('#controls'),
    before: btnHide,
  }))
  .catch((e) => console.warn('Enregistrement vidéo indisponible :', e));

start();
