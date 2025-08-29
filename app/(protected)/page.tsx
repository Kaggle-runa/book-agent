// @ts-nocheck
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabaseClient'
import {
  BookOpen, Home, User, Plus, LogOut, Loader2, Sparkles, MoreVertical, Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

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

  // Wizard (OpenAI)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [nickname, setNickname] = useState('')
  const [impression, setImpression] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [impressing, setImpressing] = useState(false)

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<UIBook | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('v_books_summary')
      .select('id, title, subtitle, cover_url, has_content, last_activity_at')
      .order('last_activity_at', { ascending: false })
    setLoading(false)
    if (error) return console.error(error)
    setBooks((data ?? []).map((b: any) => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      date: b.last_activity_at ? new Date(b.last_activity_at).toLocaleDateString('ja-JP') : null,
      cover: b.cover_url,
      hasContent: b.has_content,
    })))
  }

  useEffect(() => { load() }, [])

  const sidebarItems = useMemo(
    () => ([{ name: 'Home', icon: Home, href: '/', active: true }] as const)
      .concat(books.map((b) => ({ name: b.title, icon: BookOpen, href: `/chat/${b.id}`, active: false }))),
    [books]
  )

  // ── Wizard 起動
  const openWizard = () => {
    setWizardOpen(true)
    setNickname('')
    setImpression('')
  }

  // ── ニックネームの感想生成 → 確認モーダル
  const previewNickname = async () => {
    const name = nickname.trim()
    if (!name) { alert('ニックネームを入力してください'); return }

    setImpressing(true)
    try {
      const system =
        `次の日本語で1行だけ出力してください。` +
        `「ありがとうございます。${name}ですね！」に続けて、名前の印象から感じることを短く書きつつ、これから出版まで相棒としてよろしく！と言ったニュアンスで答えて下さい。`
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, history: [] })
      })
      const data = await res.json()
      setImpression(
        data?.content ?? `ありがとうございます。${name}ですね！これから出版まで相棒としてよろしく！`
      )
    } catch {
      setImpression(`ありがとうございます。${name}ですね！これから出版まで相棒としてよろしく！`)
    } finally {
      setImpressing(false)
      setConfirmOpen(true)
    }
  }

  // ── 書籍作成処理
  const createBookNow = async () => {
    try {
      if (!nickname.trim()) { alert('ニックネームを入力してください'); return }
      setCreating(true)

      const { data: bookId, error } = await supabase.rpc('create_book_with_defaults', {
        p_title: '無題の本', p_subtitle: null,
      })
      if (error) { alert(error.message); return }

      const { error: nickErr } = await supabase.rpc('upsert_editor_nickname', {
        p_book_id: bookId,
        p_nickname: nickname.trim(),
        p_persona: { suggestedByAI: true },
      })
      if (nickErr) { alert(nickErr.message); return }

      if (typeof window !== 'undefined') sessionStorage.setItem('onboardingHint', '1')
      window.location.href = `/chat/${bookId}?onboarding=1`
    } finally {
      setCreating(false)
    }
  }

  const confirmAndCreate = async () => {
    setConfirmOpen(false)
    await createBookNow()
  }

  // ── 書籍削除
  const askDelete = (book: UIBook) => setDeleteTarget(book)

  const deleteBook = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      const { error } = await supabase.from('books').delete().eq('id', deleteTarget.id)
      if (error) { alert(error.message); return }
      setBooks((prev) => prev.filter((b) => b.id !== deleteTarget.id))
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* サイドバー */}
      <div className="w-64 bg-gray-200 border-r border-gray-300 flex flex-col">
        <div className="p-4 border-b border-gray-300">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-gray-700" />
            <div>
              <div className="text-sm text-gray-600">Life Ai</div>
              <div className="font-semibold text-gray-800">Chat BOOKS</div>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 p-4 min-h-0">
          <div className="space-y-2">
            {sidebarItems.map((item) => (
              <Link key={item.href} href={item.href} legacyBehavior>
                <Button
                  asChild
                  variant={item.active ? 'secondary' : 'ghost'}
                  className={`w-full justify-start gap-2 ${item.active ? 'bg-white shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}
                >
                  <a><item.icon className="w-4 h-4" />{item.name}</a>
                </Button>
              </Link>
            ))}
          </div>

          <Button
            variant="ghost"
            className="w-full justify-start gap-2 mt-4 text-gray-600 hover:text-gray-800"
            onClick={openWizard}
          >
            <Plus className="w-4 h-4" />
            新しい書籍
          </Button>
        </ScrollArea>

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

      {/* メイン */}
      <div className="flex-1 p-8">
        {loading ? (
          <div className="text-sm text-gray-500">読み込み中…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {books.map((book) => (
              <Card key={book.id} className="bg-white shadow-sm hover:shadow-md transition-shadow relative">
                {/* 三点リーダーメニュー */}
                <div className="absolute top-2 right-2 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 p-0">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-red-600"
                        onClick={() => askDelete(book)}
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> 削除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <Link href={`/chat/${book.id}`} legacyBehavior>
                  <CardContent className="p-4 cursor-pointer">
                    <div className="aspect-[3/4] mb-3 bg-gray-100 rounded-lg overflow-hidden">
                      {book.hasContent && book.cover ? (
                        <Image src={book.cover} alt={book.title} width={200} height={300} className="w-full h-full object-cover" />
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
                </Link>
              </Card>
            ))}

            <Card onClick={openWizard} className="bg-white shadow-sm hover:shadow-md transition-shadow cursor-pointer border-dashed border-2 border-gray-300">
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

      {/* 新規作成ウィザード */}
      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" /> はじめまして、編集者AIです！
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              あなたの頭の中にあるアイデアをカタチにするお手伝いをいたします。
              {'\n'}
              一緒に力を合わして書籍にする前に、まずは相棒の私にニックネーム（愛称）をつけてくださいね！
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="nickname">ニックネーム</Label>
            <Input
              id="nickname"
              placeholder="例：ユキちゃん"
              value={nickname}
              onChange={(e)=>setNickname(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="secondary"
              onClick={previewNickname}
              disabled={impressing || !nickname.trim()}
            >
              {impressing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />生成中…
                </span>
              ) : (
                '確定'
              )}
            </Button>
            <Button variant="ghost" onClick={() => setWizardOpen(false)}>
              キャンセル
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 確認ポップアップ（ニックネーム） */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このニックネームで始めますか？</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {impression || 'ありがとうございます。素敵な名前です！これから出版まで相棒としてよろしく！'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>戻る</AlertDialogCancel>
            <AlertDialogAction onClick={confirmAndCreate}>
              OK、作り始める
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 削除確認ポップアップ */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o)=>!o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>書籍を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              一度削除すると元に戻せない場合があります。よろしければ「削除する」を押してください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={deleteBook}
              disabled={deleting}
            >
              {deleting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />削除中…
                </span>
              ) : (
                '削除する'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}