import type { Metadata } from 'next'
import Landing from '@/components/landing/Landing'

export const metadata: Metadata = {
  title: 'StillMe | Still me. Still speaking.',
  description:
    'StillMe listens to the conversation, drafts three replies, and speaks only the exact words you approve, in your voice. Assistive communication where the person stays in charge.',
  openGraph: {
    title: 'StillMe | Still me. Still speaking.',
    description: 'AI listens and drafts. You approve every word. Your voice speaks.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'StillMe: Still me. Still speaking.' }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'StillMe | Still me. Still speaking.', images: ['/og.png'] },
}

/** Landing first. Every call to action enters the dashboard at /dashboard. */
export default function HomePage() {
  return <Landing />
}
