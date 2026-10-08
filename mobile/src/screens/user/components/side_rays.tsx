/**
 * Strands Sentinel - SideRays Component
 * Ported from the React Bits WebGL/OGL implementation to React Native (expo-gl & Three.js).
 * Uses the exact shader, ray strength calculation, dynamic color blending, and parameters.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  StyleSheet,
  StyleProp,
  ViewStyle,
  Animated,
  PixelRatio,
} from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export type Origin = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export interface SideRaysProps {
  active?: boolean;
  speed?: number;
  rayColor1?: string;
  rayColor2?: string;
  intensity?: number;
  spread?: number;
  origin?: Origin;
  tilt?: number;
  saturation?: number;
  blend?: number;
  falloff?: number;
  opacity?: number;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
    : [1, 1, 1];
};

const originToFlip = (origin: Origin): [number, number] => {
  switch (origin) {
    case 'top-left':
      return [1, 0];
    case 'bottom-right':
      return [0, 1];
    case 'bottom-left':
      return [1, 1];
    default:
      return [0, 0];
  }
};

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform float iSpeed;
uniform vec3 iRayColor1;
uniform vec3 iRayColor2;
uniform float iIntensity;
uniform float iSpread;
uniform float iFlipX;
uniform float iFlipY;
uniform float iTilt;
uniform float iSaturation;
uniform float iBlend;
uniform float iFalloff;
uniform float iOpacity;

float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
  vec2 sourceToCoord = coord - raySource;
  float cosAngle = dot(normalize(sourceToCoord), rayRefDirection);
  return clamp(
    (0.45 + 0.15 * sin(cosAngle * seedA + iTime * speed)) +
    (0.3 + 0.2 * cos(-cosAngle * seedB + iTime * speed)),
    0.0, 1.0) *
    clamp((iResolution.x - length(sourceToCoord)) / iResolution.x, 0.5, 1.0);
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  if (iFlipX > 0.5) fragCoord.x = iResolution.x - fragCoord.x;
  if (iFlipY > 0.5) fragCoord.y = iResolution.y - fragCoord.y;

  vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
  vec2 rayPos = vec2(iResolution.x * 1.1, -0.5 * iResolution.y);

  float tiltRad = iTilt * 3.14159265 / 180.0;
  float cs = cos(tiltRad);
  float sn = sin(tiltRad);
  vec2 rel = coord - rayPos;
  vec2 tiltedCoord = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs) + rayPos;

  float halfSpread = iSpread * 0.275;
  vec2 rayRefDir1 = normalize(vec2(cos(0.785398 + halfSpread), sin(0.785398 + halfSpread)));
  vec2 rayRefDir2 = normalize(vec2(cos(0.785398 - halfSpread), sin(0.785398 - halfSpread)));

  vec4 rays1 = vec4(iRayColor1, 1.0) * rayStrength(rayPos, rayRefDir1, tiltedCoord, 36.2214, 21.11349, iSpeed);
  vec4 rays2 = vec4(iRayColor2, 1.0) * rayStrength(rayPos, rayRefDir2, tiltedCoord, 22.3991, 18.0234, iSpeed * 0.2);

  vec4 color = rays1 * (1.0 - iBlend) * 0.9 + rays2 * iBlend * 0.9;

  float distanceToLight = length(fragCoord.xy - vec2(rayPos.x, iResolution.y - rayPos.y)) / iResolution.y;
  float brightness = iIntensity * 0.4 / pow(max(distanceToLight, 0.001), iFalloff);
  color.rgb *= brightness;

  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  color.rgb = mix(vec3(gray), color.rgb, iSaturation);

  color.a = max(color.r, max(color.g, color.b)) * iOpacity;
  gl_FragColor = color;
}
`;

export const SideRays = ({
  active = true,
  speed = 2.5,
  rayColor1 = '#EAB308',
  rayColor2 = '#96c8ff',
  intensity = 2,
  spread = 2,
  origin = 'top-right',
  tilt = 0,
  saturation = 1.5,
  blend = 0.75,
  falloff = 1.6,
  opacity = 1.0,
  style,
  className = '',
}: SideRaysProps) => {
  const fadeAnim = useRef(new Animated.Value(active ? 1 : 0)).current;

  const rafIdRef = useRef<number>(0);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const glRef = useRef<ExpoWebGLRenderingContext | null>(null);
  const isLoopRunningRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const color1Vec = useRef(new THREE.Vector3(...hexToRgb(rayColor1))).current;
  const color2Vec = useRef(new THREE.Vector3(...hexToRgb(rayColor2))).current;

  const [flipX, flipY] = originToFlip(origin);
  const propsRef = useRef({
    speed,
    rayColor1,
    rayColor2,
    intensity,
    spread,
    flipX,
    flipY,
    tilt,
    saturation,
    blend,
    falloff,
    opacity,
  });

  propsRef.current = {
    speed,
    rayColor1,
    rayColor2,
    intensity,
    spread,
    flipX,
    flipY,
    tilt,
    saturation,
    blend,
    falloff,
    opacity,
  };

  // Update uniforms when props change dynamically
  useEffect(() => {
    if (!materialRef.current) return;
    const u = materialRef.current.uniforms;
    u.iSpeed.value = speed;
    const rgb1 = hexToRgb(rayColor1);
    const rgb2 = hexToRgb(rayColor2);
    color1Vec.set(rgb1[0], rgb1[1], rgb1[2]);
    color2Vec.set(rgb2[0], rgb2[1], rgb2[2]);
    u.iRayColor1.value.copy(color1Vec);
    u.iRayColor2.value.copy(color2Vec);
    u.iIntensity.value = intensity;
    u.iSpread.value = spread;
    const [fx, fy] = originToFlip(origin);
    u.iFlipX.value = fx;
    u.iFlipY.value = fy;
    u.iTilt.value = tilt;
    u.iSaturation.value = saturation;
    u.iBlend.value = blend;
    u.iFalloff.value = falloff;
    u.iOpacity.value = opacity;
  }, [speed, rayColor1, rayColor2, intensity, spread, origin, tilt, saturation, blend, falloff, opacity, color1Vec, color2Vec]);

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

        material.uniforms.iTime.value = elapsed;

        renderer.render(scene, camera);
        gl.endFrameEXP();
      } catch (err) {
        console.error('[SideRays] Render loop error:', err);
      }
    };

    animate();
  }, []);

  // Smooth fade-in / fade-out transition with automatic loop start/stop
  useEffect(() => {
    if (active) {
      if (!isLoopRunningRef.current && glRef.current) {
        startAnimationLoop();
      }
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && !activeRef.current) {
          if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = 0;
          }
          isLoopRunningRef.current = false;
        }
      });
    }
  }, [active, fadeAnim, startAnimationLoop]);

  // GL Context Initialization
  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        glRef.current = gl;

        const fallbackWidth = Math.round(418 * (PixelRatio.get?.() || 2));
        const fallbackHeight = Math.round(520 * (PixelRatio.get?.() || 2));
        const glWidth = gl.drawingBufferWidth && gl.drawingBufferWidth > 0 ? gl.drawingBufferWidth : fallbackWidth;
        const glHeight = gl.drawingBufferHeight && gl.drawingBufferHeight > 0 ? gl.drawingBufferHeight : fallbackHeight;

        const rgb1 = hexToRgb(rayColor1);
        const rgb2 = hexToRgb(rayColor2);
        color1Vec.set(rgb1[0], rgb1[1], rgb1[2]);
        color2Vec.set(rgb2[0], rgb2[1], rgb2[2]);

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

        // Full-screen quad geometry
        const geometry = new THREE.PlaneGeometry(2, 2);
        geometryRef.current = geometry;

        const [fx, fy] = originToFlip(origin);
        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          uniforms: {
            iTime: { value: 0 },
            iResolution: { value: new THREE.Vector2(glWidth, glHeight) },
            iSpeed: { value: speed },
            iRayColor1: { value: color1Vec.clone() },
            iRayColor2: { value: color2Vec.clone() },
            iIntensity: { value: intensity },
            iSpread: { value: spread },
            iFlipX: { value: fx },
            iFlipY: { value: fy },
            iTilt: { value: tilt },
            iSaturation: { value: saturation },
            iBlend: { value: blend },
            iFalloff: { value: falloff },
            iOpacity: { value: opacity },
          },
        });
        materialRef.current = material;

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        // Render first frame immediately
        renderer.render(scene, camera);
        gl.endFrameEXP();

        if (activeRef.current) {
          startAnimationLoop();
        }
      } catch (err) {
        console.error('[SideRays] GL initialization error:', err);
      }
    },
    [rayColor1, rayColor2, speed, intensity, spread, origin, tilt, saturation, blend, falloff, opacity, color1Vec, color2Vec, startAnimationLoop],
  );

  // Cleanup on unmount
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

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        { opacity: fadeAnim },
        style,
      ]}
      className={className}
    >
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

export default SideRays;
