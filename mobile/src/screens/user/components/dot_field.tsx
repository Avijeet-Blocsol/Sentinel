/**
 * Strands Sentinel - DotField WebGL Component
 * Renders a subtle, undulating cybernetic dot matrix backdrop for the Navigation Pane.
 * Styled with Sentinel's Neon Green palette (#0DF272 to #063D1F) with subtle wave motion
 * and soft touch interaction. Powered by Expo-GL and Three.js Points.
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

export interface DotFieldProps {
  dotSize?: number;
  dotSpacing?: number;
  opacity?: number;
  waveAmplitude?: number;
  colorFrom?: string;
  colorTo?: string;
  style?: StyleProp<ViewStyle>;
}

function hexToRgbVector(hex: string, target: THREE.Vector3): THREE.Vector3 {
  const c = new THREE.Color(hex);
  target.set(c.r, c.g, c.b);
  return target;
}

const VERTEX_SHADER = `
uniform float uTime;
uniform vec2 uTouch;
uniform float uTouchRadius;
uniform float uTouchStrength;
uniform float uWaveAmplitude;
uniform float uDotSize;

attribute vec2 aOrigin;
varying vec2 vUv;

void main() {
  vec3 pos = vec3(aOrigin, 0.0);

  // Subtle ambient floating wave
  if (uWaveAmplitude > 0.0) {
    float t = uTime * 0.9;
    pos.y += sin(aOrigin.x * 5.0 + t) * uWaveAmplitude;
    pos.x += cos(aOrigin.y * 5.0 + t * 0.7) * uWaveAmplitude * 0.5;
  }

  // Gentle touch repulsion
  vec2 diff = pos.xy - uTouch;
  float dist = length(diff);
  if (dist < uTouchRadius && dist > 0.001) {
    float factor = 1.0 - (dist / uTouchRadius);
    pos.xy += normalize(diff) * factor * factor * uTouchStrength;
  }

  vUv = (pos.xy + 1.0) * 0.5;
  gl_PointSize = uDotSize;
  gl_Position = vec4(pos.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec3 uColorFrom;
uniform vec3 uColorTo;
uniform float uOpacity;

varying vec2 vUv;

void main() {
  // Anti-aliased circular point shape
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  float circleAlpha = smoothstep(0.5, 0.25, dist);

  // Sentinel Neon Green gradient (top to bottom)
  vec3 col = mix(uColorTo, uColorFrom, vUv.y);

  gl_FragColor = vec4(col, circleAlpha * uOpacity);
}
`;

export function DotField({
  dotSize = 3.5,
  dotSpacing = 22,
  opacity = 0.22,
  waveAmplitude = 0.018,
  colorFrom = '#0DF272',
  colorTo = '#063D1F',
  style,
}: DotFieldProps) {
  const { width, height } = useWindowDimensions();
  const rafIdRef = useRef<number>(0);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);

  const colorFromVecRef = useRef(new THREE.Vector3());
  const colorToVecRef = useRef(new THREE.Vector3());
  const touchPosRef = useRef(new THREE.Vector2(-9999, -9999));
  const touchTargetRef = useRef(new THREE.Vector2(-9999, -9999));

  const dpr = PixelRatio.get?.() || 2;
  const scaledDotSize = dotSize * dpr;

  useEffect(() => {
    hexToRgbVector(colorFrom, colorFromVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uColorFrom.value.copy(colorFromVecRef.current);
    }
  }, [colorFrom]);

  useEffect(() => {
    hexToRgbVector(colorTo, colorToVecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.uColorTo.value.copy(colorToVecRef.current);
    }
  }, [colorTo]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uOpacity.value = opacity;
    }
  }, [opacity]);

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

        hexToRgbVector(colorFrom, colorFromVecRef.current);
        hexToRgbVector(colorTo, colorToVecRef.current);

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

        // Build grid of dots in NDC [-1, 1]
        const stepPx = dotSpacing * dpr;
        const cols = Math.max(10, Math.floor(glWidth / stepPx));
        const rows = Math.max(15, Math.floor(glHeight / stepPx));
        const totalDots = cols * rows;

        const positions = new Float32Array(totalDots * 3);
        const origins = new Float32Array(totalDots * 2);

        let pIdx = 0;
        let oIdx = 0;

        for (let r = 0; r < rows; r++) {
          const ny = 1.0 - ((r + 0.5) / rows) * 2.0;
          for (let c = 0; c < cols; c++) {
            const nx = ((c + 0.5) / cols) * 2.0 - 1.0;

            positions[pIdx] = nx;
            positions[pIdx + 1] = ny;
            positions[pIdx + 2] = 0.0;
            pIdx += 3;

            origins[oIdx] = nx;
            origins[oIdx + 1] = ny;
            oIdx += 2;
          }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 2));
        geometryRef.current = geometry;

        const uniforms = {
          uTime: { value: 0 },
          uTouch: { value: touchPosRef.current },
          uTouchRadius: { value: 0.35 },
          uTouchStrength: { value: 0.045 },
          uWaveAmplitude: { value: waveAmplitude },
          uDotSize: { value: scaledDotSize },
          uColorFrom: { value: colorFromVecRef.current.clone() },
          uColorTo: { value: colorToVecRef.current.clone() },
          uOpacity: { value: opacity },
        };

        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          uniforms,
        });
        materialRef.current = material;

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        const startTime = performance.now();

        const animate = () => {
          try {
            rafIdRef.current = requestAnimationFrame(animate);

            const now = performance.now();
            const elapsed = (now - startTime) * 0.001;

            material.uniforms.uTime.value = elapsed;

            // Smooth touch decay towards target
            touchPosRef.current.lerp(touchTargetRef.current, 0.1);
            material.uniforms.uTouch.value.copy(touchPosRef.current);

            renderer.render(scene, camera);
            gl.endFrameEXP();
          } catch (animErr) {
            console.error('[DotField] Animation tick error:', animErr);
          }
        };

        animate();
      } catch (err) {
        console.error('[DotField] WebGL setup error:', err);
      }
    },
    [width, height, dpr, dotSpacing, scaledDotSize, waveAmplitude, opacity, colorFrom, colorTo],
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

export default React.memo(DotField);
