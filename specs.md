# Morning Chores — Product Specification

## Overview

Morning Chores is an invite-only web app that turns a young child's daily
chores into a game. Kids check off chores each day to earn points (XP), build
streaks, and redeem rewards. The app includes an AI "Helper" the child can chat
with, screen-free activity ideas, and a daily reflection/journal. Parents manage
chores, goals, and rewards from a dashboard; an admin can view all families.

Target user: children roughly age 5–7, with a parent administering the account.

## Architecture & Tech Stack

- **Frontend:** Static HTML pages with inline CSS and vanilla JavaScript. No
  build step, framework, or bundler. Each page is a self-contained `.html` file.
- **Database:** Google Firebase Cloud Firestore (project `morning-chores-ee2f3`),
  accessed directly from the browser via the Firebase compat SDK (loaded from
  gstatic CDN, v10.7.0).
- **Authentication:** Firebase Authentication with the Google provider
  (popup flow). Used on the parent, kid-login, and admin pages.
- **AI proxy:** A Cloudflare Worker (`worker.js`) proxies AI requests so API
  keys never reach the browser:
  - Default chat endpoint → Anthropic Claude (`claude-haiku-4-5`) — kid Helper
  - `/parent` endpoint → Anthropic Claude — parent customization
    (returns strict JSON actions, not prose)
  - `/tts` endpoint → OpenAI text-to-speech (`tts-1`, voice `nova`)
  - Worker URL: `https://morning-chores-helper.gjockel.workers.dev`
  - Deployed manually via the Cloudflare dashboard. The Worker is
    intentionally **generic and stable** — see "Thin-proxy
    architecture" below — so it rarely (ideally never) needs
    redeploying once set up.
- **Hosting:** GitHub Pages, repo `garrettjockel-creator/morning-chores`,
  served from the `main` branch at
  `https://garrettjockel-creator.github.io/morning-chores/`.

## Pages

| Page | Purpose |
|---|---|
| `index.html` | Landing / marketing page. Invite-only passcode gate (`FAMILYFIRST`) leading to signup. Also offers "Open your app" (uses stored familyId) and a kid login link. |
| `signup.html` | Creates a new family: parent name, parent email, family last name, child name, parent PIN. Seeds default chores and rewards. |
| `login.html` | Kid entry point. Parent signs in with Google; the family is resolved by email and the child is sent into the kid app. |
| `app.html` | The kid app — chores, rewards, AI chat, activities, reflections, celebrations. |
| `parent.html` | Parent dashboard — stats, 30-day chart, chore manager, goals, rewards editor. Google sign-in + a 4-digit parent PIN. |
| `admin.html` | Admin portal — overview of all families. Google sign-in restricted to an email allowlist. |
| `migrate.html` | One-off data migration utility for existing family documents. |

## Authentication

- **Google sign-in (popup)** is used on `parent.html`, `login.html`, and
  `admin.html`. Popup flow is required because `signInWithRedirect` does not
  persist on GitHub Pages (Chrome storage partitioning between the
  `firebaseapp.com` auth handler and the `github.io` app origin).
- **Family linking:** after sign-in, the family is resolved by matching the
  signed-in Google email to the `parentEmail` stored on the family document
  (with a lowercase fallback). No migration needed — signup already captures
  the email.
- **Admin access:** restricted to an `ADMIN_EMAILS` allowlist in `admin.html`
  (currently `garrett.jockel@gmail.com`).
- **Parent PIN:** `parent.html` keeps a 4-digit PIN (SHA-256 hashed, stored as
  `pinHash`) as an on-device lock after Google sign-in.
- **Kids do not authenticate.** The kid app (`app.html`) is reached via a
  `?f=<familyId>` link launched after a parent has signed in; it reads a single
  family document directly.

## Data Model (Firestore)

```
families/{familyId}
  parentName, parentEmail, lastName, lastNameLower, childName
  pinHash                 (SHA-256 of the 4-digit parent PIN)
  workerUrl               (Cloudflare Worker base URL)
  chatEnabled             (bool)
  xpPerChore              (default 10)
  kidOnboardingComplete   (bool)
  kidTheme, victorySongUrl (optional)
  createdAt               (ISO string)

  profile/main
    xp, streak, lastAllDoneDate
    badges[], bibleReadCount
    totalChoresCompleted, goalsSet, goalsCompleted

  chores/{choreId}
    title, subtitle, icon, xp, order, active
    timeOfDay   (morning | afternoon | evening; default morning)
    specialTrack (e.g. "bible"), kidLikes (optional)

  completions/{YYYY-MM-DD}
    done[]        (chore IDs completed that day)
    xpAwarded[]   (chore IDs that have already granted XP)
    allDoneBonus  (bool — whether the +25 all-done bonus was applied)

  rewards/{rewardId}
    emoji, name, cost

  goals/{goalId}
    (created/ordered by createdAt)

  reflections/{YYYY-MM-DD}
    (daily kid reflection / journal entry)
```

## Features

### Kid app (`app.html`)
Four tabs: **Chores**, **Rewards**, **Chat**, **Activities**.

- **Daily chores:** tap to check off. Chores can be grouped by time of day
  (morning / afternoon / evening). The checkbox updates immediately
  (optimistic UI); the Firestore write happens in the background.
- **XP:** each chore awards its `xp` value (default 10) once per day. XP is
  never double-awarded (tracked via `xpAwarded`).
- **All-done bonus:** completing every active chore in a day grants +25 XP and
  triggers confetti + a victory celebration.
- **Streaks:** finishing all chores on consecutive days increases the streak.
  Milestones at **3, 7, 14, 30** days show special celebrations, and each
  milestone grants a bonus (`streak × 5` XP). Streak milestone bonuses:
  3 = "Hat Trick", 7 = "One Week Warrior", 14 = "Two Week Legend",
  30 = "Monthly Master".
