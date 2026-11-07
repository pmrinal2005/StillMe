'use client'
/**
 * StillMe landing page. Structure adapted from the LokMitra landing (scroll-driven hero, cinematic paragraph,
 * coverflow-style stats, iris + orbit reveal) and re-themed to StillMe's iridescent glass look.
 *
 * Self-contained on purpose: no CDN scripts, no hotlinked video, no external requests beyond the Google Fonts the app
 * already allows. That keeps it inside the app's Content-Security-Policy (script-src 'self').
 * Every call to action enters the dashboard at /dashboard through a short fade veil.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Backdrop, Orb, type OrbState } from '@/components/ui/Orb'
import { BrandMark, BRAND_TAGLINE } from '@/components/ui/BrandMark'
import { Icon, type IconName } from '@/components/ui/Icon'
import RevealStage from './RevealStage'
import './landing.css'

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*+?'
const NBSP = '\u00A0'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

const DEMO: { state: OrbState; text: string }[] = [
  { state: 'listening', text: 'Your partner is speaking' },
  { state: 'drafting', text: 'Three drafts, ready in a breath' },
  { state: 'holding', text: 'Waiting for your OK' },
  { state: 'speaking', text: 'Spoken in your voice. Only yours.' },
]

const STEPS: { n: string; icon: IconName; title: string; body: string }[] = [
  { n: '01', icon: 'headphones', title: 'It listens, so you can breathe', body: 'Your partner talks as usual. StillMe turns their words into live captions and keeps up with the conversation so you never have to race it.' },
  { n: '02', icon: 'sparkle', title: 'It drafts, you decide', body: 'Three replies with different intents appear: carry on, ask for clarity, or politely decline. Pick one, rewrite it, or ignore them all and type your own.' },
  { n: '03', icon: 'voice', title: 'You approve, your voice speaks', body: 'Nothing is spoken until you approve the exact words. Then your chosen voice says them out loud, and a Stop button is always one tap away.' },
]

const STATS: { title: string; value: string; footer: string; details: string[] }[] = [
  { title: 'Spoken without your OK', value: '0', footer: 'Exact words, every time', details: ['A pause is never consent', 'The text you approve is the text spoken', 'Health, legal, money and consent topics are never auto replied'] },
  { title: 'Drafts per turn', value: '3', footer: 'Different intents, one tap', details: ['Continue, clarify or decline', 'Edit any draft before it speaks', 'Or ignore them and type your own'] },
  { title: 'Languages understood', value: '32', footer: 'Your partner can speak freely', details: ['Live captions as they talk', 'Reply spoken in six languages', 'Hindi and Marathi captions included'] },
  { title: 'Ready made voices', value: '24', footer: 'Plus a clone you consent to', details: ['Pick a voice that feels like you', 'Cloned voices need documented consent', 'Consent renews, and revokes in one tap'] },
  { title: 'Recordings kept', value: '0', footer: 'No audio, no transcripts', details: ['Captions live in memory only', 'No accounts and no sign in', 'Export or erase this device any time'] },
  { title: 'Tap to stop', value: '1', footer: 'Stop is always on screen', details: ['Large text mode for your partner', 'Phrase boards that work offline', 'Single switch scanning built in'] },
]

const TRUST: { icon: IconName; label: string }[] = [
  { icon: 'shield', label: 'Nothing speaks without your OK' },
  { icon: 'user', label: 'No account, no sign in' },
  { icon: 'wifiOff', label: 'Phrase boards work offline' },
  { icon: 'stop', label: 'Stop is always one tap away' },
]

/** Scramble-in text. SSR renders the real text (hidden until the effect starts, with a CSS safety net). */
function ScrambleText({ text, delay = 0, className = '' }: { text: string; delay?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = text
      el.dataset.state = 'done'
      return
    }
    let raf = 0
    let start = 0
    el.textContent = text.replace(/\S/g, NBSP)
    el.dataset.state = 'run'
    const tick = (now: number) => {
      if (!start) start = now
      const t = clamp01((now - start) / 900)
      let out = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === ' ') { out += ' '; continue }
        const th = i / text.length
        if (t >= th + 0.15) out += ch
        else if (t >= th - 0.1) out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
        else out += NBSP
      }
      el.textContent = t >= 1 ? text : out
      if (t < 1) raf = requestAnimationFrame(tick)
      else el.dataset.state = 'done'
    }
    const to = window.setTimeout(() => { raf = requestAnimationFrame(tick) }, delay)
    return () => { window.clearTimeout(to); cancelAnimationFrame(raf) }
  }, [text, delay])
  return <span ref={ref} className={`sm-scramble ${className}`} data-state="pre" aria-hidden="true">{text}</span>
}

