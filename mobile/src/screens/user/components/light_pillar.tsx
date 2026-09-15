import React, { useCallback, useEffect, useRef } from 'react';
import { View, StyleSheet, useWindowDimensions, StyleProp, ViewStyle, PixelRatio } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export interface LightPillarProps {
  topColor?: string;
  bottomColor?: string;
  intensity?: number;
  rotationSpeed?: number;
  interactive?: boolean;
  glowAmount?: number;
  pillarWidth?: number;
  pillarHeight?: number;
  noiseIntensity?: number;
  pillarRotation?: number;
  quality?: 'low' | 'medium' | 'high';
  lightMode?: boolean;
  style?: StyleProp<ViewStyle>;
}

// Mobile-optimized quality presets to guarantee consistent 60fps
const QUALITY_SETTINGS = {
  low: { iterations: 20, waveIterations: 1, stepMultiplier: 1.6 },
  medium: { iterations: 30, waveIterations: 1, stepMultiplier: 1.3 },
  high: { iterations: 40, waveIterations: 2, stepMultiplier: 1.15 },
};

function parseColorToVector(hex: string, target: THREE.Vector3): THREE.Vector3 {
  const c = new THREE.Color(hex);
  target.set(c.r, c.g, c.b);
  return target;
}

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

function buildFragmentShader(settings: { iterations: number; waveIterations: number; stepMultiplier: number }) {
  return `
    precision mediump float;

    uniform float uTime;
    uniform vec2 uResolution;
    uniform vec2 uMouse;
    uniform vec3 uTopColor;
    uniform vec3 uBottomColor;
    uniform float uIntensity;
    uniform bool uInteractive;
    uniform float uGlowAmount;
    uniform float uPillarWidth;
    uniform float uPillarHeight;
    uniform float uNoiseIntensity;
    uniform float uLightMode;
    uniform float uRotCos;
    uniform float uRotSin;
    uniform float uPillarRotCos;
    uniform float uPillarRotSin;
    uniform float uWaveSin;
    uniform float uWaveCos;
    varying vec2 vUv;

    const float STEP_MULT = ${settings.stepMultiplier.toFixed(2)};
    const int MAX_ITER = ${settings.iterations};
    const int WAVE_ITER = ${settings.waveIterations};

    // Safe tanh for full cross-platform mobile GPU support (GLSL ES 1.0 & 3.0)
    vec3 safe_tanh(vec3 x) {
      vec3 e2x = exp(clamp(x * 2.0, -20.0, 20.0));
      return (e2x - vec3(1.0)) / (e2x + vec3(1.0));
    }

    void main() {
      // Aspect-corrected UV space
      vec2 uv = (vUv * 2.0 - 1.0) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);

      // Zoom out: broaden field-of-view so the full pillar and ambiance fit gracefully
      uv *= 1.45;

      // Rotate pillar coordinate system
      uv = vec2(uPillarRotCos * uv.x - uPillarRotSin * uv.y, uPillarRotSin * uv.x + uPillarRotCos * uv.y);

      vec3 ro = vec3(0.0, 0.0, -10.0);
      vec3 rd = normalize(vec3(uv, 1.0));

      float rotC = uRotCos;
      float rotS = uRotSin;

      vec3 col = vec3(0.0);
      float t = 0.1;
      
      for(int i = 0; i < MAX_ITER; i++) {
        vec3 p = ro + rd * t;
        p.xz = vec2(rotC * p.x - rotS * p.z, rotS * p.x + rotC * p.z);

        vec3 q = p;
        q.y = p.y * uPillarHeight + uTime;
        
        float freq = 1.0;
        float amp = 1.0;
        for(int j = 0; j < WAVE_ITER; j++) {
          q.xz = vec2(uWaveCos * q.x - uWaveSin * q.z, uWaveSin * q.x + uWaveCos * q.z);
          q += cos(q.zxy * freq - vec3(uTime * float(j) * 2.0)) * amp;
          freq *= 2.0;
          amp *= 0.5;
        }
        
        float d = length(cos(q.xz)) - 0.2;
        float bound = length(p.xz) - uPillarWidth;
        float k = 4.0;
        float h = max(k - abs(d - bound), 0.0);
        d = max(d, bound) + h * h * 0.0625 / k;
        d = abs(d) * 0.15 + 0.01;

        float grad = clamp((15.0 - p.y) / 30.0, 0.0, 1.0);
        col += mix(uBottomColor, uTopColor, grad) / d;

        t += d * STEP_MULT;
        if(t > 50.0) break;
      }

      float widthNorm = uPillarWidth / 3.0;
      col = safe_tanh(col * (uGlowAmount / widthNorm));
      
      float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 15.0 * uNoiseIntensity;
      col -= vec3(noise);
      
      vec3 result = clamp(col * uIntensity, 0.0, 1.0);
      if (uLightMode > 0.5) {
        float energy = max(result.r, max(result.g, result.b));
        vec3 hue = result / max(energy, 0.001);
        float coverage = smoothstep(0.025, 0.95, energy);
        hue = pow(clamp(hue, 0.0, 1.0), vec3(1.25));
        result = mix(vec3(1.0), hue, coverage * 0.94);
      }
      float alpha = clamp(max(result.r, max(result.g, result.b)) * 1.5, 0.0, 1.0);
      gl_FragColor = vec4(result, alpha);
    }
  `;
}

