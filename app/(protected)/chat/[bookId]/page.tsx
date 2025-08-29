// @ts-nocheck
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import {
  BookOpen, Home, User, ChevronDown, ChevronRight, Send, FileText, Search,
  GripVertical, Minus, List, Edit, Plus, CornerUpLeft, CornerUpRight, Eraser
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

import {
  WELCOME_TEXT,
  SEED_ANSWER_KEY,
  buildPlannerPrompt,
  buildSummaryPrompt,
  buildQuestionMessage,
  stepKey, answerKey,
  type ProposalAnswerMap
} from '@/lib/proposalFlow'

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

const normalize = (s: string) => s.replace(/創/g, '作').trim()
const MAX_QA_ROUNDS = 12

// ───────── 企画書ドラフトの見出し検出（表記ゆれ吸収）─────────
// 例: 「企画書（ドラフト）— …」「企画書ドラフト — …」「企画書ドラフト（1枚） — …」
const DRAFT_TITLE_RE =
  /^\s*(?:企画書(?:（ドラフト）|ドラフト)?)(?:（\d+枚）|\(\d+枚\))?\s*[—\-–―]\s*(.+)\s*$/

// 先頭行がドラフト見出しか？
const isProposalDraft = (txt: string) => {
  if (!txt) return false
  const firstLine = txt.split('\n')[0] ?? ''
  return DRAFT_TITLE_RE.test(firstLine.trim())
}

// 見出しからタイトルだけ抜く（PDFファイル名などに使用）
const extractDraftTitle = (txt: string) => {
  const firstLine = (txt.split('\n')[0] ?? '').trim()
  const quoted = firstLine.match(/『([^』]+)』/)
  if (quoted) return quoted[1]
  const m = firstLine.match(DRAFT_TITLE_RE)
  return (m?.[1] || '企画書ドラフト').trim()
}

export default function ChatPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const bookId = Array.isArray(params.bookId) ? params.bookId[0] : (params.bookId as string)

  const [sections, setSections] = useState<Section[]>([])
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  const [dependencyReady, setDependencyReady] = useState(true)
  const [finalizedSet, setFinalizedSet] = useState<Set<string>>(new Set())

  // 入力欄の完全リセット用
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [isComposing, setIsComposing] = useState(false)

  // 自動スクロール
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollToBottom = (smooth = true) => endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  useEffect(() => { scrollToBottom(false) }, [activeSection])
  useEffect(() => { scrollToBottom(true) }, [messages.length])

  // AIニックネーム（Supabase → fallback sessionStorage）
  const [aiNick, setAiNick] = useState('Life AI')
  useEffect(() => {
    const fetchNick = async () => {
      try {
        const { data, error } = await supabase.rpc('get_editor_nickname', { p_book_id: bookId })
        if (!error && data) {
          const n = typeof data === 'string' ? data : (data.nickname ?? data.name ?? '')
          if (n && n.trim()) {
            setAiNick(n.trim())
            if (typeof window !== 'undefined') sessionStorage.setItem(`aiNickname:${bookId}`, n.trim())
            return
          }
        }
      } catch {}
      if (typeof window !== 'undefined') {
        const cached = sessionStorage.getItem(`aiNickname:${bookId}`)
        if (cached && cached.trim()) setAiNick(cached.trim())
      }
    }
    fetchNick()
  }, [bookId])

  // オンボーディング制御
  const seededRef = useRef(false)

  // 企画書フロー状態（ローカル）＋ 永続バッファ
  // askedCount: 完了したQ&A件数（= proposal_state.step_idx）
  const [askedCount, setAskedCount] = useState<number>(0)
  const [proposalAnswers, setProposalAnswers] = useState<ProposalAnswerMap>({})
  const [pendingQText, setPendingQText] = useState<string | null>(null) // 直近の質問本文（回答待ち）

  // sections
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

  // finalized
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

  // messages loader
  const refreshMessages = async (threadId: string) => {
    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at')
    setMessages(msgs ?? [])
  }

  // proposal_state 読み込み
  const loadProposalState = async (threadId: string) => {
    const { data } = await supabase
      .from('proposal_state')
      .select('step_idx, answers')
      .eq('thread_id', threadId)
      .maybeSingle()
    if (data) {
      const ans = (data.answers as ProposalAnswerMap) ?? {}
      setAskedCount(data.step_idx ?? 0)
      setProposalAnswers(ans)
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(stepKey(threadId), String(data.step_idx ?? 0))
        sessionStorage.setItem(answerKey(threadId), JSON.stringify(ans))
      }
    } else {
      if (typeof window !== 'undefined') {
        const savedStep = sessionStorage.getItem(stepKey(threadId))
        const savedAns = sessionStorage.getItem(answerKey(threadId))
        if (savedStep) setAskedCount(Number(savedStep))
        if (savedAns) setProposalAnswers(JSON.parse(savedAns))
      }
    }
  }

  // proposal_state 保存
  const saveProposalState = async (threadId: string, count: number, answers: ProposalAnswerMap) => {
    await supabase
      .from('proposal_state')
      .upsert({
        thread_id: threadId,
        step_idx: count,
        answers,
        updated_at: new Date().toISOString()
      }, { onConflict: 'thread_id' })
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(stepKey(threadId), String(count))
      sessionStorage.setItem(answerKey(threadId), JSON.stringify(answers))
    }
  }

  // thread & messages & onboarding & proposal_state
  useEffect(() => {
    const load = async () => {
      if (!activeSection) return

      // thread 取得/作成
      const { data: t } = await supabase
        .from('chat_threads')
        .select('id')
        .eq('book_id', bookId)
        .eq('section_id', activeSection)
        .limit(1).maybeSingle()
      let threadId = t?.id
      if (!threadId) {
        const { data: user } = await supabase.auth.getUser()
        const { data: ins } = await supabase
          .from('chat_threads')
          .insert({ book_id: bookId, section_id: activeSection, title: 'メインチャット', created_by: user?.user?.id })
          .select('id').single()
        threadId = ins?.id
      }
      if (!threadId) return
      setThread({ id: threadId })

      await refreshMessages(threadId)

      // welcome seed（proposalのみ）
      const { data: sec } = await supabase
        .from('sections').select('type').eq('id', activeSection).single()

      const onboardingParam = searchParams.get('onboarding') === '1'
      const onboardingFlag = typeof window !== 'undefined' && sessionStorage.getItem('onboardingHint') === '1'
      const seededKey = `seededWelcome:${threadId}`
      const alreadySeededThisThread = typeof window !== 'undefined' && sessionStorage.getItem(seededKey) === '1'

      if (sec?.type === 'proposal' && !seededRef.current && !alreadySeededThisThread && (onboardingParam || onboardingFlag)) {
        const { data: latest } = await supabase
          .from('chat_messages')
          .select('id, role, content')
          .eq('thread_id', threadId)
          .eq('role', 'assistant')
          .order('created_at', { ascending: false })
          .limit(200)
        const exists = (latest ?? []).some(m => normalize(m.content) === normalize(WELCOME_TEXT))
        if (!exists) {
          const { data: user } = await supabase.auth.getUser()
          await supabase.from('chat_messages').insert({
            thread_id: threadId, role: 'assistant', content: WELCOME_TEXT, created_by: user?.user?.id
          })
          await refreshMessages(threadId)
        }
        seededRef.current = true
        if (typeof window !== 'undefined') {
          sessionStorage.setItem(seededKey, '1')
          sessionStorage.removeItem('onboardingHint')
        }
      }

      // 企画書フローの復元
      await loadProposalState(threadId)

      // 質問の保留文言（直近アシスタントが【質問】なら）
      const lastAssistant = [...(messages || [])].filter(m => m.role === 'assistant').slice(-1)[0]
      if (sec?.type === 'proposal' && lastAssistant?.content?.startsWith('【質問】')) {
        const firstLine = (lastAssistant.content.split('\n')[0] || '').replace(/^【質問】/, '')
        setPendingQText(firstLine || null)
      } else {
        setPendingQText(null)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, activeSection])

  // 依存充足
  useEffect(() => {
    if (!activeSection) return
    const sec = sections.find(s => s.id === activeSection)
    if (!sec?.depends_on_section_id) { setDependencyReady(true); return }
    setDependencyReady(finalizedSet.has(sec.depends_on_section_id))
  }, [activeSection, sections, finalizedSet])

  const visibleSections = useMemo(() => {
    const ordered = [...sections].sort((a,b)=>a.position-b.position)
    const idx = ordered.findIndex(sec =>
      !!sec.depends_on_section_id && !finalizedSet.has(sec.depends_on_section_id)
    )
    if (idx === -1) return ordered
    return ordered.slice(0, idx + 1)
  }, [sections, finalizedSet])

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

  // ── LLMプランナーに「次のアクション」を決めてもらう ──
  const askPlannerNext = async (threadId: string, answers: ProposalAnswerMap, count: number) => {
    const system = buildPlannerPrompt(aiNick, answers, count, MAX_QA_ROUNDS)

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'system', content: system }] })
    })
    const data = await res.json()
    let raw = (data?.content as string) || ''

    // JSON抽出
    const jsonStr = (() => {
      const m = raw.match(/```json\s*([\s\S]*?)```/i)
      if (m) return m[1].trim()
      return raw.trim()
    })()

    let decision: 'ask'|'summary' = 'ask'
    let question = ''
    let followups: string[] = []
    try {
      const obj = JSON.parse(jsonStr)
      if (obj?.decision === 'summary') {
        decision = 'summary'
      } else if (obj?.decision === 'ask') {
        decision = 'ask'
        question = String(obj?.question || '')
        if (Array.isArray(obj?.followups)) followups = obj.followups.filter(Boolean).map(String).slice(0,2)
      }
    } catch (e) {
      decision = 'ask'
      question = 'この企画の想定読者をもう少し具体化するためのポイントは？'
      followups = []
    }

    if (decision === 'summary' || count >= MAX_QA_ROUNDS) {
      await askProposalSummary(threadId, answers)
      setPendingQText(null)
      return 'summarized'
    }

    // 質問を投稿
    const content = buildQuestionMessage(question, followups)
    const { data: user } = await supabase.auth.getUser()
    await supabase.from('chat_messages').insert({
      thread_id: threadId,
      role: 'assistant',
      content,
      created_by: user?.user?.id
    })
    await refreshMessages(threadId)
    setPendingQText(question || null)
    return 'asked'
  }

  // ---- 全回答からドラフト要約 ----
  const askProposalSummary = async (threadId: string, answers: ProposalAnswerMap) => {
    const system = buildSummaryPrompt(aiNick, answers)
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'system', content: system }] })
    })
    const data = await res.json()
    const content = (data?.content as string) || '（ドラフト生成に失敗しました）'

    const { data: user } = await supabase.auth.getUser()
    await supabase.from('chat_messages').insert({
      thread_id: threadId,
      role: 'assistant',
      content,
      created_by: user?.user?.id
    })
    await refreshMessages(threadId)
  }

  // 送信
  const handleSendMessage = async () => {
    if (isComposing) return

    const content = chatInput.trim()
    if (!content || !thread || isSending || !dependencyReady) {
      setChatInput('')
      if (inputRef.current) {
        inputRef.current.value = ''
        inputRef.current.style.height = 'auto'
      }
      return
    }

    // 先にクリア
    setChatInput('')
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.style.height = 'auto'
    }

    setIsSending(true)
    const threadId = thread.id

    // 直前のアシスタントが「【質問】」かどうか
    const lastAssistant = [...messages].filter(m => m.role === 'assistant').slice(-1)[0]
    const expectingAnswer = Boolean(lastAssistant && lastAssistant.content.startsWith('【質問】'))

    const { data: user } = await supabase.auth.getUser()
    await supabase.from('chat_messages').insert({
      thread_id: threadId, role: 'user', content, created_by: user?.user?.id
    })
    await refreshMessages(threadId)

    try {
      const sec = sections.find(s => s.id === activeSection)

      if (sec?.type === 'proposal') {
        // ① 未開始: seed 保存 → 最初の質問
        if (!expectingAnswer && !proposalAnswers[SEED_ANSWER_KEY]) {
          const nextAnswers = { ...proposalAnswers, [SEED_ANSWER_KEY]: content }
          setProposalAnswers(nextAnswers)
          await saveProposalState(threadId, askedCount, nextAnswers)
          await askPlannerNext(threadId, nextAnswers, askedCount)
          return
        }

        // ② 進行中: 回答保存 → 次アクション
        const qIndex = askedCount + 1
        const qaKey = `q${qIndex}`
        const qaValue = JSON.stringify({ question: pendingQText ?? '(質問)', answer: content })
        const nextAnswers = { ...proposalAnswers, [qaKey]: qaValue }

        const nextCount = askedCount + 1
        setProposalAnswers(nextAnswers)
        setAskedCount(nextCount)
        await saveProposalState(threadId, nextCount, nextAnswers)

        const result = await askPlannerNext(threadId, nextAnswers, nextCount)
        if (result !== 'asked') setPendingQText(null)
      } else {
        // 通常チャット
        const baseHistory = messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user'|'assistant', content: m.content }))
          .concat([{ role: 'user' as const, content }])

        const system = `あなたは編集者AIです。ユーザーがあなたに付けた呼び名は「${aiNick}」。必要に応じてその名で最小限に名乗って構いません。`
        const history = [{ role: 'system' as const, content: system }, ...baseHistory]

        const res = await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history })
        })
        const data = await res.json()
        const assistantText = data.content as string

        await supabase.from('chat_messages').insert({
          thread_id: threadId, role: 'assistant', content: assistantText, created_by: user?.user?.id
        })
        await refreshMessages(threadId)
      }
    } catch (e) {
      console.error(e)
      alert('AI応答の取得に失敗しました')
    } finally {
      setIsSending(false)
      setChatInput('')
      if (inputRef.current) {
        inputRef.current.value = ''
        inputRef.current.style.height = 'auto'
        inputRef.current.focus()
      }
    }
  }

  // ------ PDF 出力関連（ドラフト検出・HTML生成・プリント） -----------------

  // 最後に出た「企画書ドラフト」本文を拾う（先頭行だけで判定）
  const latestDraftText = useMemo(() => {
    const arr = [...messages].reverse()
    const hit = arr.find((m) => m.role === 'assistant' && isProposalDraft(m.content))
    return hit?.content ?? null
  }, [messages])

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Draftテキスト → 印刷用HTML
  const draftToPrintHtml = (draft: string, meta: { title: string, author: string }) => {
    const lines = draft.split('\n')

    const htmlParts: string[] = []
    let inList = false

    const pushCloseList = () => {
      if (inList) {
        htmlParts.push('</ul>')
        inList = false
      }
    }

    // 1行ずつ簡易マークダウン化
    lines.forEach((raw, idx) => {
      const line = raw.trim()
      if (idx === 0) return // 先頭は別途ヘッダで描画

      if (!line) {
        pushCloseList()
        htmlParts.push('<div class="spacer"></div>')
        return
      }

      // 見出し（行頭に「-」が付いていない全角日本語の段落を見出し扱い）
      if (!/^[\-\u30fb・]/.test(line)) {
        pushCloseList()
        htmlParts.push(`<h2>${escapeHtml(line)}</h2>`)
        return
      }

      // 箇条書き
      const liText = line.replace(/^[-・\u30fb]\s?/, '')
      if (!inList) {
        htmlParts.push('<ul>')
        inList = true
      }
      htmlParts.push(`<li>${escapeHtml(liText)}</li>`)
    })
    pushCloseList()

    const today = new Date()
    const yyyy = today.getFullYear()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    const dateStr = `${yyyy}.${mm}.${dd}`

    const css = `
      <style>
        @page { size: A4; margin: 18mm; }
        :root { --fg:#111; --muted:#666; --rule:#e5e7eb; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
               'Noto Sans JP','Hiragino Kaku Gothic ProN','Meiryo', sans-serif;
               color:var(--fg); }
        .header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:10pt; }
        .brand { font-size:10pt; color:var(--muted); }
        h1 { font-size:20pt; margin:0 0 4pt; }
        .meta { font-size:10pt; color:var(--muted); border-bottom:1px solid var(--rule); padding-bottom:6pt; }
        h2 { font-size:13.5pt; margin:14pt 0 6pt; border-left:4pt solid #3b82f6; padding-left:8pt; }
        p { line-height:1.7; margin:4pt 0; }
        ul { margin:4pt 0 8pt 18pt; padding:0; }
        li { line-height:1.7; margin:2pt 0; }
        .spacer { height:6pt; }
        .footer { position:fixed; bottom:12mm; left:18mm; right:18mm; font-size:9pt; color:var(--muted); display:flex; justify-content:space-between; }
        @media print { .footer { position:fixed; } }
        .container { page-break-inside: auto; }
      </style>
    `

    const titleHtml = `
      <div class="header">
        <div>
          <div class="brand">Chat BOOKS / ${escapeHtml(meta.author)}</div>
          <h1>${escapeHtml(meta.title)}</h1>
          <div class="meta">企画書（ドラフト） — ${dateStr}</div>
        </div>
      </div>
    `

    const bodyHtml = `<div class="container">${htmlParts.join('\n')}</div>`

    const footerHtml = `<div class="footer"><div>© CONNECT INC.</div><div>${dateStr}</div></div>`

    return `<!doctype html><html><head><meta charset="utf-8" />${css}</head><body>${titleHtml}${bodyHtml}${footerHtml}</body></html>`
  }

  // about:blank ではなく hidden iframe で印刷
