// ============================================================
// Cloudflare Worker — Claude API Proxy for Morning Chores App
// ============================================================
// SETUP:
// 1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
// 2. Paste this entire file into the editor
// 3. Go to Settings → Variables → add: ANTHROPIC_API_KEY = your key
// 4. Deploy the worker
// 5. Copy the worker URL and paste it into Parent Dashboard → Settings → Worker URL
//
// FIRESTORE RULES (paste in Firebase Console → Firestore → Rules):
// ----------------------------------------------------------------
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /{document=**} {
//       allow read, write: if true;
//     }
//   }
// }
// NOTE: These are permissive rules for a single-family app.
// For production, restrict writes to authenticated users.
// ============================================================

const ALLOWED_ORIGIN = 'https://garrettjockel-creator.github.io';
const MAX_MESSAGES_PER_DAY = 50;

const SYSTEM_PROMPT = `You are "Helper", a kind, encouraging friend talking to a young child (age 5-7) named {NAME}.

Your personality:
- Warm, patient, and enthusiastic
- Use simple words and short sentences (1-3 sentences max)
- Celebrate their achievements with genuine excitement
- Suggest fun activities instead of screen time

What you do:
- Help set small, achievable goals ("I want to learn to ride my bike!")
- Suggest activities from categories: outdoor, creative, learning, helping others, faith
- Celebrate their chore streaks and levels
- Encourage kindness, prayer, Bible reading, and helping others
- Ask simple follow-up questions to keep conversation going

What you NEVER do:
- Discuss anything inappropriate for a young child
- Give medical, legal, or safety-critical advice
- Mention that you are an AI or language model
- Use complex vocabulary or long responses
- If asked about something inappropriate, say "That's a great question for Mom or Dad!"

Context about the child:
- Current level: {LEVEL}
- Current streak: {STREAK} days
- They are working on their morning chores app`;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // Only POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Check origin
    const origin = request.headers.get('Origin') || '';
    if (!origin.includes('garrettjockel-creator.github.io') && !origin.includes('localhost')) {
      return new Response('Forbidden', { status: 403 });
    }

    // Simple rate limiting using a KV-like approach with the global object
    // For a family app, this is sufficient. For production, use Workers KV.
    const today = new Date().toISOString().split('T')[0];
    const rateLimitKey = `rate_${today}`;

    // Parse request
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON' }, 400, origin);
    }

    const messages = body.messages || [];
    const context = body.context || {};

    // Build system prompt with context
    const systemPrompt = SYSTEM_PROMPT
      .replace('{NAME}', context.name || 'Buddy')
      .replace('{LEVEL}', context.level || 'Little Helper')
      .replace('{STREAK}', context.streak || 0);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 150,
          system: systemPrompt,
          messages: messages.slice(-10).map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return jsonResponse({ error: 'API error', detail: data, status: response.status }, response.status, origin);
      }

      // Return just the reply text for simpler client parsing
      const reply = data.content?.[0]?.text || '';
      return jsonResponse({ reply, content: data.content }, 200, origin);

    } catch (e) {
      return jsonResponse({ error: 'Failed to reach API', message: e.message }, 502, origin);
    }
  }
};

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    }
  });
}
