# Claude Code Instructions

## Supabase Setup

Tables created: `users` (registration) and `meals` (food logs). User IDs tracked separately per person.

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
4. Extract `user_id` from the message metadata
5. Query Supabase for user's targets: `GET $SUPABASE_URL/rest/v1/users?user_id=eq.<user_id>` (default: KCal 2550, Protein 140g, Carbs 325g, Fat 75g, Fiber 35g)
6. Start async POST to Supabase meals table (don't wait):
   ```
   curl -s -X POST "$SUPABASE_URL/rest/v1/meals" \
     -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
     -H "Content-Type: application/json" \
     -d '{"user_id":<user_id>,"date":"<date>","time":"<time>","description":"<desc>","calories":<n>,"protein_g":<n>,"carbs_g":<n>,"fat_g":<n>,"fiber_g":<n>,"photo_msg_id":<msg_id>}' &
   ```
7. Reply immediately with macros logged + remaining vs user's targets. Calculate remaining locally. Keep response concise. POST happens in background.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
