# Cadence

A voice-first to-do app for your phone. Tap the microphone, say what you need to do, and it lands in your list with the right date, time and priority. Claude understands what you said. Reminders ring your phone even when the app is closed. There is a checklist view, a calendar view and insights.

Nobody who uses the app needs an account of any kind. Each phone keeps its own list.

## How it is built

| Part | What it does | Where it runs |
| --- | --- | --- |
| The app (`index.html`, `js/`, `css/`) | Everything you see. Installable from the browser, works offline. | GitHub Pages |
| The server (`server/`) | Sends what you said to Claude and turns it into tasks. Sends push reminders at the right time. | A free Cloudflare Worker |

The server uses **Claude Haiku 4.5**, the least expensive model. One spoken command is about a tenth of a cent, so a thousand commands cost roughly one dollar. Each phone is capped at 400 commands a day.

Without the server the app still works: it falls back to built-in understanding and shows reminders while it is open.

## Set up once (about ten minutes)

You need three secrets in the GitHub repository. Go to **Settings, Secrets and variables, Actions, New repository secret** and add:

| Secret | Where to get it |
| --- | --- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com, API Keys, Create Key. Add a few dollars of credit. |
| `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com (free account). The account ID is on the right side of the Workers & Pages overview page. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard, My Profile, API Tokens, Create Token, use the **Edit Cloudflare Workers** template. |

Then push to `main` (or open the Actions tab and run "Test and deploy"). Any merge to `main` also re-runs it, which is the easiest way to redeploy after adding or changing secrets. The workflow:

1. runs the tests,
2. deploys the server to Cloudflare and stores your Anthropic key there as a secret,
3. writes the server address into the app and publishes the site.

The app is served at `https://<your-username>.github.io/<repository-name>/`. In the repository, **Settings, Pages** must have Source set to "Deploy from a branch" with branch `gh-pages`, folder `/ (root)`. The repository must be public for GitHub Pages on a free account.

## Put it on a phone

1. Open the app link in Safari (iPhone) or Chrome (Android).
2. iPhone: tap Share, then "Add to Home Screen". Android: browser menu, then "Add to Home screen" or "Install app".
3. Open Cadence from the home screen. Allow the microphone when asked.
4. Add your first task. Cadence asks to turn reminders on. Tap "Turn on reminders" and allow notifications.

Reminders on iPhone only work from the home-screen version (an Apple rule), which is why step 2 matters.

## What you can say

| Say | Result |
| --- | --- |
| "Remind me tomorrow at 8 pm to wash the dishes" | Task tomorrow at 8:00 PM with a reminder at 8:00 PM |
| "Add wash the car at 8pm tmr night and remind me at 8" | One task, "Wash the car", tomorrow at 8:00 PM |
| "Pay rent on the first of every month" | Monthly task |
| "Team meeting every Monday at 10, tag work" | Weekly task tagged `work` |
| "Urgent, send the invoice by Friday" | High priority, due Friday |
| "Buy milk and also book a haircut on Saturday" | Two tasks |
| "Complete buy milk", "Delete the dentist task" | Marks or removes the matching task |
| "Move gym to Friday", "Push report by 2 days" | Reschedules |
| "What's on today", "What do I have tomorrow" | Reads your schedule aloud |
| "Show calendar", "Show list", "Undo", "Clear completed" | App commands |

## Reminders

- Every task with a date gets a reminder unless you switch "Remind me" off for that task.
- A task with a time rings at that time (or a few minutes before, your choice).
- A task with only a date rings at your daily reminder time, 9:00 AM by default.
- Reminders arrive with the app closed and the phone locked. A phone that is powered off receives them when it turns back on.
- Any task can also be added to your calendar app with the "Add to calendar" button when editing it.

## Everything else

- Checklist grouped by Overdue, Today, Tomorrow, Next 7 days, Later, No date, with filters.
- Month calendar with a day agenda. With a day selected, anything you add without a date goes on that day.
- Insights: open, due today, overdue, done this week, streak, completion rate, 14-day chart, tags.
- Repeating tasks, notes, durations, priorities, tags, search.
- Spoken confirmations, hands-free mode, daily briefing.
- Undo and redo. Clearing and deleting always ask for confirmation.
- Light, dark and system themes. Backup and restore as a file.

## Run locally

```bash
npm test                 # app parser tests
npm start                # serves the app at http://localhost:8080
cd server && npm ci && npm test   # server tests
```

## Project layout

```
index.html               App shell
css/styles.css           Styles, light and dark themes
js/app.js                Views, voice flow, reminders, server calls
js/parser.js             Built-in natural-language parsing (fallback)
js/dates.js              Date helpers
js/store.js              Local persistence, recurrence, backup
js/voice.js              SpeechRecognition and SpeechSynthesis wrapper
js/config.js             Server address (filled in by the deploy workflow)
sw.js                    Service worker: offline shell and push notifications
server/src/index.js      Cloudflare Worker: routes and the reminder cron
server/src/parse.js      Claude prompt and response validation
server/src/push.js       Web Push encryption and VAPID
artifact/                An alternative build that runs inside claude.ai
.github/workflows        Test, deploy the server, publish the site
```

## Privacy

Speech recognition is provided by the phone's browser. What you say is sent to the Cadence server only to be understood by Claude and is not stored. For reminders, the server keeps each phone's push subscription and the titles and times of upcoming tasks, under a random device id. Nothing else leaves the phone.
