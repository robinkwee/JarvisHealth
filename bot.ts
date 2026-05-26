import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";

const BOT_TOKEN = process.env.BOT_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SB_HEADERS = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` };

async function getRegisteredUser(userId: number) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${userId}&limit=1`, { headers: SB_HEADERS });
  const rows = await res.json() as any[];
  return rows[0] ?? null;
}

const userCache = new Map<number, { user: any; ts: number }>();
const USER_CACHE_TTL = 5 * 60 * 1000;

async function getCachedUser(userId: number) {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) return cached.user;
  const user = await getRegisteredUser(userId);
  if (user) userCache.set(userId, { user, ts: Date.now() });
  return user;
}

// --- Database setup ---
const db = new Database(import.meta.dir + "/log.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS poll_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logged_photos (
    photo_msg_id INTEGER PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS food_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    description TEXT NOT NULL,
    calories REAL NOT NULL,
    protein_g REAL NOT NULL,
    carbs_g REAL NOT NULL,
    fat_g REAL NOT NULL,
    fiber_g REAL NOT NULL,
    photo_msg_id INTEGER,
    chat_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO logged_photos (photo_msg_id)
    SELECT photo_msg_id FROM food_log WHERE photo_msg_id IS NOT NULL;
`);

function getOffset(): number {
  const row = db.prepare(`SELECT value FROM poll_state WHERE key = 'offset'`).get() as { value: string } | null;
  return row ? parseInt(row.value) : 0;
}
function saveOffset(val: number) {
  db.prepare(`INSERT OR REPLACE INTO poll_state (key, value) VALUES ('offset', ?)`).run(String(val));
}
function alreadyLogged(photoMsgId: number): boolean {
  return !!db.prepare(`SELECT photo_msg_id FROM logged_photos WHERE photo_msg_id = ?`).get(photoMsgId);
}
function markPhotoLogged(photoMsgId: number) {
  db.prepare(`INSERT OR IGNORE INTO logged_photos (photo_msg_id) VALUES (?)`).run(photoMsgId);
}

// Pending confirmations: msg_id -> macro data
const pending = new Map<number, MacroEstimate & { photoMsgId: number; userId: number; source: "photo" | "text" }>();

// Pending edits: telegram user_id -> msgId of the pending estimate being re-described
const pendingEdit = new Map<number, number>();

// Pending registrations: telegram user_id -> registration step
const pendingReg = new Map<number, { step: "name" | "email"; name?: string }>();

// Track recently processed logs to prevent race conditions from duplicate callback queries
const recentlyLogged = new Set<number>();
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
setInterval(() => recentlyLogged.clear(), DEDUP_TTL);

async function registerUser(userId: number, name: string, email: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...SB_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ user_id: userId, name, email }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
}

async function getMealCount(userId: number): Promise<number> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meals?user_id=eq.${userId}&select=id`,
    { headers: { ...SB_HEADERS, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" } }
  );
  const contentRange = res.headers.get("Content-Range") ?? "";
  const total = parseInt(contentRange.split("/")[1] ?? "0", 10);
  return isNaN(total) ? 0 : total;
}

async function getLatestMeal(userId: number) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meals?user_id=eq.${userId}&select=id,description,calories,protein_g,carbs_g,fat_g,fiber_g,date,time,photo_msg_id&order=date.desc,time.desc&limit=1`,
    { headers: SB_HEADERS }
  );
  const rows = await res.json() as any[];
  return rows[0] ?? null;
}

async function getMealById(mealId: number) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meals?id=eq.${mealId}&select=id,description,photo_msg_id,user_id`,
    { headers: SB_HEADERS }
  );
  const rows = await res.json() as any[];
  return rows[0] ?? null;
}

async function deleteMeal(mealId: number): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/meals?id=eq.${mealId}`, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  return res.ok;
}

function unmarkPhotoLogged(photoMsgId: number) {
  db.prepare(`DELETE FROM logged_photos WHERE photo_msg_id = ?`).run(photoMsgId);
}

interface MacroEstimate {
  description: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  confidence: string;
  notes?: string;
}

// --- Telegram helpers ---
async function tgGet(method: string, params: Record<string, unknown> = {}) {
  const url = new URL(`${API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  return res.json();
}

