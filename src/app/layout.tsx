import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ServiceWorker } from '@/components/ServiceWorker'

export const metadata: Metadata = {
  title: 'ReVOICE — human-gated conversational voice',
  description: 'Assistive communication: AI listens and drafts, the person approves the exact words, their authorized voice speaks.',
  manifest: '/manifest.webmanifest',
  applicationName: 'ReVOICE',
}

export const viewport: Viewport = { themeColor: '#0b1020', width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <nav aria-label="Skip links">
          <a href="#composer-input" className="sr-only-focusable rv-btn absolute left-2 top-2 z-50">Skip to message composer</a>
        </nav>
        {children}
        <ServiceWorker />
      </body>
    </html>
  )
}
