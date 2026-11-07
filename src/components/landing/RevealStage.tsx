'use client'

import { motion, useMotionTemplate, useScroll, useTransform, useAnimationFrame, useMotionValue } from 'motion/react'
import { useRef, type MouseEventHandler } from 'react'
import OrbitImages from './OrbitImages'

const ORBIT_IMAGES = ['/images/orbit-1.svg', '/images/orbit-2.svg', '/images/orbit-3.svg', '/images/orbit-4.svg', '/images/orbit-5.svg', '/images/orbit-6.svg']

/**
 * Orbit reveal. A scroll-driven iris opens a light plate, then six discs (Partner speaks, Live captions, Three drafts,
 * You approve, Your voice, Stop anytime) orbit and come into focus as you scroll. Original SVG art, no photos.
 * Both CTAs enter the dashboard through `onEnter` (fade veil, then router push).
 */
export default function RevealStage({ onEnter }: { onEnter: MouseEventHandler<HTMLAnchorElement> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end end'] })

  const rx = useTransform(scrollYProgress, [0, 0.08, 1], ['0%', '55%', '55%'])
  const ry = useTransform(scrollYProgress, [0, 0.08, 1], ['0%', '55%', '55%'])
  const clipPath = useMotionTemplate`ellipse(${rx} ${ry} at 50% 50%)`

  const keys = [0.03, 0.08, 0.15, 0.22, 0.9, 0.98, 1]
  const textOpacity = useTransform(scrollYProgress, keys, [0, 1, 1, 0, 0, 1, 1])
  const textBlur = useTransform(scrollYProgress, keys, [15, 0, 0, 15, 15, 0, 0])
  const filterText = useMotionTemplate`blur(${textBlur}px)`
  const yElement = useTransform(scrollYProgress, keys, [20, 0, 0, 20, 20, 0, 0])

  const targetRadius = 650
  const okeys = [0.15, 0.25, 0.85, 0.95, 1]
  const orbitItemSize = useTransform(scrollYProgress, okeys, [80, 360, 360, 80, 80])
  const orbitRx = useTransform(scrollYProgress, okeys, [470, targetRadius, targetRadius, 470, 470])
  const orbitRy = useTransform(scrollYProgress, okeys, [210, targetRadius, targetRadius, 210, 210])
  const orbitRotation = useTransform(scrollYProgress, okeys, [-15, 0, 0, -15, -15])
  const orbitTx = useTransform(scrollYProgress, okeys, [0, -targetRadius, -targetRadius, 0, 0])
  const focusStrength = useTransform(scrollYProgress, okeys, [0, 1, 1, 0, 0])

  const orbitProgress = useMotionValue(0)
  const prevScroll = useRef(0)
  useAnimationFrame((_t: number, delta: number) => {
    const pos = scrollYProgress.get()
    const scrollDelta = pos - prevScroll.current
    prevScroll.current = pos
    const speed = pos > 0.15 && pos < 0.85 ? scrollDelta * 200 : (delta / 1000) * 2.5
    orbitProgress.set(orbitProgress.get() + speed)
  })

  const fade = { y: yElement, filter: filterText, opacity: textOpacity }

  return (
    <div ref={containerRef} className="sm-reveal-track">
      <div className="sm-reveal-sticky">
        <div className="sm-reveal-backdrop" aria-hidden="true" />

        <motion.div className="sm-reveal-iris" style={{ clipPath, rotate: -15 }}>
          <div className="sm-reveal-plate" />
          <div className="sm-reveal-plate-inner">
            <div className="sm-reveal-orbit">
              <OrbitImages
                images={ORBIT_IMAGES}
                altPrefix="StillMe step"
                shape="ellipse"
                direction="normal"
                duration={40}
                fill={true}
                showPath={false}
                responsive={true}
                baseWidth={800}
                progressOverride={orbitProgress}
                radiusXOverride={orbitRx}
                radiusYOverride={orbitRy}
                itemSizeOverride={orbitItemSize}
                rotationOverride={orbitRotation}
                translateXOverride={orbitTx}
                focusStrength={focusStrength}
              />
            </div>
          </div>
        </motion.div>

        <div className="sm-reveal-copy">
          <div id="reveal-center-text" className="sm-reveal-center">
            <motion.div className="sm-reveal-center-inner" style={{ filter: filterText, opacity: textOpacity }}>
              <p className="sm-reveal-line1">
                <em>Y</em>our words. Your voice.
              </p>
              <p className="sm-reveal-line2">heard, drafted and spoken only when you say so</p>
            </motion.div>
          </div>

          <motion.div id="reveal-tag-left" className="sm-reveal-tag sm-reveal-tag-tr" style={fade}>
            <span className="sm-reveal-num">0</span>
            <span className="sm-reveal-cap">
              WORDS SPOKEN
              <br />
              WITHOUT YOUR OK
            </span>
          </motion.div>

          <motion.div id="reveal-tag-right" className="sm-reveal-tag sm-reveal-tag-bl" style={fade}>
            <span className="sm-reveal-num">32</span>
            <span className="sm-reveal-cap">LANGUAGES UNDERSTOOD</span>
          </motion.div>

          <div id="reveal-cta-block" className="sm-reveal-cta">
            <motion.p className="sm-reveal-cta-text" style={fade}>
              THE CONVERSATION IS STILL YOURS. STILLME JUST MAKES ROOM FOR IT.
            </motion.p>
            <motion.div className="sm-reveal-cta-row" style={fade}>
              <a href="/dashboard" onClick={onEnter} className="sm-reveal-btn">
                TAKE BACK THE CONVERSATION
              </a>
              <a href="/dashboard" onClick={onEnter} aria-label="Open the StillMe dashboard" className="sm-reveal-btn-arrow">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </a>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  )
}
