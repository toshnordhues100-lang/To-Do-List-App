# Cadence

A voice-first to-do app for your phone. Tap the microphone, say what you need to do, and it lands in your list with the right date, time, priority and tags. It has a checklist mode, a calendar mode, insights, and works offline once installed.

No accounts, no servers. Everything is stored on the device.

## Put it on your phone

Cadence is a Progressive Web App, so it installs from the browser without an app store.

1. Publish the repository with GitHub Pages (see below) or host the files on any HTTPS site.
2. Open the URL on your phone.
3. Install it:
   - **iPhone (Safari):** tap Share, then "Add to Home Screen".
   - **Android (Chrome):** open the browser menu, then "Add to Home screen" or "Install app".
4. Open Cadence from the home screen and allow microphone access the first time you tap the microphone.

Voice input needs HTTPS. Chrome on Android and Safari on iPhone have the best speech recognition. Firefox on mobile does not support voice input, but typing still works.

### Publish with GitHub Pages

1. In the repository, open Settings, then Pages.
2. Under "Build and deployment", set Source to "GitHub Actions".
3. Merge to `main`. The workflow in `.github/workflows/deploy.yml` runs the tests and deploys the site.
4. The app will be available at `https://<your-username>.github.io/<repository-name>/`.

## What you can say

Add tasks in plain language. Dates, times, priority, tags, repeats and durations are picked out automatically.

| Say | Result |
| --- | --- |
| "Call the dentist tomorrow at 3" | Task due tomorrow at 3:00 PM |
| "Pay rent on the first of every month" | Monthly task, due on the 1st |
| "Team meeting every Monday at 10, tag work" | Weekly task tagged `work` |
| "Urgent, send the invoice by Friday" | High priority, due Friday |
| "Deep work block at 2 pm for 2 hours" | Timed task with a 2 hour duration |
| "In 20 minutes check the oven" | Task due today at the right time |
| "Buy milk and then call the bank and also book a haircut on Saturday" | Three separate tasks |
| "Call the landlord, note ask about the deposit" | Task with a note attached |

Commands:

| Say | Result |
| --- | --- |
| "Complete buy milk", "Check off the dentist", "Buy milk is done" | Marks the closest matching task complete |
| "Delete the gym task" | Removes it |
| "Move gym to Friday", "Postpone dentist until next week at 2 pm", "Push report by 2 days" | Reschedules |
| "Make dentist high priority" | Changes priority |
| "Rename gym to morning run" | Renames |
| "What's on today", "What do I have tomorrow", "What is overdue", "Read my tasks for this week" | Reads your schedule aloud |
| "Show calendar", "Show list", "Show insights", "Show settings" | Switches view |
| "Search groceries" | Filters the list |
| "Undo" | Reverts the last change |
| "Clear completed" | Removes finished tasks |
| "Switch to dark mode" | Changes theme |
| "Stop" | Ends hands-free listening |

## Features

- **Voice capture** with live transcript, spoken confirmations, and an optional hands-free mode that keeps listening until you say "stop".
- **Typing** works everywhere voice does, with the same natural-language parsing.
- **List mode** grouped by Overdue, Today, Tomorrow, Next 7 days, Later and No date, with filter chips for priority and tags.
- **Calendar mode** with a month grid, per-day markers, a day agenda with planned time, and swipe between months. While a day is selected, anything you add without a date goes onto that day.
- **Insights**: open, due today, overdue, completed this week, day streak, 30-day completion rate, a 14-day completion chart, tags breakdown and your most productive weekday.
- **Repeating tasks**: daily, weekdays, every other day, weekly, every two weeks, monthly, yearly. Completing one schedules the next.
- **Reminders** for timed tasks through system notifications, with a configurable lead time.
- **Daily briefing** that reads today's tasks aloud the first time you tap the microphone each day.
- **Review before saving** mode if you prefer to confirm what was heard.
- **Undo and redo** for every change.
- **Search**, task notes, durations, priorities, tags.
- **Light, dark and system themes.**
- **Backup and restore** as a JSON file.
- **Offline support** and a home-screen shortcut that opens straight into listening.
- Keyboard shortcuts on desktop: Space to listen, N to type, / to search, 1 to 4 to switch views, Z to undo.

## Run locally

```bash
npm test          # parser tests
npm start         # serves the app at http://localhost:8080
```

Any static file server works. The app uses ES modules, so it must be served over HTTP rather than opened as a file.

## Project layout

```
index.html               App shell
css/styles.css           Styles, light and dark themes
js/app.js                UI, views, voice flow, reminders
js/parser.js             Natural-language parsing and command recognition
js/dates.js              Date helpers
js/store.js              localStorage persistence, recurrence, backup
js/voice.js              SpeechRecognition and SpeechSynthesis wrapper
sw.js                    Service worker for offline use
manifest.webmanifest     PWA manifest
icons/                   App icons (regenerate with tools/make-icons.py)
tests/parser.test.js     Parser tests
```

## Privacy

Speech recognition is provided by the phone's browser. On most devices audio is processed by the browser vendor's speech service. Task data never leaves the device unless you export it.
