// ServerAI の Anthropic Messages API 呼び出しの組み立てと応答の読み取り (I/O なし、テスト可能)

// 現行世代: thinking は常に有効で、effort で考える量を決め、断られた依頼はサーバー側で別モデルにやり直せる
const CURRENT_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

// AI_EFFORT のうち Anthropic が受ける値だけを使う (OpenAI 向けの 'minimal' などは既定値にする)
export const anthropicEffort = (value, fallback = 'medium') => (EFFORTS.has(value) ? value : fallback)

// client.beta.messages.create に渡す引数。現行世代のモデルでは:
// - fallbacks: 'default' で、安全分類で断られた依頼を Anthropic 推奨の別モデルが同じ呼び出しの中でやり直す
// - output_config.effort で考える量を決める (Opus 5.5 の既定は medium)
// それ以外のモデルにはどちらも送らない (対応していないモデルでは 400 になり得る)
export function anthropicRequest({ model, effort, maxTokens, system, content }) {
  const params = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }
  if (CURRENT_MODELS.has(model)) {
    params.betas = [FALLBACK_BETA]
    params.fallbacks = 'default'
    params.output_config = { effort: anthropicEffort(effort) }
  }
  return params
}

// 応答から本文を取り出す。現行モデルは答える前に考えるので、先頭は thinking ブロックになり得る。
// 位置ではなく種類で読み、text ブロックだけをつなぐ。断られた・途中で切れた・本文が無い応答は失敗にする
// (途中で切れたスクリプトを保存しないため)
export function readAnthropicText(response) {
  const stop = response?.stop_reason
  if (stop === 'refusal') throw new Error('the AI declined this request')
  if (stop === 'max_tokens') throw new Error('the AI reply was cut off (max_tokens)')
  const blocks = Array.isArray(response?.content) ? response.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
  if (!text.trim()) throw new Error(`the AI returned no text (stop reason: ${stop ?? 'unknown'})`)
  return text
}