async function sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function downloadPhoto(fileId: string): Promise<Buffer> {
  const res = await tgGet("getFile", { file_id: fileId });
  const filePath = res.result.file_path;
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const r = await fetch(url);
  return Buffer.from(await r.arrayBuffer());
}

// --- Vision analysis ---
async function analyzeFood(imageBuffer: Buffer): Promise<MacroEstimate | null> {
  const base64 = imageBuffer.toString("base64");
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          {
            type: "text",
            text: `You are a nutrition analyzer. Identify the food(s) in this image and estimate nutritional content for the visible portion.

Respond ONLY in this exact JSON format (no markdown, no explanation):
{
  "description": "short food name (e.g. Pasta carbonara ~350g)",
  "calories": 620,
  "protein_g": 22,
  "carbs_g": 74,
  "fat_g": 28,
  "fiber_g": 3,
  "confidence": "high",
  "notes": "optional note about estimation difficulty"
}

If no food is visible, return: {"error": "No food detected"}`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAnalysisResponse(text);
}

function parseAnalysisResponse(text: string): MacroEstimate | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed.error) return null;
    return parsed as MacroEstimate;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as MacroEstimate; } catch { }
    }
    return null;
  }
}

async function analyzeTextFood(description: string): Promise<MacroEstimate | null> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: `You are a nutrition analyzer. The user described a meal or food item in text.
Estimate the nutritional content for a typical serving unless a quantity is specified.

Respond ONLY in this exact JSON format (no markdown, no explanation):
{
  "description": "short food name with estimated portion (e.g. Big Mac meal ~950g)",
  "calories": 850,
  "protein_g": 32,
  "carbs_g": 98,
  "fat_g": 38,
  "fiber_g": 5,
  "confidence": "high",
  "notes": "optional note about estimation difficulty"
}

Description format: match the photo-analysis style — short name, estimated weight/portion in parentheses.
User input: "${description}"
If the input is not a food description, return: {"error": "Not food"}`,
    }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAnalysisResponse(text);
}

// --- Daily totals (reads from Supabase) ---
async function getDailyTotals(userId: number, date: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meals?user_id=eq.${userId}&date=eq.${date}&select=calories,protein_g,carbs_g,fat_g,fiber_g`,
    { headers: SB_HEADERS }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return {
    calories: rows.reduce((s: number, r: any) => s + (r.calories || 0), 0),
    protein: rows.reduce((s: number, r: any) => s + (r.protein_g || 0), 0),
    carbs: rows.reduce((s: number, r: any) => s + (r.carbs_g || 0), 0),
    fat: rows.reduce((s: number, r: any) => s + (r.fat_g || 0), 0),
    fiber: rows.reduce((s: number, r: any) => s + (r.fiber_g || 0), 0),
    meals: rows.length,
  };
}

function progressBar(current: number, target: number, width = 10): string {
  const pct = Math.min(current / target, 1);
  const filled = Math.round(pct * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function formatDailyTotalForUser(userId: number, user: any): Promise<string> {
  const date = new Date().toISOString().split("T")[0];
  const t = await getDailyTotals(userId, date);
  if (!t) return "No meals logged today yet.";

  const targets = {
    calories: user.kcal_target ?? 2000,
    protein: user.protein_target ?? 150,
    carbs: user.carbs_target ?? 200,
    fat: user.fat_target ?? 65,
    fiber: user.fiber_target ?? 25,
  };
  const calPct = Math.round((t.calories / targets.calories) * 100);
  return `*Today's Totals* (${t.meals} meal${t.meals !== 1 ? "s" : ""})\n\n` +
    `🔥 Calories: ${Math.round(t.calories)} / ${targets.calories} kcal (${calPct}%)\n` +
    `${progressBar(t.calories, targets.calories)}\n\n` +
    `💪 Protein: ${Math.round(t.protein)}g / ${targets.protein}g\n` +
    `🍞 Carbs: ${Math.round(t.carbs)}g / ${targets.carbs}g\n` +
    `🥑 Fat: ${Math.round(t.fat)}g / ${targets.fat}g\n` +
    `🌿 Fiber: ${Math.round(t.fiber)}g / ${targets.fiber}g`;
}