- **Special tracks:** chores marked `specialTrack: 'bible'` also increment
  `bibleReadCount`.
- **Rewards:** kids redeem accumulated points for parent-defined rewards
  (emoji, name, point cost).
- **AI Helper chat:** a kind, child-appropriate assistant ("Helper") powered by
  Claude via the Worker. Replies are short, plain-text, encourage screen-free
  activities, prayer/Bible reading, and kindness. Text-to-speech reads
  responses aloud (OpenAI TTS through the Worker). Gated by `chatEnabled`.
- **Activities:** screen-free activity ideas across categories
  (outdoor, creative, learning, helping others, faith). Tapping any
  idea fetches one short, concrete, kid-safe suggestion from the
  Helper endpoint (e.g. tapping "Science experiment" returns a
  specific experiment to try), read aloud, with an "Another idea!"
  button for a fresh one. The Bible/Jesus/Draw cards instead show
  curated stories from the built-in + custom `stories` pool.
- **Reflections / journal:** a daily reflection entry per child.
- **Victory song:** optional per-family `victorySongUrl` played on big wins.
- **Themes:** selectable kid theme; first-run kid onboarding flow.
- Sounds and sticker pop animations accompany chore completion.

### Parent dashboard (`parent.html`)
- Summary stats: streak, total points, 7-day completion %.
- 30-day completion chart.
- Chore manager: add / edit / enable / disable chores.
- Goals: add and track goals.
- Rewards editor: manage the reward catalog.
- Activities manager and family settings (child name, XP per chore,
  victory song URL, silly voice, parent PIN).
- **Customize with AI:** a plain-English chat that turns parent requests
  into changes without using the manual forms (see below).

### AI Helper (parent dashboard)
A persistent floating chat widget (✨ launcher, bottom-right, only shown
once the parent is signed in). It both **answers questions** about the
current setup and **makes changes** conversationally — e.g. "add an
evening chore to feed the dog worth 15 points", "what chores are set
up?", "add a Bible story about Zacchaeus", "switch to the Steelers
theme and give Sam 50 bonus points".

- It is conversational: if a request is missing required details it
  asks follow-up questions and remembers the thread across turns.
- The browser sends a client-built system prompt (the full action
  schema + a JSON snapshot of the family's data) plus the conversation
  to the Worker's `/parent` endpoint; Claude returns a **strict JSON
  action list** (no free-form writes).
- The client **validates every action against a whitelist** before
  writing to Firestore — arbitrary AI output is never executed.
- Supported actions: chores, rewards, goals (add/edit/complete/delete),
  activity ideas, custom Bible/Jesus/Draw stories, points & streak
  adjustments, kid theme, and settings (`childName`, `xpPerChore`,
  `victorySongUrl`, `sillyVoiceEnabled`, `chatEnabled`, `kidTheme`).
- **Add/edit** actions apply immediately. **Deletes, chore-disables,
  and points/streak changes** require an explicit Apply/Cancel
  confirmation.
- Unmatched (`match` not found) or unknown actions are reported, not
  guessed at. Gated behind the parent's Google sign-in + parent PIN.
- Custom stories are written to a `stories` subcollection and merged
  with the built-in Bible/Jesus/Draw lists in the kid app.

### Thin-proxy architecture (maintainability)
The `/parent` Worker endpoint is a **generic pass-through**: it accepts
`{ system, messages }`, forwards them to Claude, and returns the parsed
JSON. It contains **no action schema or business logic**.

The single source of truth for the AI's capabilities is
`buildAiSystem()` in `parent.html`, which assembles the system prompt
(action schema + live family-data snapshot). The matching write logic
is `applyAiActions()` in the same file, with the confirm-required set
in `AI_CONFIRM_TYPES`.

Consequence for maintenance: **adding or changing an AI capability is a
`parent.html` edit + a normal `git push` only — the Worker never needs
redeploying.** To add a capability: (1) add the action to the schema
text in `buildAiSystem()`, (2) add its handler in `applyAiActions()`,
(3) if destructive, add its type to `AI_CONFIRM_TYPES`, (4) push.

### Admin portal (`admin.html`)
- Lists every family with child name, parent name/email.
- Per-family: streak, total points, today's completion, chore status list,
  theme, created date, onboarding status.
- Deep links to each family's parent dashboard and kid app.

## Security

Firestore security rules (configured in the Firebase Console, not in the repo):

```
match /families/{familyId} {
  allow get:   if true;                 // kid app reads its own family by ?f=<id>
  allow list:  if request.auth != null; // only signed-in users can query/enumerate
  allow write: if true;
  match /{document=**} { allow read, write: if true; }
}
```

- Single-document reads stay open so the kid app works via a direct link
  without the child needing an account.
- Collection listing/querying requires an authenticated (Google) user, which
  prevents anonymous enumeration of all families.
- AI provider API keys live only in Cloudflare Worker secrets
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); the Worker enforces a CORS
  allow-origin of `https://garrettjockel-creator.github.io`.

## Deployment

- Source of truth: `main` branch on GitHub. GitHub Pages auto-deploys `main`
  (~1 minute) to `https://garrettjockel-creator.github.io/morning-chores/`.
- The Cloudflare Worker is deployed from `worker.js` via the Cloudflare
  dashboard with the two API-key secrets set in Worker settings. Because
  it is a thin proxy (see "Thin-proxy architecture"), it only needs
  redeploying for changes to the Worker itself (e.g. CORS origin, model
  id) — **not** for AI capability changes, which ship via the page.
- Required Firebase Console setup: Google sign-in provider enabled, the
  GitHub Pages domain added to Authorized domains, and the Firestore rules
  above published.
