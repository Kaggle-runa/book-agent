'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabaseClient'
import { BookOpen, Home, User, Plus, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'

type UIBook = {
  id: string
  title: string
  subtitle?: string | null
  date?: string | null
  cover?: string | null
  hasContent: boolean
}

export default function HomePage() {
  const [books, setBooks] = useState<UIBook[]>([])
  const [loading, setLoading] = useState(true)
  const [isSending, setIsSending] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('v_books_summary')
      .select('id, title, subtitle, cover_url, has_content, last_activity_at')
      .order('last_activity_at', { ascending: false })
    setLoading(false)
    if (error) { console.error(error); return }
    setBooks((data ?? []).map(b => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      date: b.last_activity_at ? new Date(b.last_activity_at).toLocaleDateString('ja-JP') : null,
      cover: b.cover_url,
      hasContent: b.has_content
    })))
  }

  useEffect(() => { load() }, [])

  const sidebarItems = useMemo(() =>
    [{ name: 'Home', icon: Home, href: '/', active: true } as const]
      .concat(books.map((b) => ({ name: b.title, icon: BookOpen, href: `/chat/${b.id}`, active: false }))),
    [books]
  )

  const handleCreateBook = async () => {
    const title = prompt('新しい書籍タイトルを入力してください')?.trim()
    if (!title) return
    const { data, error } = await supabase.rpc('create_book_with_defaults', { p_title: title, p_subtitle: null })
    if (error) { alert(error.message); return }
    // 生成直後の画面に遷移
    window.location.href = `/chat/${data}`
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* ────────── サイドバー ────────── */}
      <div className="w-64 bg-gray-200 border-r border-gray-300 flex flex-col">
        {/* ヘッダー */}
        <div className="p-4 border-b border-gray-300">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-gray-700" />
            <div>
              <div className="text-sm text-gray-600">Life Ai</div>
              <div className="font-semibold text-gray-800">Chat BOOKS</div>
            </div>
          </div>
        </div>

        {/* ナビゲーション */}
        <ScrollArea className="flex-1 p-4 min-h-0">
          <div className="space-y-2">
            {sidebarItems.map((item) => (
              <Link key={item.name} href={item.href} legacyBehavior>
                <Button
                  asChild
                  variant={item.active ? 'secondary' : 'ghost'}
                  className={`w-full justify-start gap-2 ${item.active ? 'bg-white shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}
                >
                  <a>
                    <item.icon className="w-4 h-4" />
                    {item.name}
                  </a>
                </Button>
              </Link>
            ))}
          </div>

          {/* 新規追加ボタン */}
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 mt-4 text-gray-600 hover:text-gray-800"
            onClick={handleCreateBook}
          >
            <Plus className="w-4 h-4" />
            新しい書籍
          </Button>
        </ScrollArea>

        {/* アカウント情報 */}
        <div className="p-4 border-t border-gray-300">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <User className="w-4 h-4" />
            Account
          </div>
          <Button variant="ghost" className="mt-2 w-full justify-start gap-2 text-gray-600" onClick={signOut}>
            <LogOut className="w-4 h-4" /> サインアウト
          </Button>
          <div className="text-xs text-gray-500 mt-2">© 2025 CONNECT INC.</div>
        </div>
      </div>

      {/* ────────── メイン ────────── */}
      <div className="flex-1 p-8">
        {loading ? (
          <div className="text-sm text-gray-500">読み込み中…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {books.map((book) => (
              <Link key={book.id} href={`/chat/${book.id}`} legacyBehavior>
                <Card className="bg-white shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                  <CardContent className="p-4">
                    <div className="aspect-[3/4] mb-3 bg-gray-100 rounded-lg overflow-hidden">
                      {book.hasContent && book.cover ? (
                        <Image
                          src={book.cover}
                          alt={book.title}
                          width={200}
                          height={300}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-gray-200 flex items-center justify-center">
                          {!book.hasContent && <Plus className="w-8 h-8 text-gray-400" />}
                        </div>
                      )}
                    </div>
                    <div className="text-center">
                      <h3 className="font-medium text-gray-800 mb-1">{book.title}</h3>
                      {book.subtitle && <p className="text-xs text-gray-600 mb-2">{book.subtitle}</p>}
                      <p className="text-xs text-gray-500">{book.date ?? ''}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}

            {/* 新規作成カード */}
            <Card
              onClick={handleCreateBook}
              className="bg-white shadow-sm hover:shadow-md transition-shadow cursor-pointer border-dashed border-2 border-gray-300"
            >
              <CardContent className="p-4">
                <div className="aspect-[3/4] mb-3 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Plus className="w-12 h-12 text-gray-400" />
                </div>
                <div className="text-center">
                  <h3 className="font-medium text-gray-600">新しい書籍を作成</h3>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
