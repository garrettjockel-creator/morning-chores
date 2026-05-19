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
  - Chat endpoint → Anthropic Claude (`claude-3-haiku-20240307`)
  - `/tts` endpoint → OpenAI text-to-speech (`tts-1`, voice `nova`)
  - Worker URL: `https://morning-chores-helper.gjockel.workers.dev`
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
  (outdoor, creative, learning, helping others, faith).
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
- The Cloudflare Worker is deployed separately from `worker.js` via the
  Cloudflare dashboard, with the two API-key secrets set in Worker settings.
- Required Firebase Console setup: Google sign-in provider enabled, the
  GitHub Pages domain added to Authorized domains, and the Firestore rules
  above published.
```
