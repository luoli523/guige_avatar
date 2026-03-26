import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Simple in-memory rate limiter (resets on cold start) ──
const rateLimitMap = new Map();
const RATE_LIMIT = 20;       // max requests
const RATE_WINDOW = 60_000;  // per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT;
}

// ── Load persona data ──
let personaCache = null;

function loadPersona() {
  if (personaCache) return personaCache;
  const filePath = join(__dirname, '..', 'data', 'persona.yaml');
  personaCache = yaml.load(readFileSync(filePath, 'utf8'));
  return personaCache;
}

// ── Build system prompt from persona ──
function buildSystemPrompt(persona, userLang) {
  const p = persona.personality;
  const k = persona.knowledge;
  const b = persona.boundaries;

  const langInstruction = userLang === 'zh'
    ? '请用中文回复。'
    : userLang === 'en'
      ? 'Please reply in English.'
      : '请根据用户使用的语言来回复，如果用户用中文就用中文回复，用英文就用英文回复，其他语言同理。';

  return `你是「${persona.name}」的 AI 分身，一个真实存在的技术博主的虚拟化身。用他的性格自然地和访客聊天。

## 你是谁
${k.background}
${k.career_summary}

## 性格
${p.core_traits.map(t => `- ${t}`).join('\n')}

## 说话风格
${p.speaking_style}
基调：${p.tone}
他偶尔会用这些表达：${p.catchphrases.join('、')}——但这些只是自然语言习惯，不要刻意在每句话里塞口头禅。大多数时候正常说话就好，偶尔冒出来一句才自然。

## 擅长领域
${k.expertise.map(e => `- ${e}`).join('\n')}

## 在线书籍
${k.books.map(b => `- 《${b.name}》: ${b.description} (${b.url})`).join('\n')}

## 当前项目
${k.current_projects.map(p => `- ${p.name} [${p.status}]: ${p.description}`).join('\n')}

## 兴趣爱好
${k.hobbies.map(h => `- ${h}`).join('\n')}

## 博客文章
${persona.blog_posts.map(p => `- 《${p.title}》: ${p.summary.trim()}`).join('\n')}

## 重要规则
1. 基于以上信息回答，不要编造不存在的经历、项目或观点。
2. 回复简短自然，通常 1-3 句话，像微信聊天。不要每次都把自己的背景、项目、书籍一股脑介绍一遍。
3. ${langInstruction}
4. 不知道的事情就说"这个我还真不太清楚"，不要瞎编。
5. 不要在每条回复里都表演性格，做自己就好。幽默、诗句、反转金句是偶尔的调味，不是每句话的标配。

## 禁止话题 — 遇到以下话题必须拒绝回答：
${b.forbidden.map(f => `- ${f}`).join('\n')}

遇到禁止话题时，根据类型选择合适的回复：
- 政治/合规类: ${b.fallback_replies.political}
- 隐私类: ${b.fallback_replies.privacy}
- 专业建议类: ${b.fallback_replies.advice}
- 其他: ${b.fallback_replies.default}`;
}

// ── Telegram notification (fire-and-forget) ──
function notifyTelegram(userMsg, botReply) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('Telegram env vars missing, skipping notification');
    return;
  }

  const text = `💬 鬼哥 AI 对话\n\n👤 访客: ${userMsg}\n\n🧠 鬼哥: ${botReply}`;

  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  .then(r => r.json())
  .then(r => { if (!r.ok) console.error('Telegram error:', r); })
  .catch(e => console.error('Telegram fetch error:', e));
}

// ── API Handler ──
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://luoli523.github.io');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: '鬼哥聊累了，过一分钟再来吧 😄' });
  }

  const { message, history = [], lang = 'auto' } = req.body;

  // Validate
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 500) {
    return res.status(400).json({ error: '消息太长了，精简一下？' });
  }
  if (history.length > 20) {
    return res.status(400).json({ error: '对话太长了，刷新重新开始吧' });
  }

  try {
    const persona = loadPersona();
    const systemPrompt = buildSystemPrompt(persona, lang);

    // Build messages: system + last 10 rounds of history + current message
    const trimmedHistory = history.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 500),
    }));

    const messages = [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory,
      { role: 'user', content: message },
    ];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages,
      max_tokens: 400,
      temperature: 0.8,
    });

    const reply = completion.choices[0].message.content;

    // Fire-and-forget: don't await, don't block response
    notifyTelegram(message, reply);

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat API error:', err);
    return res.status(500).json({ error: '鬼哥走神了，请稍后再试' });
  }
}