async function logToSupabase(userId: number, estimate: MacroEstimate, photoMsgId: number | null, source: string) {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0];
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/meals`, {
      method: "POST",
      headers: {
        ...SB_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        date,
        time,
        description: estimate.description,
        calories: estimate.calories,
        protein_g: estimate.protein_g,
        carbs_g: estimate.carbs_g,
        fat_g: estimate.fat_g,
        fiber_g: estimate.fiber_g,
        photo_msg_id: photoMsgId,
        source,
      }),
    });
  } catch (e) {
    console.error("Supabase meal write failed:", e);
  }
}

// --- Message handlers ---
async function handlePhoto(chatId: number, msgId: number, photos: Array<{ file_id: string; width: number }>, userId: number) {
  // Pick photo closest to 800px — enough resolution for food ID, ~60% fewer Vision tokens than 1280px
  const photo = photos.slice().sort((a, b) => Math.abs(a.width - 800) - Math.abs(b.width - 800))[0];

  // Download and analyze in parallel
  const imageBuffer = await downloadPhoto(photo.file_id);
  const estimate = await analyzeFood(imageBuffer);

  if (!estimate) {
    await sendMessage(chatId, "❌ Couldn't identify food in that image. Try a clearer photo?");
    return;
  }

  const confidenceEmoji = estimate.confidence === "high" ? "✅" : estimate.confidence === "medium" ? "⚠️" : "❓";
  let text = `${confidenceEmoji} *${estimate.description}*\n\n` +
    `🔥 Calories: *${estimate.calories} kcal*\n` +
    `💪 Protein: ${estimate.protein_g}g\n` +
    `🍞 Carbs: ${estimate.carbs_g}g\n` +
    `🥑 Fat: ${estimate.fat_g}g\n` +
    `🌿 Fiber: ${estimate.fiber_g}g\n`;

  if (estimate.notes) text += `\n_Note: ${estimate.notes}_\n`;
  text += `\nLog this?`;

  pending.set(msgId, { ...estimate, photoMsgId: msgId, userId, source: "photo" });

  const replyMarkup = {
    inline_keyboard: [[
      { text: "✅ Log it", callback_data: `log:${msgId}` },
      { text: "✏️ Edit", callback_data: `edit:${msgId}` },
      { text: "❌ Skip", callback_data: `skip:${msgId}` },
    ]],
  };

  await sendMessage(chatId, text, replyMarkup);
}

async function handleCallbackQuery(callbackQueryId: string, chatId: number, data: string, fromUserId?: number) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });

  const [action, msgIdStr] = data.split(":");
  const msgId = parseInt(msgIdStr);

  if (action === "undo") {
    const meal = await getMealById(msgId);
    if (!meal) {
      await sendMessage(chatId, "Meal not found — already removed?");
      return;
    }
    if (fromUserId && meal.user_id !== fromUserId) {
      await sendMessage(chatId, "That's not your meal to remove.");
      return;
    }
    const ok = await deleteMeal(msgId);
    if (!ok) {
      await sendMessage(chatId, "❌ Couldn't remove that meal. Try again?");
      return;
    }
    if (meal.photo_msg_id) unmarkPhotoLogged(meal.photo_msg_id);
    await sendMessage(chatId, `🗑️ Removed: *${meal.description}*`);
    return;
  }
  if (action === "cancelundo") {
    await sendMessage(chatId, "Keeping that meal.");
    return;
  }

  const estimate = pending.get(msgId);

  if (action === "log" && estimate) {
    console.log(`[LOG] photoMsgId=${estimate.photoMsgId} recentlyLogged=${recentlyLogged.has(estimate.photoMsgId)} alreadyLogged=${alreadyLogged(estimate.photoMsgId)}`);
    // Prevent duplicate logs from concurrent callback queries
    if (recentlyLogged.has(estimate.photoMsgId) || alreadyLogged(estimate.photoMsgId)) {
      pending.delete(msgId);
      await sendMessage(chatId, "⚠️ Already logged.");
      return;
    }
    recentlyLogged.add(estimate.photoMsgId);
    markPhotoLogged(estimate.photoMsgId);
    pending.delete(msgId);
    console.log(`[LOG] Logging to Supabase: ${estimate.description}`);
    await logToSupabase(estimate.userId, estimate, estimate.source === "text" ? null : estimate.photoMsgId, estimate.source);
    const user = await getCachedUser(estimate.userId);
    const totals = await formatDailyTotalForUser(estimate.userId, user);
    const mealCount = await getMealCount(estimate.userId);
    const dashboardLine = mealCount === 1
      ? `\n\n_See your history & streaks: ${process.env.DASHBOARD_URL || "https://your-dashboard-url.com"}_`
      : "";
    await sendMessage(chatId, `✅ Logged!\n\n${totals}${dashboardLine}`);
  } else if (action === "edit" && estimate) {
    pendingEdit.set(estimate.userId, msgId);
    await sendMessage(chatId, `✏️ *What is it?*\n\nDescribe the food in plain English and I'll re-estimate.\n\nExamples:\n• \`egg roll, not veggie roll\`\n• \`grilled chicken breast, ~200g\`\n• \`bowl of pho with brisket\``);
  } else if (action === "skip") {
    pending.delete(msgId);
    await sendMessage(chatId, "Skipped.");
  }
}

