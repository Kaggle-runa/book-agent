'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) router.replace(`/login?next=${encodeURIComponent(pathname)}`)
      else setReady(true)
    }
    init()
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace('/login')
    })
    return () => sub.subscription.unsubscribe()
  }, [router, pathname])

  if (!ready) return null
  return <>{children}</>
}