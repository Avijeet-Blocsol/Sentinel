/**
 * Strands Sentinel - SideRays Ambient Light Rays Component
 * Renders dynamic volumetric light rays emanating from a screen corner (default: top-right)
 * using Expo WebGL (expo-gl) and Three.js ShaderMaterial.
 * Fades in when agent is thinking, fades out and pauses GPU loop on response/interrupt.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  StyleProp,
  ViewStyle,
  Animated,
  PixelRatio,
  useWindowDimensions,
} from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

export interface SideRaysProps {
  active?: boolean;
  speed?: number;
  rayColor1?: string;
  rayColor2?: string;
  intensity?: number;
  spread?: number;
  origin?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  tilt?: number;
  saturation?: number;
  blend?: number;
  falloff?: number;
  opacity?: number;
  style?: StyleProp<ViewStyle>;
}

function hexToRgbVector(hex: string, target: THREE.Vector3): THREE.Vector3 {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (m) {
    target.set(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  } else {
    target.set(1, 1, 1);
  }
  return target;
}

function originToFlip(origin: string): [number, number] {
  switch (origin) {
    case 'top-left':
      return [1, 0];
    case 'bottom-right':
      return [0, 1];
    case 'bottom-left':
      return [1, 1];
    default:
      return [0, 0]; // 'top-right'
  }
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

export function SideRays({
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
}: SideRaysProps) {
  const { width: windowWidth } = useWindowDimensions();
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

  const color1VecRef = useRef(new THREE.Vector3());
  const color2VecRef = useRef(new THREE.Vector3());

  // Keep colors updated
  useEffect(() => {
    hexToRgbVector(rayColor1, color1VecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.iRayColor1.value.copy(color1VecRef.current);
    }
  }, [rayColor1]);

  useEffect(() => {
    hexToRgbVector(rayColor2, color2VecRef.current);
    if (materialRef.current) {
      materialRef.current.uniforms.iRayColor2.value.copy(color2VecRef.current);
    }
  }, [rayColor2]);

  // Smooth fade-in / fade-out transition
  useEffect(() => {
    if (active) {
      setShouldRender(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }).start();
      // Resume loop if context exists and loop paused
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

  // Props ref for zero-allocation access inside render loop
  const [flipX, flipY] = originToFlip(origin);
  const propsRef = useRef({
    speed,
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

        const p = propsRef.current;
        const u = material.uniforms;

        u.iTime.value = elapsed;
        u.iSpeed.value = p.speed;
        u.iIntensity.value = p.intensity;
        u.iSpread.value = p.spread;
        u.iFlipX.value = p.flipX;
        u.iFlipY.value = p.flipY;
        u.iTilt.value = p.tilt;
        u.iSaturation.value = p.saturation;
        u.iBlend.value = p.blend;
        u.iFalloff.value = p.falloff;
        u.iOpacity.value = p.opacity;

        renderer.render(scene, camera);
        gl.endFrameEXP();
      } catch (err) {
        console.error('[SideRays] Render loop error:', err);
      }
    };

    animate();
  }, []);

  // GL Context Initialization
  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        glRef.current = gl;

        const fallbackWidth = Math.round(280 * (PixelRatio.get?.() || 2));
        const fallbackHeight = Math.round(280 * (PixelRatio.get?.() || 2));
        const glWidth = gl.drawingBufferWidth && gl.drawingBufferWidth > 0 ? gl.drawingBufferWidth : fallbackWidth;
        const glHeight = gl.drawingBufferHeight && gl.drawingBufferHeight > 0 ? gl.drawingBufferHeight : fallbackHeight;

        hexToRgbVector(rayColor1, color1VecRef.current);
        hexToRgbVector(rayColor2, color2VecRef.current);

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

        const p = propsRef.current;
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
            iSpeed: { value: p.speed },
            iRayColor1: { value: color1VecRef.current.clone() },
            iRayColor2: { value: color2VecRef.current.clone() },
            iIntensity: { value: p.intensity },
            iSpread: { value: p.spread },
            iFlipX: { value: p.flipX },
            iFlipY: { value: p.flipY },
            iTilt: { value: p.tilt },
            iSaturation: { value: p.saturation },
            iBlend: { value: p.blend },
            iFalloff: { value: p.falloff },
            iOpacity: { value: p.opacity },
          },
        });
        materialRef.current = material;

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        startAnimationLoop();
      } catch (err) {
        console.error('[SideRays] GL initialization error:', err);
      }
    },
    [rayColor1, rayColor2, startAnimationLoop],
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

  if (!shouldRender && !active) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        { opacity: fadeAnim },
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

export default SideRays;
