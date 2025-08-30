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
  depends_on_section_id: null
}

type Message = { id: string; role: 'user'|'assistant'|'system'|'tool'; content: string; created_at: string }
type Thread = { id: string }

const normalize = (s: string) => s.replace(/創/g, '作').trim()
const MAX_QA_ROUNDS = 12

// ───────── 企画書ドラフトの見出し検出（表記ゆれ吸収）─────────
const DRAFT_TITLE_RE =
  /^\s*(?:企画書(?:（ドラフト）|ドラフト)?)(?:（\d+枚）|\(\d+枚\))?\s*(.*)$/
const isProposalDraft = (txt: string) => {
  if (!txt) return false
  const firstLine = txt.split('\n')[0] ?? ''
  return DRAFT_TITLE_RE.test(firstLine.trim())
}
const extractDraftTitle = (txt: string) => {
  const firstLine = (txt.split('\n')[0] ?? '').trim()
  const quoted = firstLine.match(/『([^』]+)』/)
  if (quoted) return quoted[1]
  const m = firstLine.match(DRAFT_TITLE_RE)
  return (m?.[1] || '企画書ドラフト').trim()
}

// 目次候補の型
type TocItem = { title: string, children?: TocItem[] }
const findJsonBlocks = (src: string): string[] => {
  const blocks: string[] = []
  if (!src) return blocks
  const re = /```json\s*([\s\S]*?)```/gi
  let m
  while ((m = re.exec(src)) !== null) blocks.push((m[1] || '').trim())
  return blocks
}
const pickTocFromJson = (obj: any): TocItem[] => {
  const cands = obj?.toc ?? obj?.chapters ?? obj?.outline ?? obj?.sections ?? obj?.目次 ?? obj?.pdf?.sections
  if (!cands) return []
  const toItem = (x: any): TocItem | null => {
    if (!x) return null
    if (typeof x === 'string') return { title: x }
    const title = x.title ?? x.name ?? x.heading ?? x.label ?? x.caption
    const children = Array.isArray(x.children || x.items)
      ? (x.children || x.items).map(toItem).filter(Boolean)
      : undefined
    return title ? { title: String(title), children } : null
  }
  if (Array.isArray(cands)) return cands.map(toItem).filter(Boolean) as TocItem[]
  if (typeof cands === 'object' && Array.isArray(cands.items)) {
    return cands.items.map(toItem).filter(Boolean) as TocItem[]
  }
  return []
}
const pickTocFromDraftText = (draft: string): TocItem[] => {
  if (!draft) return []
  const lines = draft.split('\n')
  const out: TocItem[] = []
  let seenHeader = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(章立ての骨子|章立て|目次)/.test(line)) { seenHeader = true; continue }
    if (!seenHeader) continue
    if (/^[-・\u30fb]\s*(序章|第[0-9一二三四五六七八九十百]+章)/.test(line)) {
      const title = line.replace(/^[-・\u30fb]\s*/, '')
      out.push({ title })
    } else if (!/^[-・\u30fb]/.test(line) && out.length > 0) {
      break
    }
  }
  return out
}

// ───────── セクション・ガイド（NEW）─────────
const SECTION_LABEL: Record<Section['type'], string> = {
  proposal: '企画書',
  title: 'タイトル',
  toc: '目次',
  preface: '前書き',
  chapter: '本文（章）',
  afterword: '後書き',
}

const getPrevSection = (current: Section | null, all: Section[]): Section | null => {
  if (!current) return null
  const ordered = [...all].sort((a,b)=>a.position-b.position)
  const i = ordered.findIndex(s => s.id === current.id)
  return i > 0 ? ordered[i-1] : null
}