async function handleText(chatId: number, msgId: number, text: string, userId?: number) {
  const lower = text.trim().toLowerCase();

  // Handle /cancel during registration
  if (userId && pendingReg.has(userId) && lower === "/cancel") {
    pendingReg.delete(userId);
    await sendMessage(chatId, "No problem. Tap /start whenever you're ready.");
    return;
  }

  // Handle /cancel during edit
  if (userId && pendingEdit.has(userId) && lower === "/cancel") {
    pendingEdit.delete(userId);
    await sendMessage(chatId, "Edit cancelled — the original estimate still stands.");
    return;
  }

  // If user is editing a pending estimate, re-analyze from their new description
  if (userId && pendingEdit.has(userId) && !text.trim().startsWith("/")) {
    const editMsgId = pendingEdit.get(userId)!;
    const prev = pending.get(editMsgId);
    if (!prev) {
      pendingEdit.delete(userId);
    } else {
      pendingEdit.delete(userId);
      let estimate: MacroEstimate | null = null;
      try {
        estimate = await analyzeTextFood(text);
      } catch (err) {
        console.error("[EDIT] Re-analysis error:", err);
        await sendMessage(chatId, "Something went wrong re-analyzing — try describing it again.");
        pendingEdit.set(userId, editMsgId);
        return;
      }
      if (!estimate) {
        await sendMessage(chatId, "Hmm, I couldn't make sense of that. Try again or /cancel.");
        pendingEdit.set(userId, editMsgId);
        return;
      }
      pending.set(editMsgId, { ...estimate, photoMsgId: prev.photoMsgId, userId: prev.userId, source: prev.source });
      const confidenceEmoji = estimate.confidence === "high" ? "✅" : estimate.confidence === "medium" ? "⚠️" : "❓";
      const updatedText = `${confidenceEmoji} *${estimate.description}* _(updated)_\n\n` +
        `🔥 Calories: *${estimate.calories} kcal*\n` +
        `💪 Protein: ${estimate.protein_g}g\n` +
        `🍞 Carbs: ${estimate.carbs_g}g\n` +
        `🥑 Fat: ${estimate.fat_g}g\n` +
        `🌿 Fiber: ${estimate.fiber_g}g\n` +
        (estimate.notes ? `\n_Note: ${estimate.notes}_\n` : "") +
        `\nLog this?`;
      const replyMarkup = {
        inline_keyboard: [[
          { text: "✅ Log it", callback_data: `log:${editMsgId}` },
          { text: "✏️ Edit again", callback_data: `edit:${editMsgId}` },
          { text: "❌ Skip", callback_data: `skip:${editMsgId}` },
        ]],
      };
      await sendMessage(chatId, updatedText, replyMarkup);
      return;
    }
  }

  // Handle registration conversation (collecting name then email)
  if (userId && pendingReg.has(userId)) {
    const reg = pendingReg.get(userId)!;

    if (reg.step === "name") {
      const name = text.trim();
      pendingReg.set(userId, { step: "email", name });
      await sendMessage(chatId, `Nice to meet you, ${name}! What's your email address?`);
      return;
    }

    if (reg.step === "email") {
      const email = text.trim();
      const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailValid) {
        await sendMessage(chatId, "That doesn't look like an email — try again.");
        return;
      }
      const name = reg.name!;
      pendingReg.delete(userId);
      try {
        await registerUser(userId, name, email);
        await sendMessage(chatId, `You're in, ${name}! 🎉\n\n📸 Send a food photo, or\n📝 Type a meal — "big mac and fries", "2 eggs on toast"`);
      } catch {
        await sendMessage(chatId, "Something went wrong saving your account. Please try /start again.");
      }
      return;
    }
  }

  if (lower === "/start") {
    if (!userId) return;
    const existing = await getCachedUser(userId);
    if (existing) {
      await sendMessage(chatId, `Welcome back, ${existing.name}! 👋\n\nSend a food photo to log a meal.`);
      return;
    }
    pendingReg.set(userId, { step: "name" });
    await sendMessage(chatId, `👋 *Welcome to JarvisHealth!*\n\nI'll track your meals automatically.\n\n📸 Send a food photo, or\n📝 Type a meal — "big mac and fries", "2 eggs on toast"\n\nWhat's your name?`);
    return;
  }

  if (lower === "/whoami") {
    await sendMessage(chatId, `Your Telegram User ID is: \`${userId}\``);
    return;
  }

  if (lower === "/today" || lower === "/t") {
    if (!userId) return;
    const user = await getCachedUser(userId);
    if (!user) {
      await sendMessage(chatId, "You're not registered yet — tap /start to sign up in 30 seconds.");
      return;
    }
    await sendMessage(chatId, await formatDailyTotalForUser(userId, user));
    return;
  }

  if (lower === "/undo") {
    if (!userId) return;
    const user = await getCachedUser(userId);
    if (!user) {
      await sendMessage(chatId, "You're not registered yet — tap /start to sign up in 30 seconds.");
      return;
    }
    const meal = await getLatestMeal(userId);
    if (!meal) {
      await sendMessage(chatId, "No meals to undo.");
      return;
    }
    const replyMarkup = {
      inline_keyboard: [[
        { text: "🗑️ Remove it", callback_data: `undo:${meal.id}` },
        { text: "❌ Keep", callback_data: `cancelundo:${meal.id}` },
      ]],
    };
    await sendMessage(chatId,
      `Remove last meal?\n\n` +
      `*${meal.description}*\n` +
      `🔥 ${Math.round(meal.calories)} kcal | 💪 ${meal.protein_g}g | 🍞 ${meal.carbs_g}g | 🥑 ${meal.fat_g}g\n` +
      `_${meal.date} at ${meal.time}_`,
      replyMarkup
    );
    return;
  }

  if (lower === "/help") {
    await sendMessage(chatId,
      "*JarvisHealth*\n\n" +
      "📝 Type a meal — \"big mac and fries\", \"2 eggs on toast\"\n" +
      "📸 Send a food photo → instant macro analysis\n" +
      "✅ Tap Log it to save\n\n" +
      "Commands:\n" +
      "/start — register or sign in\n" +
      "/today — today's totals\n" +
      "/undo — remove your last logged meal\n" +
      "/targets — view your daily targets\n" +
      "/help — this message"
    );
    return;
  }

  if (lower === "/targets") {
    if (!userId) return;
    const user = await getCachedUser(userId);
    if (!user) {
      await sendMessage(chatId, "You're not registered yet — tap /start to sign up in 30 seconds.");
      return;
    }
    await sendMessage(chatId,
      `*Your Daily Targets*\n\n` +
      `🔥 Calories: ${user.kcal_target} kcal\n` +
      `💪 Protein: ${user.protein_target}g\n` +
      `🍞 Carbs: ${user.carbs_target}g\n` +
      `🥑 Fat: ${user.fat_target}g\n` +
      `🌿 Fiber: ${user.fiber_target}g\n\n` +
      `_Update targets: ${process.env.DASHBOARD_URL || "https://your-dashboard-url.com"} → Goals_`
    );
    return;
  }

  if (!userId) return;
  const user = await getCachedUser(userId);
  if (!user) {
    await sendMessage(chatId, "Tap /start to register first, then type your meal!");
    return;
  }
  if (text.trim().length < 3) {
    await sendMessage(chatId, "Not sure what to do with that! Try: \"2 eggs on toast\", \"big mac meal\" — or send a food photo 📸");
    return;
  }
  console.log(`[TEXT] User ${userId} sent: "${text.trim()}"`);
  let estimate: MacroEstimate | null = null;
  try {
    estimate = await analyzeTextFood(text);
  } catch (err) {
    console.error("[TEXT] Analysis error:", err);
    await sendMessage(chatId, "Something went wrong analyzing that — try a food photo instead 📸");
    return;
  }
  if (!estimate) {
    console.log("[TEXT] No estimate returned for: " + text);
    await sendMessage(chatId, "Not sure what to do with that! Try: \"2 eggs on toast\", \"big mac meal\" — or send a food photo 📸");
    return;
  }
  console.log("[TEXT] Got estimate:", JSON.stringify(estimate));
  const confidenceEmoji = estimate.confidence === "high" ? "✅" : estimate.confidence === "medium" ? "⚠️" : "❓";
  const foodText = `${confidenceEmoji} *${estimate.description}*\n\n` +
    `🔥 Calories: *${estimate.calories} kcal*\n` +
    `💪 Protein: ${estimate.protein_g}g\n` +
    `🍞 Carbs: ${estimate.carbs_g}g\n` +
    `🥑 Fat: ${estimate.fat_g}g\n` +
    `🌿 Fiber: ${estimate.fiber_g}g\n`;

  const finalText = foodText + (estimate.notes ? `\n_Note: ${estimate.notes}_\n` : "") + `\nLog this?`;

  pending.set(msgId, { ...estimate, photoMsgId: msgId, userId, source: "text" });

  const replyMarkup = {
    inline_keyboard: [[
      { text: "✅ Log it", callback_data: `log:${msgId}` },
      { text: "✏️ Edit", callback_data: `edit:${msgId}` },
      { text: "❌ Skip", callback_data: `skip:${msgId}` },
    ]],
  };

  console.log("[TEXT] Sending message with buttons to chat " + chatId);
  await sendMessage(chatId, finalText, replyMarkup);
  console.log("[TEXT] Message sent");
}

