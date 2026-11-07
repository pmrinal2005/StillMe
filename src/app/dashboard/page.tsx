import type { Metadata } from 'next'
import { ReVoiceApp } from '@/components/ReVoiceApp'

export const metadata: Metadata = {
  title: 'Dashboard | StillMe',
  description: 'Your StillMe workspace: live captions, three editable drafts, and your approved voice.',
}

export default function DashboardPage() {
  return (
    <>
      <nav aria-label="Skip links">
        <a href="#composer-input" className="sr-only-focusable rv-btn absolute left-2 top-2 z-50">Skip to message composer</a>
      </nav>
      <ReVoiceApp />
    </>
  )
}
