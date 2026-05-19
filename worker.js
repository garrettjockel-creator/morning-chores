// ============================================================
// Cloudflare Worker — API Proxy for Morning Chores App
// ============================================================
// SETUP:
// 1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
// 2. Paste this entire file into the editor
// 3. Go to Settings → Variables → add secrets:
//    ANTHROPIC_API_KEY = your Anthropic key
//    OPENAI_API_KEY = your OpenAI key
// 4. Deploy the worker
// 5. Copy the worker URL and paste it into Parent Dashboard → Settings → Worker URL
// ============================================================

const ALLOWED_ORIGIN = 'https://garrettjockel-creator.github.io';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const SYSTEM_PROMPT = `You are "Helper", a kind, encouraging friend talking to a young child (age 5-7) named {NAME}.

Your personality:
- Warm, patient, and enthusiastic
- Use simple words and short sentences (1-3 sentences max)
- Celebrate their achievements with genuine excitement
- Suggest fun activities instead of screen time

What you do:
- Help set small, achievable goals ("I want to learn to ride my bike!")
- Suggest activities from categories: outdoor, creative, learning, helping others, faith
- Celebrate their chore streaks and points
- Encourage kindness, prayer, Bible reading, and helping others
- Ask simple follow-up questions to keep conversation going

What you NEVER do:
- NEVER use asterisks, stage directions, or describe your tone (e.g. no "*in a warm tone*" or "*smiling*")
- NEVER use markdown formatting
- Just speak naturally and directly as plain text
- Discuss anything inappropriate for a young child
- Give medical, legal, or safety-critical advice
- Mention that you are an AI or language model
- Use complex vocabulary or long responses
- If asked about something inappropriate, say "That's a great question for Mom or Dad!"

Context about the child:
- Total points: {XP}
- Current streak: {STREAK} days
- They are working on their morning chores app`;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }

      const url = new URL(request.url);

      // ===== TTS ENDPOINT =====
      if (url.pathname === '/tts') {
        if (!env.OPENAI_API_KEY) {
          return jsonResponse({ error: 'OPENAI_API_KEY not set' }, 500);
        }

        let body;
        try { body = await request.json(); } catch (e) {
          return jsonResponse({ error: 'Invalid JSON' }, 400);
        }

        const text = (body.text || '').slice(0, 4096);
        if (!text) return jsonResponse({ error: 'No text provided' }, 400);

        const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: 'nova',
            response_format: 'mp3',
          }),
        });

        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          return jsonResponse({ error: 'TTS error', detail: err }, ttsRes.status);
        }

        return new Response(ttsRes.body, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            ...CORS_HEADERS,
          },
        });
      }

      // ===== PARENT CUSTOMIZATION ENDPOINT =====
      if (url.pathname === '/parent') {
        if (!env.ANTHROPIC_API_KEY) {
          return jsonResponse({ error: 'ANTHROPIC_API_KEY secret is not set in Worker settings' }, 500);
        }

        let body;
        try { body = await request.json(); } catch (e) {
          return jsonResponse({ error: 'Invalid JSON' }, 400);
        }

        const prompt = (body.prompt || '').slice(0, 2000);
        const ctx = body.context || {};
        if (!prompt) return jsonResponse({ error: 'No prompt provided' }, 400);

        const parentSystem = `You translate a parent's plain-English request into structured edits for a kids' chore app. You ONLY output JSON. No prose, no markdown, no code fences.

Output exactly this shape:
{"reply":"<one short friendly sentence describing what you did>","actions":[ ... ]}

Allowed action objects (use ONLY these types and fields):
- {"type":"add_chore","title":"...","subtitle":"...","icon":"<one emoji>","timeOfDay":"morning|afternoon|evening","xp":<int>}
- {"type":"update_chore","match":"<existing chore title>","title":"...","subtitle":"...","icon":"...","timeOfDay":"...","xp":<int>,"active":<bool>}
- {"type":"delete_chore","match":"<existing chore title>"}
- {"type":"add_reward","name":"...","emoji":"<one emoji>","cost":<int>}
- {"type":"update_reward","match":"<existing reward name>","name":"...","emoji":"...","cost":<int>}
- {"type":"delete_reward","match":"<existing reward name>"}
- {"type":"add_goal","text":"..."}
- {"type":"delete_goal","match":"<existing goal text>"}
- {"type":"set_setting","key":"childName|xpPerChore|victorySongUrl|sillyVoiceEnabled","value":<string|int|bool>}

Rules:
- Only include fields you intend to change. Omit unknown/optional fields.
- For update_* and delete_*, "match" must be an existing item from the context below.
- If the request is unclear or cannot be expressed with these actions, return an empty actions array and explain why in "reply".
- Never invent destructive actions the parent did not ask for.

Current family data (for matching):
${JSON.stringify({
  chores: (ctx.chores || []).map(c => ({ title: c.title, timeOfDay: c.timeOfDay, xp: c.xp, active: c.active })),
  rewards: (ctx.rewards || []).map(r => ({ name: r.name, cost: r.cost })),
  goals: (ctx.goals || []).map(g => g.text),
  settings: ctx.settings || {},
})}`;

        const pRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1024,
            system: parentSystem,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const pData = await pRes.json();
        if (!pRes.ok) {
          return jsonResponse({ error: 'API error', detail: pData }, pRes.status);
        }

        let raw = (pData.content?.[0]?.text || '').trim();
        raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          return jsonResponse({ reply: "Sorry, I couldn't understand that. Try rephrasing.", actions: [] }, 200);
        }
        if (!parsed || !Array.isArray(parsed.actions)) {
          parsed = { reply: parsed?.reply || 'No changes made.', actions: [] };
        }
        return jsonResponse(parsed, 200);
      }

      // ===== CHAT ENDPOINT (default) =====
      if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY secret is not set in Worker settings' }, 500);
      }

      let body;
      try { body = await request.json(); } catch (e) {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }

      const messages = body.messages || [];
      const context = body.context || {};

      const systemPrompt = SYSTEM_PROMPT
        .replace('{NAME}', context.name || 'Buddy')
        .replace('{XP}', context.xp || 0)
        .replace('{STREAK}', context.streak || 0);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 300,
          system: systemPrompt,
          messages: messages.slice(-10).map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return jsonResponse({ error: 'API error', detail: data, status: response.status }, response.status);
      }

      const reply = data.content?.[0]?.text || '';
      return jsonResponse({ reply }, 200);

    } catch (e) {
      return jsonResponse({ error: 'Worker crash', message: e.message, stack: e.stack }, 500);
    }
  }
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    }
  });
}