const handleExportPdf = () => {
  if (!latestDraftText) return
  const title = `『${extractDraftTitle(latestDraftText)}』 企画書`
  const html = draftToPrintHtml(latestDraftText, { title, author: aiNick || 'Life AI' })

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'
  document.body.appendChild(iframe)

  const doc = iframe.contentWindow?.document
  doc?.open()
  doc?.write(html)
  doc?.close()

  const doPrint = () => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } finally {
      // 印刷ダイアログを開いた後に掃除
      setTimeout(() => iframe.remove(), 1500)
    }
  }

  // レンダリング安定後に実行（Safari 対策で少し遅延）
  if (iframe.contentWindow?.document.readyState === 'complete') {
    setTimeout(doPrint, 300)
  } else {
    iframe.onload = () => setTimeout(doPrint, 300)
  }
}

  // proposal では確定ボタンを出さない
  const showFinalize = (m: Message) => {
    const sec = sections.find(s => s.id === activeSection)
    if (sec?.type === 'proposal') return false
    if (m.role !== 'assistant') return false
    if (normalize(m.content) === normalize(WELCOME_TEXT)) return false
    return true
  }

  // 履歴全削除（右上）
  const clearThreadMessages = async () => {
    if (!thread) return
    const ok = confirm('このセクションの会話履歴をすべて削除します。よろしいですか？')
    if (!ok) return
    const { error } = await supabase.rpc('clear_chat_messages', { p_thread_id: thread.id })
    if (error) {
      await supabase.from('chat_messages').delete().eq('thread_id', thread.id)
    }
    setMessages([])

    // 企画書フローもリセット（永続もクリア）
    await supabase.from('proposal_state').delete().eq('thread_id', thread.id)
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(stepKey(thread.id))
      sessionStorage.removeItem(answerKey(thread.id))
    }
    setAskedCount(0)
    setProposalAnswers({})
    setPendingQText(null)

    // 再度：歓迎のみ。質問はユーザーの最初の入力後に開始。
    const { data: user } = await supabase.auth.getUser()
    await supabase.from('chat_messages').insert({
      thread_id: thread.id, role: 'assistant', content: WELCOME_TEXT, created_by: user?.user?.id
    })
    await refreshMessages(thread.id)
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* サイドバー */}
      <div className="w-64 bg-gray-200 border-r border-gray-300 flex flex-col h-full">
        <div className="p-4 border-b border-gray-300 flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-gray-700" />
            <div>
              <div className="text-sm text-gray-600">Life Ai</div>
              <div className="font-semibold text-gray-800">Chat BOOKS</div>
            </div>
          </div>
        </div>

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
                className="w-full justify-start gap-2 text-gray-800 bg-white shadow-sm"
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
                  </div>
                ))}

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

      {/* メイン */}
      <div className="flex-1 flex flex-col bg-white h-full relative">
        {/* 右上操作 */}
        <div className="absolute right-4 top-4 flex gap-2 z-10">
          <Button size="icon" variant="ghost" className="h-8 w-8" title="元に戻す">
            <CornerUpLeft className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="やり直す">
            <CornerUpRight className="w-4 h-4" />
          </Button>

          {/* ★ PDF出力ボタン（ドラフト検出時のみ活性） */}
          <Button
            size="sm"
            variant="default"
            onClick={handleExportPdf}
            disabled={!latestDraftText}
            title={latestDraftText ? '企画書ドラフトをPDFで出力' : 'ドラフトがありません'}
          >
            PDF出力
          </Button>

          <Button
            size="sm"
            variant="outline"
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

        {/* メッセージ一覧 */}
        <div className="flex-1 px-6">
          <ScrollArea className="h-full" style={{ minHeight: '30vh', maxHeight: '60vh' }}>
            <div className="max-w-4xl mx-auto space-y-4 py-2">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] ${m.role === 'user' ? 'order-2' : 'order-1'}`}>
                    {m.role !== 'user' && (
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 bg-gray-300 rounded-full flex items-center justify-center">
                          <span className="text-xs">AI</span>
                        </div>
                        <span className="text-xs text-gray-500">{aiNick}</span>
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

                      {/* proposal では確定ボタンを出さない／WELCOME は出さない */}
                      {showFinalize(m) && (
                        <div className="mt-2">
                          <Button size="xs" variant="secondary" onClick={() => { /* finalizeFromText(m.content) */ }}>
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

        {/* 入力欄 */}
        <div className="border-top bg-white p-4 mt-auto border-t">
          <div className="flex gap-2 w-full items-end">
            <Textarea
              ref={inputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                  e.preventDefault()
                  handleSendMessage()
                }
              }}
              placeholder="メッセージを入力（例：『忙しい人向けに花を楽しむ本を書きたい！』など）"
              className="flex-1 min-h-[60px] max-h-[200px]"
              disabled={!dependencyReady}
            />
            <Button
              onClick={() => { if (!isComposing) handleSendMessage() }}
              size="icon"
              className="h-10 w-10"
              disabled={isSending || !dependencyReady}
            >
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