const buildGuideBody = (sec: Section, prev?: { name: string, done: boolean }): string => {
  const warnPrev = prev && !prev.done
    ? `\n\n※先に「${prev.name}」を仕上げておくと、このセクションが格段に進めやすくなります。`
    : ''
  const tail = `\n\n下の入力欄に書きたい内容を送ってください。短文・箇条書きでもOKです。`

  switch (sec.type) {
    case 'title':
      return `【ガイド】${SECTION_LABEL[sec.type]}の書き方
このセクションでは本の「タイトル／サブタイトル」の案を作ります。
- 30字前後の強い主張
- サブタイトルで対象とベネフィット
- 3案ほど出し、良い点・懸念も書きます${warnPrev}${tail}`
    case 'toc':
      return `【ガイド】${SECTION_LABEL[sec.type]}の作り方
このセクションでは「章立て（目次）」を作ります。
- 序章→…→終章の流れ
- 各章の目的と到達点を1行で
- 章数・並びは後から調整可能${warnPrev}${tail}`
    case 'preface':
      return `【ガイド】${SECTION_LABEL[sec.type]}を書く
前書き（序章）では読者への「約束」を明確にします。
- 読者の悩み／背景
- 本を読むと何ができるか（ベネフィット）
- 本の使い方・読み方の提案
- 本文につながる導入${warnPrev}${tail}`
    case 'chapter':
      return `【ガイド】${SECTION_LABEL[sec.type]}を書く
1章分の本文を作っていきます。推奨構成：
- 導入（狙い・前提）
- 本論（見出し2〜3、具体例・手順）
- まとめ（持ち帰り）
- 次章へのブリッジ${warnPrev}${tail}`
    case 'afterword':
      return `【ガイド】${SECTION_LABEL[sec.type]}を書く
後書きでは読後の余韻と行動を促します。
- 感謝・制作の裏話
- 執筆で得た示唆
- 続編や関連リソース、読後アクション${warnPrev}${tail}`
    default: // proposal
      return `【ガイド】${SECTION_LABEL['proposal']}
はじめにこれから作る本の企画書を作りましょう。下の入力欄から作成したい本について書いてみて下さい！${tail}`
  }
}

