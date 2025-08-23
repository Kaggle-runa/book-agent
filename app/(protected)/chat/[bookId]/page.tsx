'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import {
  BookOpen, Home, User, ChevronDown, ChevronRight, Send, FileText, Search,
  GripVertical, Minus, List, Edit, Plus, CornerUpLeft, CornerUpRight, Eraser
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

type Section = {
  id: string
  name: string
  type: 'proposal'|'title'|'toc'|'preface'|'chapter'|'afterword'
  chapter_no: number | null
  position: number
  has_chat: boolean
  can_delete: boolean
  status: 'draft'|'in_review'|'finalized'
  depends_on_section_id: string | null
}

type Message = { id: string; role: 'user'|'assistant'|'system'|'tool'; content: string; created_at: string }
type Thread = { id: string }

export default function ChatPage() {
  const params = useParams()
  const router = useRouter()
  const bookId = Array.isArray(params.bookId) ? params.bookId[0] : (params.bookId as string)

  const [sections, setSections] = useState<Section[]>([])
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  // 依存充足フラグ（＝現在のセクションの前セクションが確定済みか）
  const [dependencyReady, setDependencyReady] = useState(true)
  // 各セクションの「確定済み」集合（section_documents の is_final=true を一括取得）
  const [finalizedSet, setFinalizedSet] = useState<Set<string>>(new Set())

  // --- 自動スクロール（下端へ）
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollToBottom = (smooth = true) => endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  useEffect(() => { scrollToBottom(false) }, [activeSection])
  useEffect(() => { scrollToBottom(true) }, [messages.length])

  // sections 読み込み（依存列を含める）
  useEffect(() => {
    const loadSections = async () => {
      const { data, error } = await supabase
        .from('sections')
        .select('id, name, type, chapter_no, position, has_chat, can_delete, status, depends_on_section_id')
        .eq('book_id', bookId)
        .order('position')
      if (error) { console.error(error); return }
      setSections(data ?? [])
      const first = (data ?? []).find(s => s.has_chat) ?? (data ?? [])[0]
      setActiveSection(first?.id ?? null)
    }
    loadSections()
  }, [bookId])

  // セクションの確定状況を一括取得して finalizedSet へ
  useEffect(() => {
    const fetchFinals = async () => {
      if (sections.length === 0) { setFinalizedSet(new Set()); return }
      const ids = sections.map(s => s.id)
      const { data, error } = await supabase
        .from('section_documents')
        .select('section_id')
        .in('section_id', ids)
        .eq('is_final', true)
      if (error) { console.error(error); return }
      setFinalizedSet(new Set((data ?? []).map(d => d.section_id)))
    }
    fetchFinals()
  }, [sections])

  // スレッド & メッセージ読み込み
  useEffect(() => {
    const loadThreadAndMessages = async () => {
      if (!activeSection) return
      const { data: t, error: te } = await supabase
        .from('chat_threads')
        .select('id')
        .eq('book_id', bookId)
        .eq('section_id', activeSection)
        .limit(1).maybeSingle()
      if (te) { console.error(te); return }
      let threadId = t?.id
      if (!threadId) {
        const { data: user } = await supabase.auth.getUser()
        const { data: ins, error: ie } = await supabase
          .from('chat_threads')
          .insert({ book_id: bookId, section_id: activeSection, title: 'メインチャット', created_by: user?.user?.id })
          .select('id').single()
        if (ie) { console.error(ie); return }
        threadId = ins.id
      }
      setThread({ id: threadId })

      const { data: msgs, error: me } = await supabase
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('thread_id', threadId)
        .order('created_at') // 古い→新しい（上から）
      if (me) { console.error(me); return }
      setMessages(msgs ?? [])
    }
    loadThreadAndMessages()
  }, [bookId, activeSection])

  // 現在セクションの依存充足チェック（未充足なら入力禁止＆警告）
  useEffect(() => {
    const check = async () => {
      if (!activeSection) return
      const sec = sections.find(s => s.id === activeSection)
      if (!sec?.depends_on_section_id) { setDependencyReady(true); return }
      // finalizedSet が最新ならそれで判定
      setDependencyReady(finalizedSet.has(sec.depends_on_section_id))
      // 念のためサーバ確認（最初の表示直後の同期ズレを補完）
      if (!finalizedSet.has(sec.depends_on_section_id)) {
        const { data } = await supabase
          .from('section_documents')
          .select('id')
          .eq('section_id', sec.depends_on_section_id)
          .eq('is_final', true)
          .limit(1)
        setDependencyReady((data?.length ?? 0) > 0)
      }
    }
    check()
  }, [activeSection, sections, finalizedSet])

  // ★ サイドバー表示用：上から順に、最初の「依存未充足」セクションまでだけ表示
  const visibleSections = useMemo(() => {
    const ordered = [...sections].sort((a,b)=>a.position-b.position)
    const idx = ordered.findIndex(sec =>
      !!sec.depends_on_section_id && !finalizedSet.has(sec.depends_on_section_id)
    )
    if (idx === -1) return ordered
    // 依存未充足のセクションまでは表示（＝作業できるようにする）、それ以降は非表示
    return ordered.slice(0, idx + 1)
  }, [sections, finalizedSet])

  // アクティブセクションが非表示になった場合は、最後に見えるセクションへ合わせる
  useEffect(() => {
    if (!activeSection) return
    if (!visibleSections.find(s => s.id === activeSection)) {
      const lastVisible = visibleSections[visibleSections.length - 1]
      setActiveSection(lastVisible?.id ?? null)
    }
  }, [visibleSections, activeSection])

  const filteredVisibleSections = useMemo(() => {
    if (!searchQuery.trim()) return visibleSections
    const q = searchQuery.toLowerCase()
    return visibleSections.filter(s => s.name.toLowerCase().includes(q))
  }, [visibleSections, searchQuery])

  const getCurrentSectionName = () => sections.find(s => s.id === activeSection)?.name ?? 'セクション'

  // 送信（前セクションの確定内容を OpenAI に同梱）
  const handleSendMessage = async () => {
    if (!chatInput.trim() || !thread || isSending || !dependencyReady) return
    const content = chatInput
    setChatInput('')
    setIsSending(true)

    const tempId = 'temp_' + Date.now()
    setMessages(prev => [...prev, { id: tempId, role: 'user', content, created_at: new Date().toISOString() }])

    const { data: user } = await supabase.auth.getUser()
    await supabase
      .from('chat_messages')
      .insert({ thread_id: thread.id, role: 'user', content, created_by: user?.user?.id })

    try {
      // 前セクションの確定内容
      let prevContent: string | null = null
      const sec = sections.find(s => s.id === activeSection)
      if (sec?.depends_on_section_id) {
        // finalizedSet にあるはずだが、内容が必要なので取得
        const { data: prevDoc } = await supabase
          .from('section_documents')
          .select('content')
          .eq('section_id', sec.depends_on_section_id)
          .eq('is_final', true)
          .limit(1).maybeSingle()
        prevContent = prevDoc?.content ?? null
      }

      const history = [...messages, { id: tempId, role: 'user' as const, content, created_at: new Date().toISOString() }]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role as 'user'|'assistant', content: m.content }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history, prev: prevContent })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'failed')

      const assistantText = data.content as string

      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantText,
        created_at: new Date().toISOString()
      }])

      await supabase
        .from('chat_messages')
        .insert({ thread_id: thread.id, role: 'assistant', content: assistantText, created_by: user?.user?.id })
    } catch (e) {
      console.error(e)
      alert('AI応答の取得に失敗しました')
    } finally {
      setIsSending(false)
    }
  }

  // AIメッセージから確定
  const finalizeFromText = async (content: string) => {
    if (!activeSection) return
    await supabase.from('section_documents')
      .update({ is_final: false, finalized_at: null })
      .eq('section_id', activeSection)
      .eq('is_final', true)
    const { data: user } = await supabase.auth.getUser()
    const { error } = await supabase.from('section_documents').insert({
      section_id: activeSection,
      format: 'markdown',
      content,
      is_final: true,
      finalized_at: new Date().toISOString(),
      updated_by: user?.user?.id
    })
    if (error) { alert(error.message); return }
    await supabase.from('sections').update({ status: 'finalized' }).eq('id', activeSection)
    // 確定後に finalizedSet を更新（自然に再計算されてサイドバーが開放される）
    setFinalizedSet(prev => new Set(prev).add(activeSection))
    alert('このレスポンスを確定しました')
  }

  // 履歴全削除
  const clearThreadMessages = async () => {
    if (!thread) return
    const ok = confirm('このセクションの会話履歴をすべて削除します。よろしいですか？')
    if (!ok) return
    const { error } = await supabase.rpc('clear_chat_messages', { p_thread_id: thread.id })
    if (error) {
      const { error: delErr } = await supabase.from('chat_messages').delete().eq('thread_id', thread.id)
      if (delErr) { alert(delErr.message); return }
    }
    setMessages([])
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* ───── サイドバー ───── */}
      <div className="w-64 bg-gray-200 border-r border-gray-300 flex flex-col h-full">
        {/* ヘッダー */}
        <div className="p-4 border-b border-gray-300 flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-gray-700" />
            <div>
              <div className="text-sm text-gray-600">Life Ai</div>
              <div className="font-semibold text-gray-800">Chat BOOKS</div>
            </div>
          </div>
        </div>

        {/* ナビゲーション */}
        <ScrollArea className="flex-1 p-4">
          <div className="space-y-2">
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 text-gray-600 hover:text-gray-800"
              onClick={() => router.push('/')}
            >
              <Home className="w-4 h-4" />
              Home
            </Button>

            <div>
              <Button
                variant="ghost"
                className={`w-full justify-start gap-2 text-gray-800 bg-white shadow-sm`}
              >
                <ChevronDown className="w-4 h-4" />
                <BookOpen className="w-4 h-4" />
                この書籍
              </Button>

              <div className="ml-6 mt-2 space-y-1">
                {filteredVisibleSections.length === 0 && (
                  <div className="text-xs text-gray-500 px-2 py-1">セクションがありません</div>
                )}

                {filteredVisibleSections.map((section) => (
                  <div
                    key={section.id}
                    className="relative group"
                    onMouseEnter={() => setHoveredItem(section.id)}
                    onMouseLeave={() => setHoveredItem(null)}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`w-full justify-start gap-2 text-sm pr-8 ${
                        activeSection === section.id ? 'bg-blue-100 text-blue-800' : 'text-gray-600 hover:text-gray-800'
                      }`}
                      onClick={() => setActiveSection(section.id)}
                    >
                      {section.type === 'proposal' ? <FileText className="w-3 h-3" /> :
                       section.type === 'preface' ? <Edit className="w-3 h-3" /> :
                       section.type === 'toc' ? <List className="w-3 h-3" /> :
                       section.type === 'chapter' ? <BookOpen className="w-3 h-3" /> :
                       section.type === 'title' ? <FileText className="w-3 h-3" /> :
                       <FileText className="w-3 h-3" />}
                      {section.name}
                      <ChevronRight className="w-3 h-3 ml-auto" />
                    </Button>

                    {hoveredItem === section.id && section.can_delete && (
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 hover:bg-red-100"
                          onClick={async (e) => {
                            e.stopPropagation()
                            await supabase.from('sections').delete().eq('id', section.id)
                            setSections(prev => prev.filter(s => s.id !== section.id))
                          }}
                        >
                          <Minus className="w-3 h-3 text-red-500" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 cursor-move">
                          <GripVertical className="w-3 h-3 text-gray-400" />
                        </Button>
                      </div>
                    )}

                    {/* 依存があるセクションには注意書き */}
                    {section.depends_on_section_id && !finalizedSet.has(section.depends_on_section_id) && (
                      <div className="ml-6 text-[10px] text-gray-400">依存: 他セクションの確定が必要</div>
                    )}
                  </div>
                ))}

                {/* 章追加：直前の章 or 前書き に依存 */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-gray-600 hover:text-gray-800"
                  onClick={async () => {
                    const lastNo = sections.filter(s=>s.type==='chapter').reduce((m,s)=>Math.max(m, s.chapter_no||0), 0)
                    const nextNo = lastNo + 1
                    const prevChapter = sections
                      .filter(s=>s.type==='chapter')
                      .sort((a,b)=>(a.chapter_no||0)-(b.chapter_no||0))
                      .slice(-1)[0]
                    const depends = prevChapter?.id ?? sections.find(s=>s.type==='preface')?.id ?? null

                    const { data, error } = await supabase.from('sections').insert({
                      book_id: bookId,
                      name: `本文（第${nextNo}章）`,
                      type: 'chapter',
                      chapter_no: nextNo,
                      position: 100 + nextNo * 10,
                      has_chat: true,
                      can_delete: true,
                      status: 'draft',
                      depends_on_section_id: depends,
                    }).select('id, name, type, chapter_no, position, has_chat, can_delete, status, depends_on_section_id').single()
                    if (!error && data) setSections(prev => [...prev, data].sort((a,b)=>a.position-b.position))
                  }}
                >
                  <Plus className="w-3 h-3" />
                  新しいセクション
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* 検索 */}
        <div className="p-4 border-t border-gray-300 flex-shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="テキストを検索"
              className="pl-10 text-sm"
            />
          </div>
        </div>

        {/* アカウント */}
        <div className="p-4 border-t border-gray-300 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <User className="w-4 h-4" />
            Account
          </div>
          <div className="text-xs text-gray-500 mt-2">© 2025 CONNECT INC.</div>
        </div>
      </div>

      {/* ───── メイン（本文＋入力欄） ───── */}
      <div className="flex-1 flex flex-col bg-white h-full relative">
        {/* 下部の操作 */}
        <div className="absolute left-4 bottom-4 flex gap-2">
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <CornerUpLeft className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <CornerUpRight className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            onClick={clearThreadMessages}
            disabled={!thread || messages.length === 0}
            title="このセクションのチャット履歴をすべて削除します"
          >
            <Eraser className="w-4 h-4 mr-1" />
            会話をリフレッシュ
          </Button>
        </div>

        {/* タイトル */}
        <div className="px-6 pt-4">
          <h2 className="text-2xl font-bold mb-2">{getCurrentSectionName()}</h2>
        </div>

        {/* メッセージ一覧（上→下） */}
        <div className="flex-1 px-6">
          <ScrollArea className="h-full" style={{ minHeight: '30vh', maxHeight: '60vh' }}>
            <div className="max-w-4xl mx-auto space-y-4 py-2">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] ${m.role === 'user' ? 'order-2' : 'order-1'}`}>
                    {m.role !== 'user' && (
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 bg-gray-300 rounded-full flex items中心 justify-center">
                          <span className="text-xs">AI</span>
                        </div>
                        <span className="text-xs text-gray-500">Life AI</span>
                      </div>
                    )}
                    <div className={`p-3 rounded-2xl ${
                      m.role === 'user'
                        ? 'bg-blue-100 text-gray-800 rounded-br-sm'
                        : 'bg-blue-500 text-white rounded-bl-sm'
                    }`}>
                      <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                      <div className={`text-[10px] mt-1 opacity-70 ${m.role === 'user' ? 'text-right' : 'text-left'}`}>
                        {new Date(m.created_at).toLocaleDateString('ja-JP')}
                      </div>

                      {/* AIメッセージから確定 */}
                      {m.role === 'assistant' && activeSection && (
                        <div className="mt-2">
                          <Button size="xs" variant="secondary" onClick={() => finalizeFromText(m.content)}>
                            この内容で確定
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          </ScrollArea>
        </div>

        {/* 入力欄（最下部固定） */}
        <div className="border-top bg-white p-4 mt-auto border-t">
          <div className="flex gap-2 w-full items-end">
            <Textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="メッセージを入力"
              className="flex-1 min-h-[60px] max-h-[200px]"
              disabled={!dependencyReady}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSendMessage()
                }
              }}
            />
            <Button onClick={handleSendMessage} size="icon" className="h-10 w-10" disabled={isSending || !dependencyReady}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
          {!dependencyReady && (
            <div className="text-xs text-red-500 mt-1">
              前のセクションが未確定です。先に確定してください。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}