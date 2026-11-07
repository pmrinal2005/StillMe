// @ts-nocheck
"use client";

import { useMemo, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useMotionValue, useTransform, animate, useMotionTemplate } from 'motion/react';
import './OrbitImages.css';

function generateEllipsePath(cx, cy, rx, ry) {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`;
}

function generateCirclePath(cx, cy, r) {
  return generateEllipsePath(cx, cy, r, r);
}

function generateSquarePath(cx, cy, size) {
  const h = size / 2;
  return `M ${cx - h} ${cy - h} L ${cx + h} ${cy - h} L ${cx + h} ${cy + h} L ${cx - h} ${cy + h} Z`;
}

function generateRectanglePath(cx, cy, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  return `M ${cx - hw} ${cy - hh} L ${cx + hw} ${cy - hh} L ${cx + hw} ${cy + hh} L ${cx - hw} ${cy + hh} Z`;
}

function generateTrianglePath(cx, cy, size) {
  const height = (size * Math.sqrt(3)) / 2;
  const hs = size / 2;
  return `M ${cx} ${cy - height / 1.5} L ${cx + hs} ${cy + height / 3} L ${cx - hs} ${cy + height / 3} Z`;
}

function generateStarPath(cx, cy, outerR, innerR, points) {
  const step = Math.PI / points;
  let path = '';
  for (let i = 0; i < 2 * points; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = i * step - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  }
  return path + ' Z';
}

function generateHeartPath(cx, cy, size) {
  const s = size / 30;
  return `M ${cx} ${cy + 12 * s} C ${cx - 20 * s} ${cy - 5 * s}, ${cx - 12 * s} ${cy - 18 * s}, ${cx} ${cy - 8 * s} C ${cx + 12 * s} ${cy - 18 * s}, ${cx + 20 * s} ${cy - 5 * s}, ${cx} ${cy + 12 * s}`;
}

function generateInfinityPath(cx, cy, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  return `M ${cx} ${cy} C ${cx + hw * 0.5} ${cy - hh}, ${cx + hw} ${cy - hh}, ${cx + hw} ${cy} C ${cx + hw} ${cy + hh}, ${cx + hw * 0.5} ${cy + hh}, ${cx} ${cy} C ${cx - hw * 0.5} ${cy + hh}, ${cx - hw} ${cy + hh}, ${cx - hw} ${cy} C ${cx - hw} ${cy - hh}, ${cx - hw * 0.5} ${cy - hh}, ${cx} ${cy}`;
}

function generateWavePath(cx, cy, w, amplitude, waves) {
  const pts = [];
  const segs = waves * 20;
  const hw = w / 2;
  for (let i = 0; i <= segs; i++) {
    const x = cx - hw + (w * i) / segs;
    const y = cy + Math.sin((i / segs) * waves * 2 * Math.PI) * amplitude;
    pts.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
  }
  for (let i = segs; i >= 0; i--) {
    const x = cx - hw + (w * i) / segs;
    const y = cy - Math.sin((i / segs) * waves * 2 * Math.PI) * amplitude;
    pts.push(`L ${x} ${y}`);
  }
  return pts.join(' ') + ' Z';
}

function OrbitItem({ item, index, totalItems, pathValue, itemSizeValue, rotationValue, progress, fill, scaleStrength, focalPoint = 50 }) {
  const itemOffset = fill ? (index / totalItems) * 100 : 0;

  const offsetPercentage = useTransform(progress, (p) => {
    return (((p + itemOffset) % 100) + 100) % 100;
  });

  const offsetDistance = useTransform(offsetPercentage, (p) => `${p}%`);

  const itemScale = useTransform(() => {
    const rawPos = offsetPercentage.get();
    const strength = scaleStrength ? scaleStrength.get() : 0;

    let dist = Math.abs(rawPos - focalPoint);
    if (dist > 50) dist = 100 - dist;

    let targetScale = 1;
    if (dist < 20) {
      const ratio = dist / 20;
      const cosCurve = (Math.cos(ratio * Math.PI) + 1) / 2;
      targetScale = 0.4 + (cosCurve * 0.6);
    } else {
      targetScale = 0.4;
    }

    return 1 - strength * (1 - targetScale);
  });

  const offsetPath = useMotionTemplate`path("${pathValue}")`;
  const itemZIndex = useTransform(itemScale, (s) => Math.round(s * 100));
  const counterRotate = useTransform(rotationValue, (r) => `rotate(${-r}deg)`);

  return (
    <motion.div
      className="orbit-item"
      style={{
        width: itemSizeValue,
        height: itemSizeValue,
        offsetPath,
        offsetRotate: '0deg',
        offsetAnchor: 'center center',
        offsetDistance,
        scale: itemScale,
        zIndex: itemZIndex,
        pointerEvents: 'auto'
      }}
    >
      <motion.div style={{ transform: counterRotate, width: '100%', height: '100%' }}>{item}</motion.div>
    </motion.div>
  );
}

export default function OrbitImages({
  images = [],
  altPrefix = 'Orbiting image',
  shape = 'ellipse',
  customPath,
  baseWidth = 1400,
  radiusX = 700,
  radiusY = 170,
  radius = 300,
  starPoints = 5,
  starInnerRatio = 0.5,
  rotation = -8,
  duration = 40,
  itemSize = 64,
  direction = 'normal',
  fill = true,
  width = 100,
  height = 100,
  className = '',
  showPath = false,
  pathColor = 'rgba(0,0,0,0.1)',
  pathWidth = 2,
  easing = 'linear',
  paused = false,
  centerContent,
  responsive = false,
  progressOverride,
  radiusXOverride,
  radiusYOverride,
  itemSizeOverride,
  rotationOverride,
  translateXOverride,
  focusStrength,
}: any) {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);

  const designCenterX = baseWidth / 2;
  const designCenterY = baseWidth / 2;

  const fallbackRadiusX = useMotionValue(radiusX);
  const fallbackRadiusY = useMotionValue(radiusY);
  const fallbackItemSize = useMotionValue(itemSize);
  const fallbackRotation = useMotionValue(rotation);
  const fallbackTranslateX = useMotionValue(0);

  const currentRadiusX = radiusXOverride || fallbackRadiusX;
  const currentRadiusY = radiusYOverride || fallbackRadiusY;
  const currentItemSize = itemSizeOverride || fallbackItemSize;
  const currentRotation = rotationOverride || fallbackRotation;
  const currentTranslateX = translateXOverride || fallbackTranslateX;

  const pathValue = useTransform([currentRadiusX, currentRadiusY], ([rx, ry]) => {
    switch (shape) {
      case 'circle': return generateCirclePath(designCenterX, designCenterY, rx);
      case 'ellipse': return generateEllipsePath(designCenterX, designCenterY, rx, ry);
      case 'square': return generateSquarePath(designCenterX, designCenterY, rx * 2);
      case 'rectangle': return generateRectanglePath(designCenterX, designCenterY, rx * 2, ry * 2);
      case 'triangle': return generateTrianglePath(designCenterX, designCenterY, rx * 2);
      case 'star': return generateStarPath(designCenterX, designCenterY, rx, rx * starInnerRatio, starPoints);
      case 'heart': return generateHeartPath(designCenterX, designCenterY, rx * 2);
      case 'infinity': return generateInfinityPath(designCenterX, designCenterY, rx * 2, ry * 2);
      case 'wave': return generateWavePath(designCenterX, designCenterY, rx * 2, ry, 3);
      case 'custom': return customPath || generateCirclePath(designCenterX, designCenterY, rx);
      default: return generateEllipsePath(designCenterX, designCenterY, rx, ry);
    }
  });

  useEffect(() => {
    if (!responsive || !containerRef.current) return;
    const updateScale = () => {
      if (!containerRef.current) return;
      setScale(containerRef.current.clientWidth / baseWidth);
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [responsive, baseWidth]);

  const internalProgress = useMotionValue(0);

  useEffect(() => {
    if (paused || progressOverride) return;
    const controls = animate(internalProgress, direction === 'reverse' ? -100 : 100, {
      duration,
      ease: easing,
      repeat: Infinity,
      repeatType: 'loop',
    });
    return () => controls.stop();
  }, [internalProgress, duration, easing, direction, paused, progressOverride]);

  const activeProgress = progressOverride || internalProgress;
  const containerWidth = responsive ? '100%' : (typeof width === 'number' ? width : '100%');
  const containerHeight = responsive ? 'auto' : (typeof height === 'number' ? height : (typeof width === 'number' ? width : 'auto'));

  const items = useMemo(() => images.map((src, index) => (
    <motion.img
      key={src}
      src={src}
      alt={`${altPrefix} ${index + 1}`}
      draggable={false}
      loading="lazy"
      decoding="async"
      className="orbit-image"
      whileHover={{ scale: 1.2 }}
      transition={{ duration: 0.3 }}
      style={{ cursor: "pointer", pointerEvents: "auto" }}
    />
  )), [images, altPrefix]);

  return (
    <div ref={containerRef} className={`orbit-container ${className}`} style={{ width: containerWidth, height: containerHeight, aspectRatio: responsive ? '1 / 1' : undefined }} aria-hidden="true">
      <div className={responsive ? 'orbit-scaling-container orbit-scaling-container--responsive' : 'orbit-scaling-container'} style={{ width: responsive ? baseWidth : '100%', height: responsive ? baseWidth : '100%', transform: responsive ? `translate(-50%, -50%) scale(${scale})` : undefined }}>
        <motion.div className="orbit-rotation-wrapper" style={{ rotate: currentRotation, x: currentTranslateX }}>
          {showPath && (
             <svg width="100%" height="100%" viewBox={`0 0 ${baseWidth} ${baseWidth}`} className="orbit-path-svg">
              <path d={pathValue.get()} fill="none" stroke={pathColor} strokeWidth={pathWidth / scale} />
            </svg>
          )}
          {items.map((item, index) => (
            <OrbitItem key={index} item={item} index={index} totalItems={items.length} pathValue={pathValue} itemSizeValue={currentItemSize} rotationValue={currentRotation} progress={activeProgress} fill={fill} scaleStrength={focusStrength} focalPoint={50} />
          ))}
        </motion.div>
      </div>
      {centerContent && <div className="orbit-center-content">{centerContent}</div>}
    </div>
  );
}