const seedSectionWelcome = async (threadId: string, sec: Section, prevSec: Section | null) => {
  // 既に何か投稿があれば種まき不要
  const { data: exists } = await supabase
    .from('chat_messages')
    .select('id').eq('thread_id', threadId).limit(1)
  if ((exists?.length ?? 0) > 0) return

  // 直前セクションが確定済みかを確認（ガイド文の注意書きにだけ反映）
  let prevInfo: { name: string, done: boolean } | undefined
  if (prevSec) {
    const { data: fin } = await supabase
      .from('section_documents')
      .select('id').eq('section_id', prevSec.id).eq('is_final', true).limit(1)
    prevInfo = { name: prevSec.name, done: (fin?.length ?? 0) > 0 }
  }

  const text = buildGuideBody(sec, prevInfo)
  const { data: user } = await supabase.auth.getUser()
  await supabase.from('chat_messages').insert({
    thread_id: threadId,
    role: 'assistant',
    content: text,
    created_by: user?.user?.id
  })
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
  const [creatingSection, setCreatingSection] = useState(false)

  const [dependencyReady, setDependencyReady] = useState(true)
  const [finalizedSet, setFinalizedSet] = useState<Set<string>>(new Set())

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [isComposing, setIsComposing] = useState(false)

  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollToBottom = (smooth = true) =>
    endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  useEffect(() => { scrollToBottom(false) }, [activeSection])
  useEffect(() => { scrollToBottom(true) }, [messages.length])

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

  const seededRef = useRef(false)

  const [askedCount, setAskedCount] = useState<number>(0)
  const [proposalAnswers, setProposalAnswers] = useState<ProposalAnswerMap>({})
  const [pendingQText, setPendingQText] = useState<string | null>(null)

  // ── 新しいセクション追加カード用の状態（見切れ対策済みUIに対応）
  const [showNewCard, setShowNewCard] = useState(false)
  const [newType, setNewType] = useState<Section['type']>('title')
  const [newName, setNewName] = useState('')
  const [newChapNo, setNewChapNo] = useState<number | ''>('')

  // ---- sections の共通再読込ヘルパ
  const loadSectionsFromDb = async (): Promise<Section[]> => {
    const { data, error } = await supabase
      .from('sections')
      .select('id, name, type, chapter_no, position, has_chat, can_delete, status, depends_on_section_id')
      .eq('book_id', bookId)
      .order('position')
    if (error) {
      console.error('loadSections error:', error)
      return []
    }
    setSections(data ?? [])
    return data ?? []
  }

  // 初回読み込み
  useEffect(() => {
    const run = async () => {
      const data = await loadSectionsFromDb()
      // 企画書だけが最初に表示される前提で、最初の has_chat セクションへ
      const first = (data ?? []).find(s => s.has_chat) ?? (data ?? [])[0]
      setActiveSection(first?.id ?? null)
    }
    run()
  }, [bookId])

  // finalized（確定済み一覧）
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
    const { data: msgs, error } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at')
    if (error) console.error('refreshMessages error:', error)
    setMessages(msgs ?? [])
  }

  // proposal_state 読み込み
  const loadProposalState = async (threadId: string) => {
    const { data, error } = await supabase
      .from('proposal_state')
      .select('step_idx, answers')
      .eq('thread_id', threadId)
      .maybeSingle()
    if (error) console.error('loadProposalState error:', error)
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
    const { error } = await supabase
      .from('proposal_state')
      .upsert({
        thread_id: threadId,
        step_idx: count,
        answers,
        updated_at: new Date().toISOString()
      }, { onConflict: 'thread_id' })
    if (error) console.error('saveProposalState error:', error)
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(stepKey(threadId), String(count))
      sessionStorage.setItem(answerKey(threadId), JSON.stringify(answers))
    }
  }

  // thread & messages & ガイド種まき
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
        const { data: ins, error: insErr } = await supabase
          .from('chat_threads')
          .insert({ book_id: bookId, section_id: activeSection, title: 'メインチャット', created_by: user?.user?.id })
          .select('id').single()
        if (insErr) console.error('create thread error:', insErr)
        threadId = ins?.id
      }
      if (!threadId) return
      setThread({ id: threadId })

      await refreshMessages(threadId)

      // ⬇️ ここから：全セクションにガイドを一度だけ自動投稿
      const { data: sec } = await supabase
        .from('sections').select('*').eq('id', activeSection).single()
      const prev = getPrevSection(sec as Section, sections)
      await seedSectionWelcome(threadId, sec as Section, prev)
      await refreshMessages(threadId)
      // ⬆️ ここまで

      await loadProposalState(threadId)

      const lastAssistant = [...(messages || [])].filter(m => m.role === 'assistant').slice(-1)[0]
      if ((sec as Section)?.type === 'proposal' && lastAssistant?.content?.startsWith('【質問】')) {
        const firstLine = (lastAssistant.content.split('\n')[0] || '').replace(/^【質問】/, '')
        setPendingQText(firstLine || null)
      } else {
        setPendingQText(null)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, activeSection])

  // 依存充足（すべて自由編集OKにする）
  useEffect(() => {
    if (!activeSection) return
    setDependencyReady(true)
  }, [activeSection])

  // 依存での表示制限は撤廃：単純に並び順で表示
  const visibleSections = useMemo(() => {
    return [...sections].sort((a,b)=>a.position-b.position)
  }, [sections])

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

  // ───────── ドラフト検出（PDF出力にも使う） ─────────
  const latestDraftText = useMemo(() => {
    const arr = [...messages].reverse()
    const hit = arr.find((m) => m.role === 'assistant' && isProposalDraft(m.content))
    return hit?.content ?? null
  }, [messages])

  // ───────── ドラフトから目次抽出（JSON優先 → テキスト） ─────────
  const draftToc: TocItem[] = useMemo(() => {
    for (const m of [...messages].reverse()) {
      if (m.role !== 'assistant') continue
      const blocks = findJsonBlocks(m.content)
      for (const b of blocks) {
        try {
          const obj = JSON.parse(b)
          const toc = pickTocFromJson(obj)
          if (toc.length) return toc
        } catch {}
      }
      try {
        const obj = JSON.parse(m.content)
        const toc = pickTocFromJson(obj)
        if (toc.length) return toc
      } catch {}
    }
    if (latestDraftText) {
      const t = pickTocFromDraftText(latestDraftText)
      if (t.length) return t
    }
    return []
  }, [messages, latestDraftText])

  // ── LLMプランナー ──
  const askPlannerNext = async (threadId: string, answers: ProposalAnswerMap, count: number) => {
    const system = buildPlannerPrompt(aiNick, answers, count, MAX_QA_ROUNDS)
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'system', content: system }] })
    })
    const data = await res.json()
    let raw = (data?.content as string) || ''

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
    } catch {
      decision = 'ask'
      question = 'この企画の想定読者をもう少し具体化するためのポイントは？'
      followups = []
    }

    if (decision === 'summary' || count >= MAX_QA_ROUNDS) {
      await askProposalSummary(threadId, answers)
      setPendingQText(null)
      return 'summarized'
    }

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

  // ---- ドラフト要約生成 ----
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
      thread_id: thread.id,
      role: 'assistant',
      content,
      created_by: user?.user?.id
    })
    await refreshMessages(thread.id)
  }

  // 送信
  const handleSendMessage = async () => {
    if (isComposing) return
    const content = chatInput.trim()
    if (!content || !thread || isSending || !dependencyReady) {
      setChatInput('')
      if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto' }
      return
    }
    setChatInput('')
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto' }
    setIsSending(true)
    const threadId = thread.id

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
        if (!expectingAnswer && !proposalAnswers[SEED_ANSWER_KEY]) {
          const nextAnswers = { ...proposalAnswers, [SEED_ANSWER_KEY]: content }
          setProposalAnswers(nextAnswers)
          await saveProposalState(threadId, askedCount, nextAnswers)
          await askPlannerNext(threadId, nextAnswers, askedCount)
          return
        }
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
        const baseHistory = messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user'|'assistant', content: m.content }))
        const system = `あなたは編集者AIです。ユーザーがあなたに付けた呼び名は「${aiNick}」。必要に応じてその名で最小限に名乗って構いません。`
        const history = [{ role: 'system' as const, content: system }, ...baseHistory, { role: 'user' as const, content }]
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
      if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto'; inputRef.current.focus() }
    }
  }

  // ------ PDF 出力関連 -----------------
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const draftToPrintHtml = (draft: string, meta: { title: string, author: string }) => {
    const lines = draft.split('\n')
    const htmlParts: string[] = []
    let inList = false
    const pushCloseList = () => { if (inList) { htmlParts.push('</ul>'); inList = false } }
    lines.forEach((raw, idx) => {
      const line = raw.trim()
      if (idx === 0) return
      if (!line) { pushCloseList(); htmlParts.push('<div class="spacer"></div>'); return }
      if (!/^[\-\u30fb・]/.test(line)) { pushCloseList(); htmlParts.push(`<h2>${escapeHtml(line)}</h2>`); return }
      const liText = line.replace(/^[-・\u30fb]\s?/, '')
      if (!inList) { htmlParts.push('<ul>'); inList = true }
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
               'Noto Sans JP','Hiragino Kaku Gothic ProN','Meiryo', sans-serif; color:var(--fg); }
        .header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:10pt; }
        .brand { font-size:10pt; color:var(--muted); }
        h1 { font-size:20pt; margin:0 0 4pt; }
        .meta { font-size:10pt; color:var(--muted); border-bottom:1px solid var(--rule); padding-bottom:6pt; }
        h2 { font-size:13.5pt; margin:14pt 0 6pt; border-left:4pt solid #3b82f6; padding-left:8pt; }
        ul { margin:4pt 0 8pt 18pt; padding:0; } li { line-height:1.7; margin:2pt 0; }
        .spacer { height:6pt; }
        .footer { position:fixed; bottom:12mm; left:18mm; right:18mm; font-size:9pt; color:var(--muted);
                  display:flex; justify-content:space-between; }
        .container { page-break-inside:auto; }
      </style>`
    const titleHtml = `
      <div class="header">
        <div>
          <div class="brand">Chat BOOKS / ${escapeHtml(meta.author)}</div>
          <h1>${escapeHtml(meta.title)}</h1>
          <div class="meta">企画書（ドラフト） — ${dateStr}</div>
        </div>
      </div>`
    const bodyHtml = `<div class="container">${htmlParts.join('\n')}</div>`
    const footerHtml = `<div class="footer"><div>© CONNECT INC.</div><div>${dateStr}</div></div>`
    return `<!doctype html><html><head><meta charset="utf-8" />${css}</head><body>${titleHtml}${bodyHtml}${footerHtml}</body></html>`
  }
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
    doc?.open(); doc?.write(html); doc?.close()
    const doPrint = () => {
      try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }
      finally { setTimeout(() => iframe.remove(), 1500) }
    }
    if (iframe.contentWindow?.document.readyState === 'complete') setTimeout(doPrint, 300)
    else iframe.onload = () => setTimeout(doPrint, 300)
  }

  const showFinalize = (m: Message) => {
    const sec = sections.find(s => s.id === activeSection)
    if (!sec) return false
    if (sec.type === 'proposal') return false     // 企画書では「確定」ボタンを出さない
    if (m.role !== 'assistant') return false
    if (normalize(m.content) === normalize(WELCOME_TEXT)) return false
    if (m.content.startsWith('【ガイド】')) return false // ガイド文にも出さない
    return true
  }

  // ───────── セクション作成（個別 / 一括）─────────

  // 既存の簡易作成（非表示にしてもOK。必要なら残す）
  const createSectionFromTitle = async (title: string) => {
    if (creatingSection) return
    setCreatingSection(true)
    try {
      const lastNo = sections.filter(s=>s.type==='chapter').reduce((m,s)=>Math.max(m, s.chapter_no||0), 0)
      const nextNo = lastNo + 1
      const safeTitle = (title || `本文（第${nextNo}章）`).slice(0,120)

      const { data, error } = await supabase.from('sections').insert({
        book_id: bookId,
        name: safeTitle,
        type: 'chapter',
        chapter_no: nextNo,
        position: 100 + nextNo * 10,
        has_chat: true,
        can_delete: true,
        status: 'draft',
        depends_on_section_id: null,
      }).select('id, name, type, chapter_no, position, has_chat, can_delete, status, depends_on_section_id').single()

      if (error) { console.error('Failed to create section:', error); alert(`セクション作成に失敗: ${error.message || ''}`) }

      const list = await loadSectionsFromDb()
      const focusId = data?.id ?? list.find(s => s.name === safeTitle)?.id
      if (focusId) setActiveSection(focusId)
      setSearchQuery('')
    } catch (e:any) {
      console.error(e)
      alert('セクション作成中にエラーが発生しました')
    } finally {
      setCreatingSection(false)
    }
  }

  // NEW: カードから追加
  const createSectionManual = async () => {
    if (creatingSection) return
    setCreatingSection(true)
    try {
      // 章番号の決定
      let chapNo: number | null = null
      if (newType === 'chapter') {
        if (newChapNo === '') {
          const lastNo = sections.filter(s=>s.type==='chapter').reduce((m,s)=>Math.max(m, s.chapter_no||0), 0)
          chapNo = lastNo + 1
        } else {
          chapNo = Number(newChapNo) || 1
        }
      }

      // デフォ名
      const defaultName =
        newType === 'title' ? 'タイトル' :
        newType === 'toc' ? '目次' :
        newType === 'preface' ? '前書き' :
        newType === 'afterword' ? '後書き' :
        `本文（第${chapNo ?? 1}章）`

      const safeName = (newName || defaultName).slice(0, 120)

      // position ルール
      const pos =
        newType === 'title' ? 10 :
        newType === 'toc' ? 20 :
        newType === 'preface' ? 30 :
        newType === 'afterword' ? 999 :
        100 + (chapNo ?? 1) * 10

      const canDel = newType === 'chapter' ? true : false

      const payload: any = {
        book_id: bookId,
        name: safeName,
        type: newType,
        chapter_no: newType === 'chapter' ? chapNo : null,
        position: pos,
        has_chat: true,
        can_delete: canDel,
        status: 'draft',
        depends_on_section_id: null,
      }

      const { data, error } = await supabase.from('sections')
        .insert(payload)
        .select('id, name, type, chapter_no, position, has_chat, can_delete, status, depends_on_section_id')
        .single()
      if (error) { console.error(error); alert(`セクション作成に失敗: ${error.message}`) }

      const list = await loadSectionsFromDb()
      const focusId = data?.id ?? list.find(s => s.name === safeName && s.type === newType && s.chapter_no === payload.chapter_no)?.id
      if (focusId) setActiveSection(focusId)

      // 片付け
      setShowNewCard(false)
      setNewName('')
      setNewChapNo('')
    } catch (e:any) {
      console.error(e)
      alert('セクション作成中にエラーが発生しました')
    } finally {
      setCreatingSection(false)
    }
  }

  const bulkCreateFromDraftToc = async () => {
    for (const item of draftToc) {
      const exists = sections.some(s => s.name === item.title)
      if (!exists) await createSectionFromTitle(item.title)
    }
  }

  // 履歴全削除（→ 各セクションのガイドを再投入）
  const clearThreadMessages = async () => {
    if (!thread) return
    const ok = confirm('このセクションの会話履歴をすべて削除します。よろしいですか？')
    if (!ok) return
    const { error } = await supabase.rpc('clear_chat_messages', { p_thread_id: thread.id })
    if (error) { await supabase.from('chat_messages').delete().eq('thread_id', thread.id) }
    setMessages([])

    await supabase.from('proposal_state').delete().eq('thread_id', thread.id)
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(stepKey(thread.id))
      sessionStorage.removeItem(answerKey(thread.id))
    }
    setAskedCount(0)
    setProposalAnswers({})
    setPendingQText(null)

    // クリア後にガイドを再投入
    const sec = sections.find(s => s.id === activeSection) as Section | undefined
    const prev = getPrevSection(sec ?? null, sections)
    await seedSectionWelcome(thread.id, sec as Section, prev ?? null)
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
              type="button"
              variant="ghost"
              className="w-full justify-start gap-2 text-gray-600 hover:text-gray-800"
              onClick={() => router.push('/')}
            >
              <Home className="w-4 h-4" />
              Home
            </Button>

            <div>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start gap-2 text-gray-800 bg-white shadow-sm"
              >
                <ChevronDown className="w-4 h-4" />
                <BookOpen className="w-4 h-4" />
                この書籍
              </Button>

              {/* 既存セクション */}
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
                      type="button"
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
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 hover:bg-red-100"
                          onClick={async (e) => {
                            e.stopPropagation()
                            try {
                              const { error } = await supabase.from('sections').delete().eq('id', section.id)
                              if (error) throw error
                              await loadSectionsFromDb()
                            } catch (err:any) {
                              console.error(err)
                              alert('セクションの削除に失敗しました')
                            }
                          }}
                        >
                          <Minus className="w-3 h-3 text-red-500" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 cursor-move">
                          <GripVertical className="w-3 h-3 text-gray-400" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}

                {/* 新しいセクション（手動カード） */}
                <div className="pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-gray-600 hover:text-gray-800"
                    disabled={creatingSection}
                    onClick={() => setShowNewCard(v=>!v)}
                  >
                    <Plus className="w-3 h-3" />
                    新しいセクション
                  </Button>

                  {showNewCard && (
                    <div className="mt-2 p-3 bg-white rounded-lg shadow-sm border space-y-3 overflow-visible">
                      <div className="text-xs text-gray-500">カテゴリを選択</div>

                      {/* カテゴリボタン：折り返しOK＋高さ可変 */}
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { key:'title', label:'タイトル' },
                          { key:'toc', label:'目次' },
                          { key:'preface', label:'前書き（序章）' },
                          { key:'chapter', label:'本文（章）' },
                          { key:'afterword', label:'後書き' },
                        ] as {key:any,label:string}[]).map(opt => (
                          <Button
                            key={opt.key}
                            type="button"
                            variant={newType === opt.key ? 'default' : 'outline'}
                            onClick={() => setNewType(opt.key)}
                            className="w-full h-auto min-h-[36px] px-2 py-1.5 text-xs leading-tight !whitespace-normal break-words"
                          >
                            {opt.label}
                          </Button>
                        ))}
                      </div>

                      {/* 章番号 */}
                      {newType === 'chapter' && (
                        <div className="space-y-1">
                          <div className="text-xs text-gray-600">章番号</div>
                          <Input
                            type="number"
                            value={String(newChapNo)}
                            onChange={(e)=> setNewChapNo(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="例: 1"
                            className="h-9 text-sm"
                          />
                        </div>
                      )}

                      {/* セクション名 */}
                      <div className="space-y-1">
                        <div className="text-xs text-gray-600">セクション名</div>
                        <Input
                          value={newName}
                          onChange={(e)=> setNewName(e.target.value)}
                          placeholder={
                            newType==='title'?'タイトル':
                            newType==='toc'?'目次':
                            newType==='preface'?'前書き':
                            newType==='afterword'?'後書き':'本文（第N章）'
                          }
                          className="h-9 text-sm"
                        />
                      </div>

                      {/* アクション */}
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full h-9 text-xs !whitespace-normal"
                          onClick={() => { setShowNewCard(false); setNewName(''); setNewChapNo('') }}
                        >
                          キャンセル
                        </Button>
                        <Button
                          type="button"
                          className="w-full h-auto min-h-[36px] text-xs leading-tight !whitespace-normal break-words"
                          onClick={createSectionManual}
                          disabled={creatingSection}
                          title="この内容で追加"
                        >
                          この内容で追加
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

              </div>

              {/* ───────── ドラフト章立て（提案） ───────── */}
              {draftToc.length > 0 && (
                <div className="mt-4">
                  <div className="px-2 flex items-center justify-between">
                    <div className="text-xs text-gray-500">ドラフト章立て（提案）</div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="h-6"
                      onClick={bulkCreateFromDraftToc}
                      disabled={creatingSection}
                      title="ドラフトの章立てをセクションに一括反映"
                    >
                      一括反映
                    </Button>
                  </div>
                  <div className="ml-4 mt-2 space-y-1">
                    {draftToc.map((item, idx) => (
                      <div key={`${item.title}-${idx}`} className="flex items-center gap-2 w-full">
                        <div className="text-sm text-gray-700 flex-1 min-w-0 truncate">{item.title}</div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="h-6 w-6 p-0 shrink-0"
                          title="セクションとして追加"
                          onClick={() => createSectionFromTitle(item.title)}
                          disabled={creatingSection}
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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

          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={handleExportPdf}
            disabled={!latestDraftText}
            title={latestDraftText ? '企画書ドラフトをPDFで出力' : 'ドラフトがありません'}
          >
            PDF出力
          </Button>

          <Button
            type="button"
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
              type="button"
              onClick={() => { if (!isComposing) handleSendMessage() }}
              size="icon"
              className="h-10 w-10"
              disabled={isSending || !dependencyReady}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}