import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ServiceWorker } from '@/components/ServiceWorker'

export const metadata: Metadata = {
  title: 'ReVOICE — human-gated conversational voice',
  description: 'Assistive communication: AI listens and drafts, the person approves the exact words, their authorized voice speaks.',
  manifest: '/manifest.webmanifest',
  applicationName: 'ReVOICE',
}

export const viewport: Viewport = { themeColor: '#f6f3fb', width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
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
