import OpenAI from 'openai'
import { NextResponse } from 'next/server'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(req: Request) {
  try {
    const { history, system, prev } = await req.json() as {
      system?: string
      prev?: string | null
      history: Array<{ role: 'user'|'assistant'|'system'; content: string }>
    }

    const baseSystem =
      system ??
      'あなたは書籍出版アシスタントAIです。事実を作らず、簡潔に、箇条書きを優先して回答。'

    const systemWithPrev =
      prev && prev.trim()
        ? `${baseSystem}\n\n前セクションの確定内容:\n---\n${prev}\n---\nこの内容と整合し、矛盾しない提案/本文を出してください。`
        : baseSystem

    const messages = [{ role: 'system', content: systemWithPrev } as const, ...history.slice(-20)]

    // Chat Completions（安価で速いモデルを推奨）
    const resp = await client.chat.completions.create({
      model: 'gpt-5-mini',
      messages,
    })

    const text = resp.choices[0]?.message?.content ?? ''
    return NextResponse.json({ content: text })
  } catch (e: any) {
    console.error(e)
    return NextResponse.json({ error: e.message ?? 'openai_error' }, { status: 500 })
  }
}
