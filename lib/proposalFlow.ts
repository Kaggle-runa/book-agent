// /lib/proposalFlow.ts
// 既存部分はそのまま。下にタイトル用追記あり。

export type ProposalAnswerMap = Record<string, string>

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

export const WELCOME_TEXT =
  'はじめにこれから作る本の企画書を作りましょう。下の入力欄から作成したい本について書いてみて下さい！'

export const SEED_ANSWER_KEY = '__seed_pitch'
export const stepKey   = (threadId: string) => `proposalStep:${threadId}`
export const answerKey = (threadId: string) => `proposalAnswers:${threadId}`

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
    pairs.push({ question: '(質問テキスト不明)', answer: String(v) })
  })
  return pairs
}

export function buildQuestionMessage(main: string, followups?: string[]) {
  const lines = [`【質問】${main}`]
  if (Array.isArray(followups) && followups.length > 0) {
    followups.slice(0, 2).forEach(f => lines.push(`・${f}`))
  }
  return lines.join('\n')
}

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
    `- 想定する1枚企画書の項目（柔軟に）：背景/読者/提供価値/章立て骨子/著者情報/補足。`,
    `- 参考ヒント:\n${hintBullets}`,
    `制約: 出力は必ずJSONのみ/短く/最大${maxRounds}ラウンドでまとめる。`,
    `初期ピッチ:\n${seed || '(未入力)'}\n`,
    `これまでのQ&A:\n${qaList || '(なし)'}\n`,
    `返答JSON例:`,
    `{"decision":"ask","question":"想定読者は？","followups":["読むシーンは？"]}`,
    `{"decision":"summary","reason":"読者像と主要な価値、章立てが揃ったため"}`,
  ].join('\n')
}

export function buildSummaryPrompt(aiNick: string, answers: ProposalAnswerMap) {
  const seed = answers?.[SEED_ANSWER_KEY] ? `- Seed: ${(answers[SEED_ANSWER_KEY] || '').toString().slice(0, 800)}` : ''
  const qaPairs = extractQAPairs(answers)
  const qaLines = qaPairs
    .map((p, i) => `- Q${i + 1}: ${p.question}\n  A${i + 1}: ${p.answer.slice(0, 1000)}`)
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
    `材料:`,
    seed,
    qaLines || '(Q&Aなし)',
  ].join('\n')
}

/* =========================
   タイトル用プロンプト（新規）
   ========================= */
// 企画書などのテキストを与えられたら参照しつつ、最大3案を提示。
// ユーザーが「案Nで確定」「この内容で確定」「これに決定」などと書いた場合、
// モデルは追加提案を行わず、短い了承のみを返すよう強く指示する。
export function buildTitlePrompt(
  aiNick: string,
  materials?: { proposal?: string; toc?: string }
) {
  return [
    `あなたは編集者AI「${aiNick}」。目的は本の「タイトル／サブタイトル」を決めること。`,
    `行動規範:`,
    `- まずは最大3案を提示。各案は厳密に次のフォーマットに従う:`,
    `- 案1
  - タイトル：〜
  - サブタイトル：〜
  - 良い点：〜
  - 懸念：〜`,
    `- 最後に問いは1つだけ。「どれでいきますか？／修正点は？」と短く聞く。`,
    `- ユーザーが「案Nで確定」「この内容で確定」「これに決定」等と明示した場合は、追加提案を一切行わず、`,
    `  「了解しました。タイトルを確定します。」等の短い了承のみ（1〜2文）。他作業の列挙は禁止。`,
    materials?.proposal ? `参照用（企画書抜粋）:\n${materials.proposal.slice(0,1200)}` : '',
    materials?.toc ? `参照用（目次骨子）:\n${materials.toc.slice(0,800)}` : '',
  ].filter(Boolean).join('\n')
}
