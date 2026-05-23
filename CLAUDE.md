# Claude Code Instructions

## Google Sheets Setup

The shared tracking sheet needs these tabs:
- **Register**: Name, Email, Telegram User ID, KCal Target, Protein Target, Carbs Target, Fat Target, Fiber Target
- **Meals**: User ID, Date, Time, Description, Calories, Protein, Carbs, Fat, Fiber
- **Dashboard** (optional): Filtered views per person showing their meals + running totals

The Apps Script webhook receives `user_id` in the POST and appends it to the Meals sheet for tracking.

## Telegram Voice Messages

When a Telegram message arrives with `attachment_kind="voice"` and `message_id`:
1. Check cache first: `cat /tmp/tg_transcripts/<message_id>.txt 2>/dev/null`
2. If cached: skip transcription, go straight to replying
3. If not cached yet: run in parallel — `react` 👀 + `bash /root/.claude/voice_transcribe.sh <attachment_file_id>`
4. Reply with transcript prefixed `🎤 `, then respond to the content

The background poller `/root/.claude/tg_voice_preprocess.sh` pre-transcribes voice messages before Claude wakes up, so the cache should usually be warm.

## Multi-User Group Food Logging

This system supports a shared Telegram group where multiple friends log their meals. Each person is tracked separately by their Telegram `user_id`.

**Setup:**
1. Create a Telegram group (e.g., "Food Logging")
2. Add the bot to the group
3. Invite friends to join
4. Maintain a "Registration" sheet with columns: Name, Email, Telegram User ID
5. Each friend adds themselves once (name, email, their user_id from `/start` or `/whoami` command)
6. Maintain a shared "Meals" sheet where all logs are appended (user_id is the key identifier)
7. Each person has their own dashboard that filters meals by their user_id

When friends send food photos to the group, `user_id` is extracted from the message metadata and used to look up their name/settings in the Registration sheet.

## Telegram Food Photos

When a Telegram message arrives with an `image_path` attribute (photo from user):
1. Read the image file at the given path
2. Analyze the food: estimate description, calories, protein_g, carbs_g, fat_g, fiber_g
3. Get today's date (YYYY-MM-DD) and current time (HH:MM:SS)
4. Extract `user_id` from the message metadata. Include it in the POST.
5. Start POST to SHEETS_WEBHOOK asynchronously (in background, don't wait):
   ```
   curl -s -X POST "$SHEETS_WEBHOOK" \
     -H "Content-Type: application/json" \
     -d '{"date":"<date>","time":"<time>","user_id":<user_id>,"description":"<desc>","calories":<n>,"protein_g":<n>,"carbs_g":<n>,"fat_g":<n>,"fiber_g":<n>,"photo_msg_id":<msg_id>}' &
   ```
   SHEETS_WEBHOOK = https://script.google.com/macros/s/AKfycbzrBV5GF9tNOezjhQavM52lYln8tGqOGuakOE_5vlIUMjkKHDUl4a2Aby2kjAGQtJMyYA/exec
6. Look up user's targets from the Registration sheet (default fallback: KCal 2550, Protein 140g, Carbs 325g, Fat 75g, Fiber 35g)
7. Reply immediately with macros logged + remaining vs user's targets. Calculate remaining locally. Keep response concise. POST happens in background.