export function LightPillar({
  topColor = '#00F0FF',
  bottomColor = '#0DF272',
  intensity = 1.1,
  rotationSpeed = 0.3,
  interactive = false,
  glowAmount = 0.005,
  pillarWidth = 2.4,
  pillarHeight = 0.38,
  noiseIntensity = 0.4,
  pillarRotation = 25,
  quality = 'medium',
  lightMode = false,
  style,
}: LightPillarProps) {
  const { width, height } = useWindowDimensions();
  const rafIdRef = useRef<number>(0);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const geometryRef = useRef<THREE.PlaneGeometry | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const timeRef = useRef(0);
  const lastFrameRef = useRef(0);

  // Pre-allocated color vectors to eliminate per-frame GC garbage in Hermes
  const topColorVecRef = useRef(new THREE.Vector3());
  const bottomColorVecRef = useRef(new THREE.Vector3());

  const settings = QUALITY_SETTINGS[quality] || QUALITY_SETTINGS.medium;
  const pillarRotRad = (pillarRotation * Math.PI) / 180;
  const waveSin = Math.sin(0.4);
  const waveCos = Math.cos(0.4);

  // Keep colors updated in the pre-allocated vectors without allocating on render
  useEffect(() => {
    parseColorToVector(topColor, topColorVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uTopColor.value.copy(topColorVecRef.current);
    }
  }, [topColor]);

  useEffect(() => {
    parseColorToVector(bottomColor, bottomColorVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uBottomColor.value.copy(bottomColorVecRef.current);
    }
  }, [bottomColor]);

  // Store latest numerical props in ref for zero-allocation loop reads
  const propsRef = useRef({
    intensity,
    rotationSpeed,
    interactive,
    glowAmount,
    pillarWidth,
    pillarHeight,
    noiseIntensity,
    lightMode,
    pillarRotRad,
    waveSin,
    waveCos,
  });
  propsRef.current = {
    intensity,
    rotationSpeed,
    interactive,
    glowAmount,
    pillarWidth,
    pillarHeight,
    noiseIntensity,
    lightMode,
    pillarRotRad,
    waveSin,
    waveCos,
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      geometryRef.current?.dispose();
      materialRef.current?.dispose();
      rendererRef.current?.dispose();
    };
  }, []);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        const fallbackWidth = Math.round(width * (PixelRatio.get?.() || 2));
        const fallbackHeight = Math.round(height * (PixelRatio.get?.() || 2));
        const glWidth = (gl.drawingBufferWidth && gl.drawingBufferWidth > 0) ? gl.drawingBufferWidth : fallbackWidth;
        const glHeight = (gl.drawingBufferHeight && gl.drawingBufferHeight > 0) ? gl.drawingBufferHeight : fallbackHeight;

        // Initialize pre-allocated colors
        parseColorToVector(topColor, topColorVecRef.current);
        parseColorToVector(bottomColor, bottomColorVecRef.current);

        // Lightweight canvas shim for Three.js
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

        // Full-screen orthographic camera
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
        camera.position.set(0, 0, 1);
        cameraRef.current = camera;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const geometry = new THREE.PlaneGeometry(2, 2);
        geometryRef.current = geometry;

        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: buildFragmentShader(settings),
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          uniforms: {
            uTime: { value: 0 },
            uResolution: {
              value: new THREE.Vector2(glWidth, glHeight),
            },
            uMouse: { value: new THREE.Vector2(0, 0) },
            uTopColor: { value: topColorVecRef.current.clone() },
            uBottomColor: { value: bottomColorVecRef.current.clone() },
            uIntensity: { value: intensity },
            uInteractive: { value: interactive },
            uGlowAmount: { value: glowAmount },
            uPillarWidth: { value: pillarWidth },
            uPillarHeight: { value: pillarHeight },
            uNoiseIntensity: { value: noiseIntensity },
            uLightMode: { value: lightMode ? 1 : 0 },
            uRotCos: { value: 1.0 },
            uRotSin: { value: 0.0 },
            uPillarRotCos: { value: Math.cos(pillarRotRad) },
            uPillarRotSin: { value: Math.sin(pillarRotRad) },
            uWaveSin: { value: waveSin },
            uWaveCos: { value: waveCos },
          },
        });
        materialRef.current = material;

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        // High-performance animation loop (0 object allocations per tick)
        lastFrameRef.current = performance.now();
        timeRef.current = 0;

        let lastCheckedWidth = glWidth;
        let lastCheckedHeight = glHeight;

        const animate = () => {
          try {
            rafIdRef.current = requestAnimationFrame(animate);

            const now = performance.now();
            // Clamp delta to 16-50ms to prevent sudden visual stuttering on frame drop
            const delta = Math.min((now - lastFrameRef.current) / 1000, 0.05);
            lastFrameRef.current = now;

            const p = propsRef.current;
            timeRef.current += delta * p.rotationSpeed;
            const t = timeRef.current;

            // Handle resolution updates if device orientation changes
            const currentW = (gl.drawingBufferWidth && gl.drawingBufferWidth > 0) ? gl.drawingBufferWidth : glWidth;
            const currentH = (gl.drawingBufferHeight && gl.drawingBufferHeight > 0) ? gl.drawingBufferHeight : glHeight;
            if (currentW !== lastCheckedWidth || currentH !== lastCheckedHeight) {
              lastCheckedWidth = currentW;
              lastCheckedHeight = currentH;
              material.uniforms.uResolution.value.set(currentW, currentH);
              renderer.setSize(currentW, currentH, false);
            }

            // Update time & trig uniforms (direct scalar mutation, no allocations)
            const u = material.uniforms;
            u.uTime.value = t;
            u.uRotCos.value = Math.cos(t * 0.3);
            u.uRotSin.value = Math.sin(t * 0.3);
            u.uIntensity.value = p.intensity;
            u.uInteractive.value = p.interactive;
            u.uGlowAmount.value = p.glowAmount;
            u.uPillarWidth.value = p.pillarWidth;
            u.uPillarHeight.value = p.pillarHeight;
            u.uNoiseIntensity.value = p.noiseIntensity;
            u.uLightMode.value = p.lightMode ? 1 : 0;
            u.uPillarRotCos.value = Math.cos(p.pillarRotRad);
            u.uPillarRotSin.value = Math.sin(p.pillarRotRad);
            u.uWaveSin.value = p.waveSin;
            u.uWaveCos.value = p.waveCos;

            renderer.render(scene, camera);

            // Present frame to native Android SurfaceView
            gl.endFrameEXP();
          } catch (animErr) {
            console.error('[LightPillar] Error in animation frame:', animErr);
          }
        };

        animate();
      } catch (err) {
        console.error('[LightPillar] GL setup error:', err);
      }
    },
    [settings, width, height],
  );

  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { width, height, overflow: 'hidden' },
        style,
      ]}
    >
      <GLView
        style={StyleSheet.absoluteFill}
        onContextCreate={onContextCreate}
      />
    </View>
  );
}

export default LightPillar;
