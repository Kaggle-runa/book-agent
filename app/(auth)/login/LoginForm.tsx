// LoginForm.tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BookOpen } from 'lucide-react'

export default function LoginForm() {
  const router = useRouter()
  const sp = useSearchParams()
  const next = sp.get('next') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace(next)
    })
  }, [router, next])

  const signin = async () => {
    setLoading(true); setMsg(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setMsg(error.message)
    else router.replace(next)
  }

  const signInWithGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: typeof window !== 'undefined'
        ? window.location.origin + `/login?next=${encodeURIComponent(next)}`
        : undefined
      }
    })
  }

  const magicLink = async () => {
    setLoading(true); setMsg(null)
    const { error } = await supabase.auth.signInWithOtp({ email })
    setLoading(false)
    setMsg(error ? error.message : 'メールのMagic Linkを確認してください')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-6">
      <Card className="w-full max-w-md shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-6">
            <BookOpen className="w-6 h-6 text-gray-700" />
            <div>
              <div className="text-sm text-gray-600">Life Ai</div>
              <div className="font-semibold text-gray-800">Chat BOOKS – Sign in</div>
            </div>
          </div>

          <div className="space-y-3">
            <Input placeholder="メールアドレス" value={email} onChange={(e)=>setEmail(e.target.value)} />
            <Input placeholder="パスワード" type="password" value={password} onChange={(e)=>setPassword(e.target.value)} />
            <Button className="w-full" onClick={signin} disabled={loading}>メール/パスワードでログイン</Button>
            <Button variant="secondary" className="w-full" onClick={magicLink} disabled={loading}>Magic Link を送る</Button>
            <div className="h-px bg-gray-200 my-2" />
            <Button variant="outline" className="w-full" onClick={signInWithGoogle}>
              Google で続行
            </Button>
          </div>

          {msg && <p className="text-sm text-red-600 mt-4">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
