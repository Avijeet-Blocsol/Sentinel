/**
 * Strands Sentinel - GridScan WebGL Component
 * Renders a 3D perspective cyber-tunnel scanning grid constrained to a 20px
 * outer perimeter border strip around the dashboard.
 * Pulses every 10 seconds in Sentinel Neon Green (#0DF272).
 * Powered by Expo WebGL (expo-gl) and Three.js ShaderMaterial.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  StyleSheet,
  StyleProp,
  ViewStyle,
  PixelRatio,
  useWindowDimensions,
} from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export interface GridScanProps {
  borderWidth?: number;
  scanDuration?: number;
  scanDelay?: number;
  scanColor?: string;
  linesColor?: string;
  scanOpacity?: number;
  lineThickness?: number;
  gridScale?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  lineJitter?: number;
  scanGlow?: number;
  scanSoftness?: number;
  scanPhaseTaper?: number;
  bloomIntensity?: number;
  noiseIntensity?: number;
  style?: StyleProp<ViewStyle>;
}

function hexToRgbVector(hex: string, target: THREE.Vector3): THREE.Vector3 {
  const c = new THREE.Color(hex);
  target.set(c.r, c.g, c.b);
  return target;
}

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform vec3 iResolution;
uniform float iTime;
uniform vec2 uSkew;
uniform float uTilt;
uniform float uYaw;
uniform float uLineThickness;
uniform vec3 uLinesColor;
uniform vec3 uScanColor;
uniform float uGridScale;
uniform float uLineStyle;
uniform float uLineJitter;
uniform float uScanOpacity;
uniform float uScanDirection;
uniform float uNoise;
uniform float uBloomOpacity;
uniform float uScanGlow;
uniform float uScanSoftness;
uniform float uPhaseTaper;
uniform float uScanDuration;
uniform float uScanDelay;
uniform float uBorderWidth;

varying vec2 vUv;

float smoother01(float a, float b, float x) {
  float t = clamp((x - a) / max(1e-5, (b - a)), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // If uBorderWidth > 0, constrain to perimeter strip. If <= 0, render full-screen across dashboard.
  float borderFeather = 1.0;
  if (uBorderWidth > 0.0) {
    float distLeft = fragCoord.x;
    float distRight = iResolution.x - fragCoord.x;
    float distBottom = fragCoord.y;
    float distTop = iResolution.y - fragCoord.y;
    float distToEdge = min(min(distLeft, distRight), min(distBottom, distTop));

    if (distToEdge > uBorderWidth) {
      fragColor = vec4(0.0);
      return;
    }
    // Feather smoothly inward across the inner edge
    borderFeather = smoothstep(uBorderWidth, max(0.0, uBorderWidth - 5.0), distToEdge);
  }

  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

  vec3 ro = vec3(0.0);
  vec3 rd = normalize(vec3(p, 2.0));

  float cR = cos(uTilt), sR = sin(uTilt);
  rd.xy = mat2(cR, -sR, sR, cR) * rd.xy;

  float cY = cos(uYaw), sY = sin(uYaw);
  rd.xz = mat2(cY, -sY, sY, cY) * rd.xz;

  vec2 skew = clamp(uSkew, vec2(-0.7), vec2(0.7));
  rd.xy += skew * rd.z;

  vec3 color = vec3(0.0);
  float minT = 1e20;
  float gridScale = max(1e-5, uGridScale);
  float fadeStrength = 2.0;
  vec2 gridUV = vec2(0.0);

  float hitIsY = 1.0;
  for (int i = 0; i < 4; i++) {
    float isY = float(i < 2);
    float pos = mix(-0.2, 0.2, float(i)) * isY + mix(-0.5, 0.5, float(i - 2)) * (1.0 - isY);
    float num = pos - (isY * ro.y + (1.0 - isY) * ro.x);
    float den = isY * rd.y + (1.0 - isY) * rd.x;
    float t = num / den;
    vec3 h = ro + rd * t;

    float depthBoost = smoothstep(0.0, 3.0, h.z);
    h.xy += skew * 0.15 * depthBoost;

    bool use = t > 0.0 && t < minT;
    gridUV = use ? mix(h.zy, h.xz, isY) / gridScale : gridUV;
    minT = use ? t : minT;
    hitIsY = use ? isY : hitIsY;
  }

  vec3 hit = ro + rd * minT;
  float dist = length(hit - ro);

  float jitterAmt = clamp(uLineJitter, 0.0, 1.0);
  if (jitterAmt > 0.0) {
    vec2 j = vec2(
      sin(gridUV.y * 2.7 + iTime * 1.8),
      cos(gridUV.x * 2.3 - iTime * 1.6)
    ) * (0.15 * jitterAmt);
    gridUV += j;
  }
  float fx = fract(gridUV.x);
  float fy = fract(gridUV.y);
  float ax = min(fx, 1.0 - fx);
  float ay = min(fy, 1.0 - fy);
  float wx = fwidth(gridUV.x);
  float wy = fwidth(gridUV.y);
  float halfPx = max(0.0, uLineThickness) * 0.5;

  float tx = halfPx * wx;
  float ty = halfPx * wy;

  float aax = wx;
  float aay = wy;

  float lineX = 1.0 - smoothstep(tx, tx + aax, ax);
  float lineY = 1.0 - smoothstep(ty, ty + aay, ay);
  if (uLineStyle > 0.5) {
    float dashRepeat = 4.0;
    float dashDuty = 0.5;
    float vy = fract(gridUV.y * dashRepeat);
    float vx = fract(gridUV.x * dashRepeat);
    float dashMaskY = step(vy, dashDuty);
    float dashMaskX = step(vx, dashDuty);
    if (uLineStyle < 1.5) {
      lineX *= dashMaskY;
      lineY *= dashMaskX;
    } else {
      float dotRepeat = 6.0;
      float dotWidth = 0.18;
      float cy = abs(fract(gridUV.y * dotRepeat) - 0.5);
      float cx = abs(fract(gridUV.x * dotRepeat) - 0.5);
      float dotMaskY = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.y * dotRepeat), cy);
      float dotMaskX = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.x * dotRepeat), cx);
      lineX *= dotMaskY;
      lineY *= dotMaskX;
    }
  }
  float primaryMask = max(lineX, lineY);

  vec2 gridUV2 = (hitIsY > 0.5 ? hit.xz : hit.zy) / gridScale;
  if (jitterAmt > 0.0) {
    vec2 j2 = vec2(
      cos(gridUV2.y * 2.1 - iTime * 1.4),
      sin(gridUV2.x * 2.5 + iTime * 1.7)
    ) * (0.15 * jitterAmt);
    gridUV2 += j2;
  }
  float fx2 = fract(gridUV2.x);
  float fy2 = fract(gridUV2.y);
  float ax2 = min(fx2, 1.0 - fx2);
  float ay2 = min(fy2, 1.0 - fy2);
  float wx2 = fwidth(gridUV2.x);
  float wy2 = fwidth(gridUV2.y);
  float tx2 = halfPx * wx2;
  float ty2 = halfPx * wy2;
  float aax2 = wx2;
  float aay2 = wy2;
  float lineX2 = 1.0 - smoothstep(tx2, tx2 + aax2, ax2);
  float lineY2 = 1.0 - smoothstep(ty2, ty2 + aay2, ay2);
  if (uLineStyle > 0.5) {
    float dashRepeat2 = 4.0;
    float dashDuty2 = 0.5;
    float vy2m = fract(gridUV2.y * dashRepeat2);
    float vx2m = fract(gridUV2.x * dashRepeat2);
    float dashMaskY2 = step(vy2m, dashDuty2);
    float dashMaskX2 = step(vx2m, dashDuty2);
    if (uLineStyle < 1.5) {
      lineX2 *= dashMaskY2;
      lineY2 *= dashMaskX2;
    } else {
      float dotRepeat2 = 6.0;
      float dotWidth2 = 0.18;
      float cy2 = abs(fract(gridUV2.y * dotRepeat2) - 0.5);
      float cx2 = abs(fract(gridUV2.x * dotRepeat2) - 0.5);
      float dotMaskY2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.y * dotRepeat2), cy2);
      float dotMaskX2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.x * dotRepeat2), cx2);
      lineX2 *= dotMaskY2;
      lineY2 *= dotMaskX2;
    }
  }
  float altMask = max(lineX2, lineY2);

  float edgeDistX = min(abs(hit.x - (-0.5)), abs(hit.x - 0.5));
  float edgeDistY = min(abs(hit.y - (-0.2)), abs(hit.y - 0.2));
  float edgeDist = mix(edgeDistY, edgeDistX, hitIsY);
  float edgeGate = 1.0 - smoothstep(gridScale * 0.5, gridScale * 2.0, edgeDist);
  altMask *= edgeGate;

  float lineMask = max(primaryMask, altMask);

  float fade = exp(-dist * fadeStrength);

  float dur = max(0.05, uScanDuration);
  float del = max(0.0, uScanDelay);
  float scanZMax = 2.0;
  float widthScale = max(0.1, uScanGlow);
  float sigma = max(0.001, 0.18 * widthScale * uScanSoftness);
  float sigmaA = sigma * 2.0;

  float combinedPulse = 0.0;
  float combinedAura = 0.0;

  float cycle = dur + del;
  float tCycle = mod(iTime, cycle);
  float scanPhase = clamp((tCycle - del) / dur, 0.0, 1.0);
  float phase = scanPhase;
  if (uScanDirection > 0.5 && uScanDirection < 1.5) {
    phase = 1.0 - phase;
  } else if (uScanDirection > 1.5) {
    float t2 = mod(max(0.0, iTime - del), 2.0 * dur);
    phase = (t2 < dur) ? (t2 / dur) : (1.0 - (t2 - dur) / dur);
  }
  float scanZ = phase * scanZMax;
  float dz = abs(hit.z - scanZ);
  float lineBand = exp(-0.5 * (dz * dz) / (sigma * sigma));
  float taper = clamp(uPhaseTaper, 0.0, 0.49);
  float headW = taper;
  float tailW = taper;
  float headFade = smoother01(0.0, headW, phase);
  float tailFade = 1.0 - smoother01(1.0 - tailW, 1.0, phase);
  float phaseWindow = headFade * tailFade;
  float pulseBase = lineBand * phaseWindow;
  combinedPulse += pulseBase * clamp(uScanOpacity, 0.0, 1.0);
  float auraBand = exp(-0.5 * (dz * dz) / (sigmaA * sigmaA));
  combinedAura += (auraBand * 0.25) * phaseWindow * clamp(uScanOpacity, 0.0, 1.0);

  float lineVis = lineMask;
  vec3 gridCol = uLinesColor * lineVis * fade * (0.25 + 0.75 * phaseWindow);
  vec3 scanCol = uScanColor * combinedPulse;
  vec3 scanAura = uScanColor * combinedAura;

  color = gridCol + scanCol + scanAura;

  float n = fract(sin(dot(fragCoord.xy + vec2(iTime * 123.4), vec2(12.9898, 78.233))) * 43758.5453123);
  color += (n - 0.5) * uNoise;
  color = clamp(color, 0.0, 1.0);

  float alpha = clamp(max(lineVis * (0.2 + 0.8 * phaseWindow), combinedPulse), 0.0, 1.0);
  float gx = 1.0 - smoothstep(tx * 2.0, tx * 2.0 + aax * 2.0, ax);
  float gy = 1.0 - smoothstep(ty * 2.0, ty * 2.0 + aay * 2.0, ay);
  float halo = max(gx, gy) * fade;
  alpha = max(alpha, halo * clamp(uBloomOpacity, 0.0, 1.0));

  alpha *= borderFeather;
  color *= borderFeather;

  fragColor = vec4(color, alpha);
}

void main() {
  vec4 c;
  mainImage(c, vUv * iResolution.xy);
  gl_FragColor = c;
}
`;

export function GridScan({
  borderWidth = 0,
  scanDuration = 2.0,
  scanDelay = 8.0,
  scanColor = '#0DF272',
  linesColor = '#062814',
  scanOpacity = 0.75,
  lineThickness = 1.2,
  gridScale = 0.1,
  lineStyle = 'solid',
  lineJitter = 0.05,
  scanGlow = 0.6,
  scanSoftness = 2.0,
  scanPhaseTaper = 0.35,
  bloomIntensity = 0.4,
  noiseIntensity = 0.01,
  style,
}: GridScanProps) {
  const { width, height } = useWindowDimensions();
  const rafIdRef = useRef<number>(0);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const geometryRef = useRef<THREE.PlaneGeometry | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);

  const scanColorVecRef = useRef(new THREE.Vector3());
  const linesColorVecRef = useRef(new THREE.Vector3());

  const dpr = PixelRatio.get?.() || 2;
  const scaledBorderWidth = borderWidth * dpr;

  useEffect(() => {
    hexToRgbVector(scanColor, scanColorVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uScanColor.value.copy(scanColorVecRef.current);
    }
  }, [scanColor]);

  useEffect(() => {
    hexToRgbVector(linesColor, linesColorVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uLinesColor.value.copy(linesColorVecRef.current);
    }
  }, [linesColor]);

  // Clean up WebGL resources on unmount
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
        const fallbackWidth = Math.round(width * dpr);
        const fallbackHeight = Math.round(height * dpr);
        const glWidth = gl.drawingBufferWidth > 0 ? gl.drawingBufferWidth : fallbackWidth;
        const glHeight = gl.drawingBufferHeight > 0 ? gl.drawingBufferHeight : fallbackHeight;

        hexToRgbVector(scanColor, scanColorVecRef.current);
        hexToRgbVector(linesColor, linesColorVecRef.current);

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

        const uniforms = {
          iResolution: { value: new THREE.Vector3(glWidth, glHeight, dpr) },
          iTime: { value: 0 },
          uSkew: { value: new THREE.Vector2(0, 0) },
          uTilt: { value: 0 },
          uYaw: { value: 0 },
          uLineThickness: { value: lineThickness },
          uLinesColor: { value: linesColorVecRef.current.clone() },
          uScanColor: { value: scanColorVecRef.current.clone() },
          uGridScale: { value: gridScale },
          uLineStyle: { value: lineStyle === 'dashed' ? 1 : lineStyle === 'dotted' ? 2 : 0 },
          uLineJitter: { value: lineJitter },
          uScanOpacity: { value: scanOpacity },
          uScanDirection: { value: 0 },
          uNoise: { value: noiseIntensity },
          uBloomOpacity: { value: bloomIntensity },
          uScanGlow: { value: scanGlow },
          uScanSoftness: { value: scanSoftness },
          uPhaseTaper: { value: scanPhaseTaper },
          uScanDuration: { value: scanDuration },
          uScanDelay: { value: scanDelay },
          uBorderWidth: { value: scaledBorderWidth },
        };

        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          uniforms,
        });
        materialRef.current = material;

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        const startTime = performance.now();

        const animate = () => {
          try {
            rafIdRef.current = requestAnimationFrame(animate);

            const now = performance.now();
            const elapsed = (now - startTime) * 0.001;

            material.uniforms.iTime.value = elapsed;

            renderer.render(scene, camera);
            gl.endFrameEXP();
          } catch (animErr) {
            console.error('[GridScan] Animation tick error:', animErr);
          }
        };

        animate();
      } catch (err) {
        console.error('[GridScan] WebGL setup error:', err);
      }
    },
    [
      width,
      height,
      dpr,
      scaledBorderWidth,
      scanDuration,
      scanDelay,
      scanColor,
      linesColor,
      scanOpacity,
      lineThickness,
      gridScale,
      lineStyle,
      lineJitter,
      scanGlow,
      scanSoftness,
      scanPhaseTaper,
      bloomIntensity,
      noiseIntensity,
    ],
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
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </View>
  );
}

export default React.memo(GridScan);