// --- Main polling loop ---
let offset = getOffset();

async function poll() {
  while (true) {
    try {
      const res = await tgGet("getUpdates", { offset, timeout: 30, allowed_updates: '["message","callback_query"]' });

      for (const update of res.result || []) {
        offset = update.update_id + 1;
        saveOffset(offset);

        if (update.callback_query) {
          const cq = update.callback_query;
          console.log(`[CALLBACK] update_id=${update.update_id} data=${cq.data}`);
          await handleCallbackQuery(cq.id, cq.message.chat.id, cq.data, cq.from?.id);
          continue;
        }

        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id;
        const userId = msg.from?.id;

        if (msg.photo) {
          console.log(`[PHOTO] update_id=${update.update_id} msg_id=${msg.message_id} user=${userId}`);
          const user = userId ? await getCachedUser(userId) : null;
          if (!user) {
            await sendMessage(chatId, "Tap /start to register first — takes 30 seconds. Then send your photo again!");
          } else {
            await handlePhoto(chatId, msg.message_id, msg.photo, userId!);
          }
        } else if (msg.text) {
          console.log(`[TEXT] update_id=${update.update_id} user=${userId} text=${msg.text.substring(0,50)}`);
          await handleText(chatId, msg.message_id, msg.text, userId);
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

console.log("🥗 JarvisHealth Bot started");
poll();
