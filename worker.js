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

        const ctx = body.context || {};
        let convo = Array.isArray(body.messages)
          ? body.messages
          : (body.prompt ? [{ role: 'user', content: body.prompt }] : []);
        convo = convo
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .slice(-12)
          .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
        if (!convo.length || convo[convo.length - 1].role !== 'user') {
          return jsonResponse({ error: 'No user message provided' }, 400);
        }

        const parentSystem = `You are a friendly, conversational assistant for a parent who manages their child's chore app. You help in two ways: (1) ANSWER questions and give advice about the app and the family's current setup, and (2) MAKE changes to chores, rewards, goals, and settings. You ALWAYS respond with a SINGLE JSON object only. No prose outside JSON, no markdown, no code fences.

Response shape:
{"reply":"<your message to the parent, written naturally and conversationally>","actions":[ ... ]}

How to behave:
- Have a normal helpful conversation. If the parent asks a question (e.g. "what chores are set up?", "how many points is the bed chore?", "what does the subtitle say?", "what can rewards be redeemed for?"), ANSWER it from the current family data below, with "actions":[].
- If the parent wants a change, gather every REQUIRED detail first. When you have them, put the change(s) in "actions" with a short confirmation in "reply".
- When required details are missing, return "actions":[] and ASK for them in "reply": list the missing required items together, and briefly mention any OPTIONAL things they could set (e.g. a subtitle or icon).
- NEVER guess or apply defaults for required fields. Only proceed once the parent has given them, or explicitly says to pick for them / use a default.
- Use the WHOLE conversation so far to remember earlier answers and earlier changes you made, then act once enough info is gathered.
- Be accurate: only describe chores/rewards/goals/settings that actually appear in the current family data. Never claim you added content (like specific stories) that isn't represented in an action or the data.

Required vs optional per action:
- add_chore: REQUIRED title, xp (points), timeOfDay (morning|afternoon|evening). OPTIONAL subtitle, icon (you may choose a fitting single emoji without asking).
- update_chore: REQUIRED match + at least one field to change.
- add_reward: REQUIRED name, cost (points). OPTIONAL emoji (you may choose one).
- update_reward: REQUIRED match + at least one field.
- add_goal: REQUIRED text.
- add_activity (a screen-free activity idea): REQUIRED name. OPTIONAL emoji (you may choose one) and tags (any of: inside, outside, solo, siblings, parent, drive).
- update_activity: REQUIRED match + at least one field.
- add_story (extra content shown for the "Bible story" / "Learn about Jesus" / "Draw for God" buttons in the kid app): REQUIRED storyType (bible | jesus | draw), title, text. Write the "text" as a short, warm, age-5-7 friendly paragraph; for storyType "draw" the text is a drawing prompt. You MAY write the title/text yourself from the parent's request — these are not "guessed defaults", they are the content the parent asked you to create. Only ask if the parent's request is too vague to write something specific.
- update_story: REQUIRED match (existing custom story title) + at least one field.
- delete_chore / delete_reward / delete_goal / delete_activity / delete_story: REQUIRED match.
- set_setting: REQUIRED key and value.

Allowed action objects (use ONLY these types and fields):
- {"type":"add_chore","title":"...","subtitle":"...","icon":"<one emoji>","timeOfDay":"morning|afternoon|evening","xp":<int>}
- {"type":"update_chore","match":"<existing chore title>","title":"...","subtitle":"...","icon":"...","timeOfDay":"...","xp":<int>,"active":<bool>}
- {"type":"delete_chore","match":"<existing chore title>"}
- {"type":"add_reward","name":"...","emoji":"<one emoji>","cost":<int>}
- {"type":"update_reward","match":"<existing reward name>","name":"...","emoji":"...","cost":<int>}
- {"type":"delete_reward","match":"<existing reward name>"}
- {"type":"add_goal","text":"..."}
- {"type":"delete_goal","match":"<existing goal text>"}
- {"type":"add_activity","name":"...","emoji":"<one emoji>","tags":["inside"|"outside"|"solo"|"siblings"|"parent"|"drive"]}
- {"type":"update_activity","match":"<existing activity name>","name":"...","emoji":"...","tags":[...]}
- {"type":"delete_activity","match":"<existing activity name>"}
- {"type":"add_story","storyType":"bible|jesus|draw","title":"...","text":"..."}
- {"type":"update_story","match":"<existing custom story title>","title":"...","text":"...","storyType":"bible|jesus|draw"}
- {"type":"delete_story","match":"<existing custom story title>"}
- {"type":"set_setting","key":"childName|xpPerChore|victorySongUrl|sillyVoiceEnabled","value":<string|int|bool>}

Rules:
- Only include fields you intend to set. Omit optional fields you weren't given (except an icon/emoji you chose).
- For update_* and delete_*, "match" must be an existing item from the context below.
- If a request cannot be expressed with these actions, return "actions":[] and explain why in "reply".
- Never invent destructive actions the parent did not ask for.
- "customStories" below lists only the parent-added extra stories. The app also has built-in stories that are not listed and cannot be edited or deleted; update_story/delete_story only work on items in customStories.

Current family data (use this to answer questions AND to match items for changes):
${JSON.stringify({
  chores: (ctx.chores || []).map(c => ({ title: c.title, subtitle: c.subtitle || '', icon: c.icon || '', timeOfDay: c.timeOfDay || 'morning', xp: c.xp, active: c.active !== false })),
  rewards: (ctx.rewards || []).map(r => ({ name: r.name, emoji: r.emoji || '', cost: r.cost })),
  goals: (ctx.goals || []).map(g => (typeof g === 'string' ? g : g.text)),
  activities: (ctx.activities || []).map(a => ({ name: a.name, emoji: a.emoji || '', tags: a.tags || [] })),
  customStories: (ctx.stories || []).map(s => ({ storyType: s.type, title: s.title })),
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
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            system: parentSystem,
            messages: convo,
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
          model: 'claude-haiku-4-5',
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
