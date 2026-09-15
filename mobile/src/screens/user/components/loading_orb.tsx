/**
 * Strands Sentinel - LoadingOrb WebGL Component
 * Renders a glassy, slowly-deforming blob with swirling liquid inside,
 * a silhouette-external glow, glassy rim Fresnel, and dual specular glints.
 * Powered by Expo WebGL (expo-gl) and Three.js ShaderMaterial.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  StyleProp,
  ViewStyle,
  Animated,
  PixelRatio,
} from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export interface OrbPresetValues {
  radius: number;
  deform: number;
  frequency: number;
  morphSpeed: number;
  rotSpeed: number;
  specular: number;
  shininess: number;
  glowStrength: number;
  colorBlue: string;
  colorMagenta: string;
  glowA: string;
  glowB: string;
  liquidSpeed: number;
  liquidScale: number;
  liquidBright: number;
  filament: number;
  core: number;
  background: string;
  blend?: number;
}

export const ORB_PRESETS: Record<string, OrbPresetValues> = {
  Neon: {
    radius: 0.30,
    deform: 0.40,
    frequency: 2.2,
    morphSpeed: 1.35,
    rotSpeed: 0.14,
    specular: 1.2,
    shininess: 160,
    glowStrength: 0.90,
    colorBlue: '#00F0FF',      // Cyber cyan interior accent
    colorMagenta: '#0DF272',   // Sentinel Neon Green primary
    glowA: '#00FF66',          // Bright Neon glow
    glowB: '#0DF272',          // Pure Neon green rim
    liquidSpeed: 0.65,
    liquidScale: 2.40,
    liquidBright: 1.15,
    filament: 1.80,
    core: 0.35,
    background: '#04140A',
    blend: 0,
  },
  Aurora: {
    radius: 0.30,
    deform: 0.36,
    frequency: 2.0,
    morphSpeed: 1.30,
    rotSpeed: 0.12,
    specular: 1.0,
    shininess: 140,
    glowStrength: 0.70,
    colorBlue: '#4099FF',
    colorMagenta: '#E633BF',
    glowA: '#33B5FF',
    glowB: '#E24DD0',
    liquidSpeed: 0.50,
    liquidScale: 2.20,
    liquidBright: 1.00,
    filament: 1.40,
    core: 0.30,
    background: '#070A18',
    blend: 0,
  },
  Ember: {
    radius: 0.32,
    deform: 0.30,
    frequency: 2.1,
    morphSpeed: 1.40,
    rotSpeed: 0.10,
    specular: 1.2,
    shininess: 120,
    glowStrength: 0.85,
    colorBlue: '#FFC24D',
    colorMagenta: '#FF3B2F',
    glowA: '#FF7A18',
    glowB: '#FF2D55',
    liquidSpeed: 0.75,
    liquidScale: 2.40,
    liquidBright: 1.10,
    filament: 1.90,
    core: 0.40,
    background: '#160806',
    blend: 0,
  },
  Toxic: {
    radius: 0.28,
    deform: 0.44,
    frequency: 2.3,
    morphSpeed: 1.50,
    rotSpeed: 0.18,
    specular: 1.0,
    shininess: 160,
    glowStrength: 0.75,
    colorBlue: '#9CFF4D',
    colorMagenta: '#00E5A0',
    glowA: '#57FF3C',
    glowB: '#00FFC8',
    liquidSpeed: 0.85,
    liquidScale: 2.60,
    liquidBright: 1.00,
    filament: 1.70,
    core: 0.25,
    background: '#04120C',
    blend: 0,
  },
  Ice: {
    radius: 0.34,
    deform: 0.20,
    frequency: 1.8,
    morphSpeed: 1.18,
    rotSpeed: 0.08,
    specular: 1.5,
    shininess: 210,
    glowStrength: 0.60,
    colorBlue: '#9CE3FF',
    colorMagenta: '#E6F7FF',
    glowA: '#6FD2FF',
    glowB: '#BFEFFF',
    liquidSpeed: 0.32,
    liquidScale: 2.00,
    liquidBright: 0.90,
    filament: 1.00,
    core: 0.35,
    background: '#0A1424',
    blend: 0,
  },
  Plasma: {
    radius: 0.28,
    deform: 0.40,
    frequency: 2.4,
    morphSpeed: 1.60,
    rotSpeed: 0.20,
    specular: 1.0,
    shininess: 130,
    glowStrength: 0.95,
    colorBlue: '#B14DFF',
    colorMagenta: '#FF2DA0',
    glowA: '#9B5CFF',
    glowB: '#FF3DBE',
    liquidSpeed: 1.00,
    liquidScale: 2.80,
    liquidBright: 1.20,
    filament: 2.10,
    core: 0.30,
    background: '#10061C',
    blend: 0,
  },
  Ghost: {
    radius: 0.32,
    deform: 0.30,
    frequency: 2.0,
    morphSpeed: 1.25,
    rotSpeed: 0.10,
    specular: 1.6,
    shininess: 220,
    glowStrength: 0.55,
    colorBlue: '#C2CBE6',
    colorMagenta: '#8893B5',
    glowA: '#AEB8D8',
    glowB: '#6E7799',
    liquidSpeed: 0.45,
    liquidScale: 2.20,
    liquidBright: 0.85,
    filament: 1.20,
    core: 0.20,
    background: '#070709',
    blend: 0,
  },
  Daylight: {
    radius: 0.30,
    deform: 0.34,
    frequency: 2.0,
    morphSpeed: 1.30,
    rotSpeed: 0.12,
    specular: 1.0,
    shininess: 150,
    glowStrength: 0.80,
    colorBlue: '#2D6CFF',
    colorMagenta: '#B43CF0',
    glowA: '#3A82FF',
    glowB: '#A84DFF',
    liquidSpeed: 0.50,
    liquidScale: 2.20,
    liquidBright: 1.05,
    filament: 1.50,
    core: 0.30,
    background: '#EEF2F8',
    blend: 1.0,
  },
};

export interface LoadingOrbProps {
  size?: number;
  preset?: keyof typeof ORB_PRESETS;
  radius?: number;
  deform?: number;
  frequency?: number;
  morphSpeed?: number;
  rotSpeed?: number;
  specular?: number;
  shininess?: number;
  glowStrength?: number;
  colorBlue?: string;
  colorMagenta?: string;
  glowA?: string;
  glowB?: string;
  liquidSpeed?: number;
  liquidScale?: number;
  liquidBright?: number;
  filament?: number;
  core?: number;
  background?: string;
  blend?: number;
  transparent?: boolean;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}

function hexToRgbVector(hex: string, target: THREE.Vector3): THREE.Vector3 {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (isNaN(n)) {
    target.set(1, 1, 1);
  } else {
    target.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  return target;
}

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;

  uniform float u_time;
  uniform vec2  u_res;
  uniform float u_radius;
  uniform float u_deform;
  uniform float u_freq;
  uniform float u_morphSpeed;
  uniform float u_rotSpeed;
  uniform float u_specular;
  uniform float u_shininess;
  uniform float u_glowStrength;
  uniform vec3  u_colBlue;
  uniform vec3  u_colMag;
  uniform vec3  u_glowA;
  uniform vec3  u_glowB;
  uniform float u_liquidSpeed;
  uniform float u_liquidScale;
  uniform float u_liquidBright;
  uniform float u_filament;
  uniform float u_core;
  uniform vec3  u_bg;
  uniform float u_blend;
  uniform float u_transparent;

  mat2 rot(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float blobField(vec3 p) {
    float t = u_time * u_morphSpeed;
    float f = u_freq;
    float d = 0.0;
    d += sin(p.x * 2.6 * f + t * 1.00);
    d += sin(p.y * 2.9 * f - t * 0.80 + 1.3);
    d += sin(p.z * 3.2 * f + t * 1.20 + 2.7);
    d += sin((p.x + p.z) * 2.2 * f - t * 0.90 + 4.1);
    d += sin((p.y - p.x) * 2.4 * f + t * 0.70 + 0.6);
    return d * 0.2;
  }

  float mapBlob(vec3 p) {
    float t = u_time * u_rotSpeed;
    p.xy = rot(t * 0.7) * p.xy;
    p.yz = rot(t * 0.5) * p.yz;
    float r = u_radius + u_deform * blobField(p);
    return length(p) - r;
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0015, 0.0);
    return normalize(vec3(
      mapBlob(p + e.xyy) - mapBlob(p - e.xyy),
      mapBlob(p + e.yxy) - mapBlob(p - e.yxy),
      mapBlob(p + e.yyx) - mapBlob(p - e.yyx)
    ));
  }

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash13(i + vec3(0.0, 0.0, 0.0)), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise3(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  float liquid(vec3 p) {
    float t = u_time * u_liquidSpeed;
    p *= u_liquidScale;
    p.xy = rot(t * 0.15) * p.xy;
    p.yz = rot(t * 0.10) * p.yz;
    vec3 w = vec3(
      fbm3(p + t * 0.2),
      fbm3(p + vec3(4.3, 1.2, -t * 0.15)),
      fbm3(p.zxy + vec3(7.7, 2.3, t * 0.10))
    );
    return fbm3(p + 1.8 * w);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= u_res.x / u_res.y;

    vec3 ro = vec3(0.0, 0.0, 3.0);
    vec3 rd = normalize(vec3(p, -1.8));

    float t = 0.0;
    bool hit = false;
    vec3 pos = ro;
    float minD = 1000.0;
    for (int i = 0; i < 110; i++) {
      pos = ro + rd * t;
      float d = mapBlob(pos);
      minD = min(minD, d);
      if (d < 0.001) {
        hit = true;
        break;
      }
      t += d * 0.40;
      if (t > 6.0) break;
    }

    vec3 E = vec3(0.0);

    if (hit) {
      vec3 n = calcNormal(pos);
      vec3 v = -rd;
      float fres = pow(clamp(1.0 - max(dot(n, v), 0.0), 0.0, 1.0), 3.0);

      vec3 rp = pos + rd * 0.04;
      float trans = 1.0;
      vec3 inner = vec3(0.0);
      for (int k = 0; k < 10; k++) {
        float raw = liquid(rp);
        float dens = smoothstep(0.30, 0.70, raw);
        float fil = pow(clamp(1.0 - abs(2.0 * raw - 1.0), 0.0, 1.0), 5.0);
        vec3 c = mix(u_colMag, u_colBlue, 0.5 + 0.5 * sin(raw * 6.0 + u_time * 0.3 + rp.y * 2.5));
        vec3 emit = c * dens * 0.55 + c * fil * u_filament + vec3(1.0) * pow(fil, 3.0) * u_filament * 0.4;
        emit += u_colBlue * smoothstep(0.5, 0.0, length(rp)) * u_core;
        inner += trans * emit * 0.17;
        trans *= 0.84;
        rp += rd * 0.11;
        if (length(rp) > 1.0) break;
      }
      E += inner * (1.0 - fres * 0.6) * u_liquidBright;

      vec3 rim = mix(u_colMag, u_colBlue, 0.5 + 0.5 * (n.x * 0.7 + n.y * 0.45));
      E += rim * fres * 1.3;
      vec3 l1 = normalize(vec3(0.6, 0.85, 0.6));
      vec3 l2 = normalize(vec3(-0.7, 0.25, 0.55));
      vec3 h1 = normalize(l1 + v);
      vec3 h2 = normalize(l2 + v);
      E += vec3(1.0) * pow(max(dot(n, h1), 0.0), u_shininess) * 1.3 * u_specular;
      E += vec3(0.8, 0.9, 1.0) * pow(max(dot(n, h2), 0.0), u_shininess * 0.45) * 0.6 * u_specular;
    } else {
      float g = exp(-minD * 5.5);
      float ang = atan(rd.y, rd.x);
      vec3 gc = mix(u_glowA, u_glowB, 0.5 + 0.5 * sin(ang * 3.0 + u_time * 0.5));
      E += (gc * g * 1.4 + vec3(0.6, 0.8, 1.0) * pow(g, 3.0) * 0.7) * u_glowStrength;
    }

    vec3 glowCol = u_bg + E;
    float cov = clamp(max(E.r, max(E.g, E.b)), 0.0, 1.0);
    vec3 inkCol = mix(u_bg, E / (1.0 + E), cov);
    vec3 col = mix(glowCol, inkCol, u_blend);

    if (u_transparent > 0.5) {
      float alpha = clamp(cov * 1.4, 0.0, 1.0);
      gl_FragColor = vec4(clamp(E, 0.0, 1.0), alpha);
    } else {
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  }
`;

export function LoadingOrb({
  size = 150,
  preset = 'Neon',
  radius,
  deform,
  frequency,
  morphSpeed,
  rotSpeed,
  specular,
  shininess,
  glowStrength,
  colorBlue,
  colorMagenta,
  glowA,
  glowB,
  liquidSpeed,
  liquidScale,
  liquidBright,
  filament,
  core,
  background,
  blend,
  transparent = true,
  active = true,
  style,
}: LoadingOrbProps) {
  const fadeAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const [shouldRender, setShouldRender] = useState(active);

  const rafIdRef = useRef<number>(0);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const geometryRef = useRef<THREE.PlaneGeometry | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const glRef = useRef<ExpoWebGLRenderingContext | null>(null);
  const isLoopRunningRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Resolve preset fallback
  const pVals = ORB_PRESETS[preset] || ORB_PRESETS.Neon;

  const currentPropsRef = useRef({
    radius: radius ?? pVals.radius,
    deform: deform ?? pVals.deform,
    frequency: frequency ?? pVals.frequency,
    morphSpeed: morphSpeed ?? pVals.morphSpeed,
    rotSpeed: rotSpeed ?? pVals.rotSpeed,
    specular: specular ?? pVals.specular,
    shininess: shininess ?? pVals.shininess,
    glowStrength: glowStrength ?? pVals.glowStrength,
    liquidSpeed: liquidSpeed ?? pVals.liquidSpeed,
    liquidScale: liquidScale ?? pVals.liquidScale,
    liquidBright: liquidBright ?? pVals.liquidBright,
    filament: filament ?? pVals.filament,
    core: core ?? pVals.core,
    blend: blend ?? pVals.blend ?? 0,
    transparent: transparent ? 1.0 : 0.0,
  });

  currentPropsRef.current = {
    radius: radius ?? pVals.radius,
    deform: deform ?? pVals.deform,
    frequency: frequency ?? pVals.frequency,
    morphSpeed: morphSpeed ?? pVals.morphSpeed,
    rotSpeed: rotSpeed ?? pVals.rotSpeed,
    specular: specular ?? pVals.specular,
    shininess: shininess ?? pVals.shininess,
    glowStrength: glowStrength ?? pVals.glowStrength,
    liquidSpeed: liquidSpeed ?? pVals.liquidSpeed,
    liquidScale: liquidScale ?? pVals.liquidScale,
    liquidBright: liquidBright ?? pVals.liquidBright,
    filament: filament ?? pVals.filament,
    core: core ?? pVals.core,
    blend: blend ?? pVals.blend ?? 0,
    transparent: transparent ? 1.0 : 0.0,
  };

  const colBlueVecRef = useRef(new THREE.Vector3());
  const colMagVecRef = useRef(new THREE.Vector3());
  const glowAVecRef = useRef(new THREE.Vector3());
  const glowBVecRef = useRef(new THREE.Vector3());
  const bgVecRef = useRef(new THREE.Vector3());

  // Update uniform colors when props/presets change
  useEffect(() => {
    hexToRgbVector(colorBlue ?? pVals.colorBlue, colBlueVecRef.current);
    hexToRgbVector(colorMagenta ?? pVals.colorMagenta, colMagVecRef.current);
    hexToRgbVector(glowA ?? pVals.glowA, glowAVecRef.current);
    hexToRgbVector(glowB ?? pVals.glowB, glowBVecRef.current);
    hexToRgbVector(background ?? pVals.background, bgVecRef.current);

    if (materialRef.current) {
      const u = materialRef.current.uniforms;
      u.u_colBlue.value.copy(colBlueVecRef.current);
      u.u_colMag.value.copy(colMagVecRef.current);
      u.u_glowA.value.copy(glowAVecRef.current);
      u.u_glowB.value.copy(glowBVecRef.current);
      u.u_bg.value.copy(bgVecRef.current);
    }
  }, [
    preset,
    pVals,
    colorBlue,
    colorMagenta,
    glowA,
    glowB,
    background,
  ]);

  // Smooth fade-in / fade-out
  useEffect(() => {
    if (active) {
      setShouldRender(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }).start();
      if (!isLoopRunningRef.current && glRef.current) {
        startAnimationLoop();
      }
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && !activeRef.current) {
          setShouldRender(false);
          if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = 0;
          }
          isLoopRunningRef.current = false;
        }
      });
    }
  }, [active, fadeAnim]);

  const startAnimationLoop = useCallback(() => {
    if (isLoopRunningRef.current) return;
    isLoopRunningRef.current = true;

    const startTime = performance.now();

    const animate = () => {
      try {
        if (!isLoopRunningRef.current) return;

        rafIdRef.current = requestAnimationFrame(animate);

        const now = performance.now();
        const elapsed = (now - startTime) * 0.001;

        const gl = glRef.current;
        const renderer = rendererRef.current;
        const material = materialRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;

        if (!gl || !renderer || !material || !scene || !camera) return;

        const cp = currentPropsRef.current;
        const u = material.uniforms;

        u.u_time.value = elapsed;
        u.u_radius.value = cp.radius;
        u.u_deform.value = cp.deform;
        u.u_freq.value = cp.frequency;
        u.u_morphSpeed.value = cp.morphSpeed;
        u.u_rotSpeed.value = cp.rotSpeed;
        u.u_specular.value = cp.specular;
        u.u_shininess.value = cp.shininess;
        u.u_glowStrength.value = cp.glowStrength;
        u.u_liquidSpeed.value = cp.liquidSpeed;
        u.u_liquidScale.value = cp.liquidScale;
        u.u_liquidBright.value = cp.liquidBright;
        u.u_filament.value = cp.filament;
        u.u_core.value = cp.core;
        u.u_blend.value = cp.blend;
        u.u_transparent.value = cp.transparent;

        renderer.render(scene, camera);
        gl.endFrameEXP();
      } catch (err) {
        console.error('[LoadingOrb] Render loop error:', err);
      }
    };

    animate();
  }, []);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        glRef.current = gl;

        // Clamp DPR to 1.5 for locked 60fps mobile performance
        const dpr = Math.min(PixelRatio.get?.() || 1, 1.5);
        const glWidth = Math.round(size * dpr);
        const glHeight = Math.round(size * dpr);

        hexToRgbVector(colorBlue ?? pVals.colorBlue, colBlueVecRef.current);
        hexToRgbVector(colorMagenta ?? pVals.colorMagenta, colMagVecRef.current);
        hexToRgbVector(glowA ?? pVals.glowA, glowAVecRef.current);
        hexToRgbVector(glowB ?? pVals.glowB, glowBVecRef.current);
        hexToRgbVector(background ?? pVals.background, bgVecRef.current);

        const canvas = {
          width: glWidth,
          height: glHeight,
          clientWidth: glWidth,
          clientHeight: glHeight,
          style: {},
          addEventListener: () => {},
          removeEventListener: () => {},
          getContext: (type: string) => {
            if (type === 'webgl2' || type === 'webgl') return gl;
            return null;
          },
          toDataURL: () => '',
          setAttribute: () => {},
          getRootNode: () => canvas,
          ownerDocument: {
            createElementNS: (_ns: string, tag: string) => {
              if (tag === 'canvas') return canvas;
              if (tag === 'img') return { set src(_: string) {}, set crossOrigin(_: string) {} };
              return {};
            },
          },
        } as unknown as HTMLCanvasElement;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: false,
          alpha: true,
          powerPreference: 'high-performance',
        });
        renderer.setSize(glWidth, glHeight, false);
        renderer.setPixelRatio(1);
        rendererRef.current = renderer;

        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
        camera.position.set(0, 0, 1);
        cameraRef.current = camera;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const geometry = new THREE.PlaneGeometry(2, 2);
        geometryRef.current = geometry;

        const cp = currentPropsRef.current;
        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          uniforms: {
            u_time: { value: 0 },
            u_res: { value: new THREE.Vector2(glWidth, glHeight) },
            u_radius: { value: cp.radius },
            u_deform: { value: cp.deform },
            u_freq: { value: cp.frequency },
            u_morphSpeed: { value: cp.morphSpeed },
            u_rotSpeed: { value: cp.rotSpeed },
            u_specular: { value: cp.specular },
            u_shininess: { value: cp.shininess },
            u_glowStrength: { value: cp.glowStrength },
            u_colBlue: { value: colBlueVecRef.current.clone() },
            u_colMag: { value: colMagVecRef.current.clone() },
            u_glowA: { value: glowAVecRef.current.clone() },
            u_glowB: { value: glowBVecRef.current.clone() },
            u_liquidSpeed: { value: cp.liquidSpeed },
            u_liquidScale: { value: cp.liquidScale },
            u_liquidBright: { value: cp.liquidBright },
            u_filament: { value: cp.filament },
            u_core: { value: cp.core },
            u_bg: { value: bgVecRef.current.clone() },
            u_blend: { value: cp.blend },
            u_transparent: { value: cp.transparent },
          },
        });
        materialRef.current = material;

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        startAnimationLoop();
      } catch (err) {
        console.error('[LoadingOrb] GL initialization error:', err);
      }
    },
    [size, pVals, colorBlue, colorMagenta, glowA, glowB, background, startAnimationLoop],
  );

  useEffect(() => {
    return () => {
      isLoopRunningRef.current = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      geometryRef.current?.dispose();
      materialRef.current?.dispose();
      rendererRef.current?.dispose();
      glRef.current = null;
    };
  }, []);

  if (!shouldRender && !active) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          width: size,
          height: size,
          opacity: fadeAnim,
        },
        style,
      ]}
    >
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

export default LoadingOrb;
