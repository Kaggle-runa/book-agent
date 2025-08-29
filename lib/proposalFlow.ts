// /lib/proposalFlow.ts
// 企画書作成フロー（LLM主導プランナー版）
// - PROPOSAL_HINTS は参照用ヒントのみ（固定ステップではない）
// - LLM に「次に何を聞くか／まとめに移るか」を JSON で判断させる
// - 保存スキーマ: proposal_state.answers は { [key: string]: string(JSON) }
//   例: answers.q1 = JSON.stringify({ question: "想定読者は？", answer: "..." })

export type ProposalAnswerMap = Record<string, string>

// 参考ヒント（LLMに渡す“網羅の目安”。順守は不要）
export const PROPOSAL_HINTS: string[] = [
  "読者像（想定読者・非想定読者・読むシーン・読み方）",
  "コアメッセージ（最重要メッセージ・動機・著者が書く理由・一言要約）",
  "メインポイント（3点程度：主張・根拠・経験・NG/注意・裏付け）",
  "追加ポイント（あればもう1点）",
  "比較・賛否（共感する他者の方法／異なる方法・長所短所）",
  "エクストラ（興味が薄い層へのフック・必要習慣/アイテム・読後の姿・文体トーン・画像の要否・著者写真）",
  "章立て骨子（序章～）",
  "著者情報・補足事項"
]

// 初回のウェルカム文
export const WELCOME_TEXT =
  'はじめにこれから作る本の企画書を作りましょう。下の入力欄から作成したい本について書いてみて下さい！'

// 最初の「〇〇な本が書きたい！」を保存するキー
export const SEED_ANSWER_KEY = '__seed_pitch'

// セッション保存キー
export const stepKey = (threadId: string) => `proposalStep:${threadId}`          // 完了Q&A件数
export const answerKey = (threadId: string) => `proposalAnswers:${threadId}`    // 回答集(JSON)

// ── ユーティリティ ────────────────────────────────────────────────
function extractQAPairs(answers: ProposalAnswerMap): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = []
  Object.entries(answers).forEach(([k, v]) => {
    if (k === SEED_ANSWER_KEY) return
    try {
      const obj = JSON.parse(v)
      if (obj && typeof obj === 'object' && obj.question && obj.answer) {
        pairs.push({ question: String(obj.question), answer: String(obj.answer) })
        return
      }
    } catch {}
    // フォールバック: question 不明の素のテキストとして扱う
    pairs.push({ question: '(質問テキスト不明)', answer: String(v) })
  })
  return pairs
}

// 質問表示フォーマットを生成
export function buildQuestionMessage(main: string, followups?: string[]) {
  const lines = [`【質問】${main}`]
  if (Array.isArray(followups) && followups.length > 0) {
    followups.slice(0, 2).forEach(f => lines.push(`・${f}`))
  }
  return lines.join('\n')
}

// ── LLM プロンプト生成 ─────────────────────────────────────────────

// 次のアクションを決める（質問 or まとめ）ためのプロンプト
// モデル出力は必ず JSON のみ：
// { "decision":"ask","question":"...", "followups":["..."] }
// もしくは
// { "decision":"summary","reason":"..." }
export function buildPlannerPrompt(
  aiNick: string,
  answers: ProposalAnswerMap,
  askedCount: number,
  maxRounds = 12
) {
  const seed = (answers?.[SEED_ANSWER_KEY] ?? '').toString()
  const qaPairs = extractQAPairs(answers)
  const qaList = qaPairs.map((p, i) => `Q${i + 1}: ${p.question}\nA${i + 1}: ${p.answer}`).join('\n\n')

  const hintBullets = PROPOSAL_HINTS.map(h => `- ${h}`).join('\n')

  return [
    `あなたは編集者AI「${aiNick}」。単発の“1枚企画書”を作るため、必要最小限の質問で著者から情報を引き出します。`,
    `今の収集状況を鑑み、次にすべきことを **JSONのみ** で返してください。`,
    `方針:`,
    `- 長引かせない。1ターンで主質問1つ＋必要なら補助質問を最大2つまで。`,
    `- すでに十分な情報が集まったと判断したら、"summary" を選びます。`,
    `- 想定する1枚企画書の項目（柔軟に）：背景/読者/提供価値(セールスポイント)/章立て骨子/著者情報/補足。`,
    `- 参考ヒント（完全準拠は不要）:\n${hintBullets}`,
    ``,
    `制約:`,
    `- 出力は必ず JSON のみ。前後の文章・記号・コードフェンスは禁止。`,
    `- 文字数を絞る。説明は "reason" に短く。`,
    `- 現時点のQ&Aが ${askedCount} 件。最大でも概ね ${maxRounds} ラウンド以内にまとめに進むこと。`,
    ``,
    `初期ピッチ（著者の最初の入力）:\n${seed || '(未入力)'}\n`,
    `これまでのQ&A:\n${qaList || '(なし)'}\n`,
    `返答JSONスキーマ例（どちらか）:`,
    `{"decision":"ask","question":"想定読者は？","followups":["読むシーンは？"]}`,
    `{"decision":"summary","reason":"読者像と主要な価値、章立てが揃ったため"}`,
  ].join('\n')
}

// 全回答から1枚企画書のドラフト文面を構成するシステムプロンプト
export function buildSummaryPrompt(aiNick: string, answers: ProposalAnswerMap) {
  const seed = answers?.[SEED_ANSWER_KEY] ? `- Seed: ${(answers[SEED_ANSWER_KEY] || '').toString().slice(0, 800)}` : ''
  const qaPairs = extractQAPairs(answers)
  const qaLines = qaPairs
    .map((p, i) =>
      `- Q${i + 1}: ${p.question}\n  A${i + 1}: ${p.answer.slice(0, 1000)}`
    )
    .join('\n')

  return [
    `あなたは編集者AI「${aiNick}」。以下の材料から“1枚企画書”のドラフトを日本語で作成します。`,
    `禁止: 事実の創作・未回答の補完。空欄は「（未記入）」と明示。`,
    `構成（見出し＋箇条書き中心。必要なら短い1〜2文の補足可）:`,
    `- 企画の背景（読者課題/市場感/著者動機）`,
    `- セールスポイント（3点）`,
    `- 対象読者（想定/非想定・読むシーン/読み方）`,
    `- 章立ての骨子（序章〜全体像）`,
    `- 著者について（書く理由・強み）`,
    `- 補足事項（写真・取材・体裁・今後の研究など）`,
    ``,
    `材料:`,
    seed,
    qaLines || '(Q&Aなし)',
  ].join('\n')
}