export default function Landing() {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [demo, setDemo] = useState(0)
  const [reduced, setReduced] = useState(false)
  const heroRef = useRef<HTMLElement>(null)
  const orbRef = useRef<HTMLDivElement>(null)
  const storyRef = useRef<HTMLElement>(null)
  const storyInnerRef = useRef<HTMLHeadingElement>(null)
  const scrollerRef = useRef<HTMLUListElement>(null)
  const year = new Date().getFullYear()

  useEffect(() => {
    router.prefetch('/dashboard')
  }, [router])

  // Reduced motion + orb demo loop.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (reduced) return
    const id = window.setInterval(() => setDemo((d) => (d + 1) % DEMO.length), 2600)
    return () => window.clearInterval(id)
  }, [reduced])

  // Scroll choreography: hero fade + orb zoom/blur and the cinematic paragraph.
  useEffect(() => {
    let raf = 0
    const frame = () => {
      raf = 0
      const vh = window.innerHeight || 800
      const y = window.scrollY || 0
      if (!reduced) {
        const hero = heroRef.current
        if (hero) {
          const p = clamp01(y / (vh * 0.75))
          hero.style.opacity = String(1 - p)
          hero.style.transform = `scale(${1 - 0.04 * p})`
        }
        const orb = orbRef.current
        if (orb) {
          const p = clamp01(y / (vh * 1.1))
          orb.style.transform = `translate(-50%, calc(-50% + ${p * -40}px)) scale(${1 + p * 0.55})`
          orb.style.filter = `blur(${p * 22}px)`
          orb.style.opacity = String(1 - p * 0.85)
        }
        const story = storyRef.current
        const inner = storyInnerRef.current
        if (story && inner) {
          const r = story.getBoundingClientRect()
          const p = clamp01((vh - r.top) / (vh + r.height))
          const op = smooth(0.12, 0.38, p) * (1 - smooth(0.68, 0.92, p))
          const rot = 22 * (1 - smooth(0.1, 0.5, p))
          inner.style.opacity = String(op)
          inner.style.transform = `rotateX(${rot}deg) translateY(${(0.5 - p) * 60}px) translateZ(15px)`
        }
      }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(frame) }
    frame()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reduced])

  // Reveal-on-scroll for the steps, stats and trust blocks.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-sm-reveal]'))
    if (!('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('is-in'))
      return
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) } }),
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [])

  // bfcache: coming back with the veil still on would look frozen.
  useEffect(() => {
    const on = (e: PageTransitionEvent) => { if (e.persisted) setLeaving(false) }
    window.addEventListener('pageshow', on)
    return () => window.removeEventListener('pageshow', on)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [menuOpen])

  const enter = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return // let new-tab clicks through
      e.preventDefault()
      if (leaving) return
      setLeaving(true)
      setMenuOpen(false)
      const go = () => router.push('/dashboard')
      if (reduced) go()
      else window.setTimeout(go, 520)
    },
    [leaving, reduced, router],
  )

  const goTo = useCallback(
    (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      const el = document.getElementById(id)
      if (!el) return
      e.preventDefault()
      setMenuOpen(false)
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    },
    [reduced],
  )

  const scrollTop = () => {
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
  }

  const slide = (dir: 1 | -1) => {
    const el = scrollerRef.current
    if (!el) return
    const card = el.querySelector<HTMLElement>('li')
    const step = (card?.offsetWidth ?? 340) + 24
    el.scrollBy({ left: dir * step, behavior: reduced ? 'auto' : 'smooth' })
  }

  const cur = reduced ? { state: 'idle' as OrbState, text: 'Your voice, on your terms' } : DEMO[demo]

  return (
    <div className="sm-landing">
      <noscript>
        <style>{'.sm-scramble{visibility:visible!important}[data-sm-reveal]{opacity:1!important;transform:none!important}'}</style>
      </noscript>
      <Backdrop />
      <a className="sm-skip" href="#hero-section">Skip to content</a>

      {/* ------------------------------------------------ header */}
      <header id="main-header" className="sm-header">
        <div className="sm-header-inner">
          <div className="sm-header-left">
            <button type="button" className="sm-pill sm-logo-pill" onClick={scrollTop} aria-label="StillMe, back to top">
              <BrandMark size={30} />
              <span className="sm-wordmark">Still<b>Me</b></span>
            </button>
            <nav className="sm-pill sm-nav" aria-label="Primary">
              <a href="#how-section" onClick={goTo('how-section')}>How it works</a>
              <a href="#stats-section" onClick={goTo('stats-section')}>Why StillMe</a>
              <a href="#trust-section" onClick={goTo('trust-section')}>Trust</a>
            </nav>
            <button
              type="button"
              className="sm-pill sm-burger"
              aria-label="Toggle menu"
              aria-expanded={menuOpen}
              aria-controls="sm-mobile-menu"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className="sm-burger-icon" data-open={menuOpen} aria-hidden="true"><i /><i /><i /></span>
            </button>
          </div>
          <a className="sm-cta" href="/dashboard" onClick={enter} aria-label="Open the StillMe dashboard">
            <Icon name="grid" size={16} />
            <span>Open Dashboard</span>
          </a>
        </div>
        <nav id="sm-mobile-menu" className="sm-mobile-menu" data-open={menuOpen} aria-label="Primary mobile" hidden={!menuOpen}>
          <a href="#how-section" onClick={goTo('how-section')}>How it works</a>
          <a href="#stats-section" onClick={goTo('stats-section')}>Why StillMe</a>
          <a href="#trust-section" onClick={goTo('trust-section')}>Trust</a>
        </nav>
      </header>

      <main id="main-content">
        {/* ------------------------------------------------ hero */}
        <section id="hero-section" ref={heroRef} className="sm-hero" aria-labelledby="hero-heading">
          <div ref={orbRef} className="sm-hero-orb" aria-hidden="true">
            <Orb state={cur.state} size={440} reflection={false} />
          </div>

          <div className="sm-hero-top">
            <p className="sm-eyebrow rv-badge rv-badge-brand"><Icon name="sparkle" size={13} /> {BRAND_TAGLINE}</p>
            <h1 id="hero-heading" className="sm-hero-title">
              <span className="sm-vh">StillMe. Still me. Still speaking.</span>
              <ScrambleText text="STILLME" delay={80} className="sm-gradient" />
            </h1>
          </div>

          <div className="sm-hero-bottom">
            <div className="sm-hero-left">
              <p className="sm-hero-desc">
                A voice for the moments when words get stuck. Your partner speaks, StillMe listens and drafts three replies,
                and nothing is said until you approve the exact words. Then your voice speaks, and only yours.
              </p>
              <div className="sm-hero-actions">
                <a className="sm-btn sm-btn-primary" href="/dashboard" onClick={enter}>
                  <Icon name="mic" size={18} /> Open the dashboard
                </a>
                <a className="sm-btn sm-btn-ghost" href="#how-section" onClick={goTo('how-section')}>
                  See how it works
                </a>
              </div>
              <p className="sm-live rv-badge" aria-live="polite" aria-atomic="true">
                {cur.state === 'speaking' || cur.state === 'listening'
                  ? <span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span>
                  : <Icon name="sparkle" size={13} />}
                {cur.text}
              </p>
            </div>
            <p className="sm-hero-right" aria-hidden="true">
              <ScrambleText text="Still" delay={260} />
              <ScrambleText text="speaking." delay={440} className="sm-gradient" />
            </p>
          </div>
        </section>

        {/* ------------------------------------------------ cinematic paragraph */}
        <section id="story-section" ref={storyRef} className="sm-story" aria-labelledby="story-heading">
          <h2 id="story-heading" ref={storyInnerRef} className="sm-story-text">
            Losing your voice should never mean losing your say. StillMe listens to the conversation so you do not have to
            race it. It drafts three replies in the time it takes to breathe, you pick, edit or ignore them, and only the
            words you approve are spoken aloud. No autopilot. No guessing. Nobody talking over you. Just you, at the pace
            you choose, in a voice that is yours.
          </h2>
        </section>

        {/* ------------------------------------------------ how it works */}
        <section id="how-section" className="sm-how" aria-labelledby="how-heading">
          <p className="sm-kicker">How it works</p>
          <h2 id="how-heading" className="sm-h2">Listen. Draft. <span className="sm-gradient">You decide.</span></h2>
          <ol className="sm-steps">
            {STEPS.map((s, i) => (
              <li key={s.n} className="sm-step rv-glass" data-sm-reveal style={{ transitionDelay: `${i * 90}ms` }}>
                <span className="sm-step-n">{s.n}</span>
                <span className="sm-step-icon"><Icon name={s.icon} size={26} /></span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ------------------------------------------------ stats carousel */}
        <section id="stats-section" className="sm-stats" aria-labelledby="stats-heading">
          <p className="sm-kicker">Why StillMe</p>
          <h2 id="stats-heading" className="sm-h2">Built so the <span className="sm-gradient">person stays in charge.</span></h2>
          <div className="sm-scroller-wrap" data-sm-reveal>
            <ul ref={scrollerRef} className="sm-scroller" tabIndex={0} aria-label="StillMe facts. Scroll sideways to see more.">
              {STATS.map((c) => (
                <li key={c.title} className="sm-stat">
                  <article className="sm-stat-card rv-glass">
                    <h3 className="sm-stat-title">{c.title}</h3>
                    <p className="sm-stat-value">{c.value}</p>
                    <ul className="sm-stat-details">
                      {c.details.map((d) => (
                        <li key={d}><span className="sm-dot" aria-hidden="true" /><span>{d}</span></li>
                      ))}
                    </ul>
                    <p className="sm-stat-footer">{c.footer}</p>
                  </article>
                </li>
              ))}
            </ul>
            <div className="sm-scroller-nav">
              <button type="button" className="rv-btn" aria-label="Previous fact" onClick={() => slide(-1)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
              </button>
              <button type="button" className="rv-btn" aria-label="Next fact" onClick={() => slide(1)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ trust strip */}
        <section id="trust-section" className="sm-trust" aria-labelledby="trust-heading">
          <h2 id="trust-heading" className="sm-vh">Trust and safety</h2>
          <ul className="sm-trust-list">
            {TRUST.map((t, i) => (
              <li key={t.label} className="sm-trust-item rv-glass" data-sm-reveal style={{ transitionDelay: `${i * 70}ms` }}>
                <Icon name={t.icon} size={22} />
                <span>{t.label}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {/* ------------------------------------------------ iris + orbit reveal */}
      <section id="reveal-section" className="sm-reveal" aria-labelledby="reveal-heading">
        <h2 id="reveal-heading" className="sm-vh">Your words, drafted for you and spoken only when you approve</h2>
        <RevealStage onEnter={enter} />
      </section>

      <footer id="main-footer" className="sm-footer">
        <div className="sm-footer-brand">
          <BrandMark size={28} />
          <span><strong className="sm-wordmark">Still<b>Me</b></strong> · {BRAND_TAGLINE}</span>
        </div>
        <p className="sm-footer-note">
          {year} · Made so every voice gets the last word. StillMe is an assistive communication prototype, not a medical
          device. AI suggestions are drafts, and nothing is spoken without your approval of the exact words.
        </p>
        <a className="sm-footer-link" href="/dashboard" onClick={enter}>Open the dashboard <span aria-hidden="true">→</span></a>
      </footer>

      {leaving && (
        <div id="dash-veil" className="sm-veil" role="status" aria-live="polite">
          <BrandMark size={64} />
          <span className="sm-veil-label">Opening your StillMe dashboard</span>
        </div>
      )}
    </div>
  )
}
