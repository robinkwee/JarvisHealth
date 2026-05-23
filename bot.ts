import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";

const BOT_TOKEN = process.env.BOT_TOKEN || "8800575919:AAH7j-2OH7RM0ID0506mcosPEk6efWgdLcI";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || ""; // Google Apps Script URL (optional)

const TARGETS = {
  calories: parseInt(process.env.TARGET_CALORIES || "2000"),
  protein: parseInt(process.env.TARGET_PROTEIN || "150"),
  carbs: parseInt(process.env.TARGET_CARBS || "200"),
  fat: parseInt(process.env.TARGET_FAT || "65"),
  fiber: parseInt(process.env.TARGET_FIBER || "25"),
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function getRegisteredUser(userId: number) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${userId}&limit=1`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json() as any[];
  return rows[0] ?? null;
}

// --- Database setup ---
const db = new Database(import.meta.dir + "/log.db");
db.exec(`
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
  CREATE TABLE IF NOT EXISTS poll_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getOffset(): number {
  const row = db.prepare(`SELECT value FROM poll_state WHERE key = 'offset'`).get() as { value: string } | null;
  return row ? parseInt(row.value) : 0;
}
function saveOffset(val: number) {
  db.prepare(`INSERT OR REPLACE INTO poll_state (key, value) VALUES ('offset', ?)`).run(String(val));
}
function alreadyLogged(photoMsgId: number): boolean {
  return !!db.prepare(`SELECT id FROM food_log WHERE photo_msg_id = ?`).get(photoMsgId);
}

// Pending confirmations: msg_id -> macro data
const pending = new Map<number, MacroEstimate & { photoMsgId: number }>();

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

// --- Fetch targets from Settings sheet ---
async function fetchTargetsFromSheets(): Promise<boolean> {
  if (!SHEETS_WEBHOOK) return false;
  try {
    const url = SHEETS_WEBHOOK.replace(/(\?.*)?$/, "?action=settings");
    const res = await fetch(url, { redirect: "follow" });
    const json = await res.json() as { ok: boolean; settings?: Record<string, unknown> };
    if (!json.ok || !json.settings) return false;
    const s = json.settings;
    if (s["KCal"])      TARGETS.calories = parseFloat(String(s["KCal"]))      || TARGETS.calories;
    if (s["protein_g"]) TARGETS.protein  = parseFloat(String(s["protein_g"])) || TARGETS.protein;
    if (s["carb_g"])    TARGETS.carbs    = parseFloat(String(s["carb_g"]))    || TARGETS.carbs;
    if (s["fat_g"])     TARGETS.fat      = parseFloat(String(s["fat_g"]))     || TARGETS.fat;
    if (s["fiber_g"])   TARGETS.fiber    = parseFloat(String(s["fiber_g"]))   || TARGETS.fiber;
    console.log(`📊 Targets from Sheets: ${TARGETS.calories} kcal | ${TARGETS.protein}g P | ${TARGETS.carbs}g C | ${TARGETS.fat}g F | ${TARGETS.fiber}g Fiber`);
    return true;
  } catch (err) {
    console.error("Failed to fetch targets from Sheets:", err);
    return false;
  }
}

// --- Daily totals ---
function getDailyTotals(chatId: number, date: string) {
  return db.prepare(`
    SELECT
      SUM(calories) as calories,
      SUM(protein_g) as protein,
      SUM(carbs_g) as carbs,
      SUM(fat_g) as fat,
      SUM(fiber_g) as fiber,
      COUNT(*) as meals
    FROM food_log WHERE date = ? AND chat_id = ?
  `).get(date, chatId) as { calories: number; protein: number; carbs: number; fat: number; fiber: number; meals: number };
}

function progressBar(current: number, target: number, width = 10): string {
  const pct = Math.min(current / target, 1);
  const filled = Math.round(pct * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatDailyTotal(chatId: number): string {
  const today = new Date().toISOString().split("T")[0];
  const t = getDailyTotals(chatId, today);
  if (!t || !t.meals) return "No meals logged today yet.";

  const calPct = Math.round((t.calories / TARGETS.calories) * 100);
  return `*Today's Totals* (${t.meals} meal${t.meals !== 1 ? "s" : ""})\n\n` +
    `🔥 Calories: ${Math.round(t.calories)} / ${TARGETS.calories} kcal (${calPct}%)\n` +
    `${progressBar(t.calories, TARGETS.calories)}\n\n` +
    `💪 Protein: ${Math.round(t.protein)}g / ${TARGETS.protein}g\n` +
    `🍞 Carbs: ${Math.round(t.carbs)}g / ${TARGETS.carbs}g\n` +
    `🥑 Fat: ${Math.round(t.fat)}g / ${TARGETS.fat}g\n` +
    `🌿 Fiber: ${Math.round(t.fiber)}g / ${TARGETS.fiber}g`;
}

// --- Log to DB + optional Sheets webhook ---
function logMeal(chatId: number, estimate: MacroEstimate, photoMsgId: number) {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0];

  db.prepare(`
    INSERT INTO food_log (date, time, description, calories, protein_g, carbs_g, fat_g, fiber_g, photo_msg_id, chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, time, estimate.description, estimate.calories, estimate.protein_g, estimate.carbs_g, estimate.fat_g, estimate.fiber_g, photoMsgId, chatId);

  if (SHEETS_WEBHOOK) {
    // Apps Script requires two-step: POST gets a redirect URL, then GET that URL
    fetch(SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, time, ...estimate, photo_msg_id: photoMsgId }),
      redirect: "manual",
    }).then(r => {
      const loc = r.headers.get("location");
      if (loc) fetch(loc).catch(() => {});
    }).catch(() => {});
  }
}

// --- Message handlers ---
async function handlePhoto(chatId: number, msgId: number, photos: Array<{ file_id: string; width: number }>) {
  await sendMessage(chatId, "🔍 Analyzing your food...");

  const largest = photos.reduce((a, b) => (a.width > b.width ? a : b));
  const imageBuffer = await downloadPhoto(largest.file_id);
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

  // Store pending confirmation
  pending.set(msgId, { ...estimate, photoMsgId: msgId });

  const replyMarkup = {
    inline_keyboard: [[
      { text: "✅ Log it", callback_data: `log:${msgId}` },
      { text: "✏️ Edit", callback_data: `edit:${msgId}` },
      { text: "❌ Skip", callback_data: `skip:${msgId}` },
    ]],
  };

  await sendMessage(chatId, text, replyMarkup);
}

async function handleCallbackQuery(callbackQueryId: string, chatId: number, data: string) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });

  const [action, msgIdStr] = data.split(":");
  const msgId = parseInt(msgIdStr);
  const estimate = pending.get(msgId);

  if (action === "log" && estimate) {
    if (alreadyLogged(estimate.photoMsgId)) {
      pending.delete(msgId);
      await sendMessage(chatId, "⚠️ Already logged.");
      return;
    }
    logMeal(chatId, estimate, estimate.photoMsgId);
    pending.delete(msgId);
    const totals = formatDailyTotal(chatId);
    await sendMessage(chatId, `✅ Logged!\n\n${totals}`);
  } else if (action === "edit" && estimate) {
    await sendMessage(chatId, `✏️ *Edit macros for: ${estimate.description}*\n\nReply with corrections, e.g.:\n• \`calories 450\`\n• \`protein 35g\`\n• \`chicken breast 200g\`\n• \`all: 500 cal, 40p, 30c, 15f\``);
  } else if (action === "skip") {
    pending.delete(msgId);
    await sendMessage(chatId, "Skipped.");
  }
}

async function handleText(chatId: number, text: string, userId?: number) {
  const lower = text.trim().toLowerCase();

  if (lower === "/start") {
    await sendMessage(chatId,
      `👋 *Welcome to JarvisHealth!*\n\n` +
      `Your Telegram User ID is: \`${userId}\`\n\n` +
      `To get started:\n` +
      `1. Copy your User ID above\n` +
      `2. Visit the dashboard to register: ${process.env.DASHBOARD_URL || "https://your-dashboard-url.com"}\n` +
      `3. Enter your name, email, and this User ID\n` +
      `4. Then send food photos here to start tracking!\n\n` +
      `Type /help for all commands.`
    );
    return;
  }

  if (lower === "/whoami") {
    await sendMessage(chatId, `Your Telegram User ID is: \`${userId}\``);
    return;
  }

  if (lower === "/today" || lower === "/t") {
    await sendMessage(chatId, formatDailyTotal(chatId));
    return;
  }

  if (lower === "/help") {
    await sendMessage(chatId,
      "*JarvisHealth*\n\n" +
      "📸 Send a food photo → instant macro analysis\n" +
      "✅ Tap Log it to save\n\n" +
      "Commands:\n" +
      "/start — welcome + your Telegram User ID\n" +
      "/whoami — show your Telegram User ID\n" +
      "/today — today's totals\n" +
      "/targets — view daily targets\n" +
      `/set calories 1800 — update a target\n` +
      "/help — this message"
    );
    return;
  }

  if (lower === "/targets") {
    await fetchTargetsFromSheets();
    await sendMessage(chatId,
      `*Daily Targets*\n\n` +
      `🔥 Calories: ${TARGETS.calories} kcal\n` +
      `💪 Protein: ${TARGETS.protein}g\n` +
      `🍞 Carbs: ${TARGETS.carbs}g\n` +
      `🥑 Fat: ${TARGETS.fat}g\n` +
      `🌿 Fiber: ${TARGETS.fiber}g`
    );
    return;
  }

  const setMatch = text.match(/^\/set\s+(calories|protein|carbs|fat)\s+(\d+)/i);
  if (setMatch) {
    const key = setMatch[1].toLowerCase() as keyof typeof TARGETS;
    TARGETS[key] = parseInt(setMatch[2]);
    await sendMessage(chatId, `✅ Updated ${key} target to ${TARGETS[key]}${key === "calories" ? " kcal" : "g"}`);
    return;
  }

  // Check if editing a pending estimate
  let edited = false;
  for (const [msgId, estimate] of pending.entries()) {
    const calMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:cal(?:ories?)?|kcal)/i);
    const proteinMatch = text.match(/(?:protein\s+)?(\d+(?:\.\d+)?)\s*g?\s*(?:protein)/i) || text.match(/protein\s+(\d+(?:\.\d+)?)/i);
    const carbsMatch = text.match(/(?:carbs?\s+)?(\d+(?:\.\d+)?)\s*g?\s*(?:carbs?)/i) || text.match(/carbs?\s+(\d+(?:\.\d+)?)/i);
    const fatMatch = text.match(/(?:fat\s+)?(\d+(?:\.\d+)?)\s*g?\s*(?:fat)/i) || text.match(/fat\s+(\d+(?:\.\d+)?)/i);
    const allMatch = text.match(/all:\s*(\d+)\s*cal[,\s]+(\d+)p[,\s]+(\d+)c[,\s]+(\d+)f/i);

    if (allMatch) {
      estimate.calories = parseInt(allMatch[1]);
      estimate.protein_g = parseInt(allMatch[2]);
      estimate.carbs_g = parseInt(allMatch[3]);
      estimate.fat_g = parseInt(allMatch[4]);
      edited = true;
    } else {
      if (calMatch) estimate.calories = parseFloat(calMatch[1]);
      if (proteinMatch) estimate.protein_g = parseFloat(proteinMatch[1]);
      if (carbsMatch) estimate.carbs_g = parseFloat(carbsMatch[1]);
      if (fatMatch) estimate.fat_g = parseFloat(fatMatch[1]);
      if (calMatch || proteinMatch || carbsMatch || fatMatch) edited = true;
    }

    if (edited) {
      pending.set(msgId, estimate);
      const replyMarkup = {
        inline_keyboard: [[
          { text: "✅ Log it", callback_data: `log:${msgId}` },
          { text: "❌ Skip", callback_data: `skip:${msgId}` },
        ]],
      };
      await sendMessage(chatId,
        `Updated!\n🔥 ${estimate.calories} kcal | 💪 ${estimate.protein_g}g | 🍞 ${estimate.carbs_g}g | 🥑 ${estimate.fat_g}g\n\nLog it?`,
        replyMarkup
      );
      break;
    }
  }

  if (!edited) {
    await sendMessage(chatId, "Send me a food photo to log it! /help for commands.");
  }
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
          await handleCallbackQuery(cq.id, cq.message.chat.id, cq.data);
          continue;
        }

        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id;
        const userId = msg.from?.id;

        if (msg.photo) {
          const user = userId ? await getRegisteredUser(userId) : null;
          if (!user) {
            await sendMessage(chatId,
              `👋 You need to register first!\n\n` +
              `1. Go to the dashboard: ${process.env.DASHBOARD_URL || "https://your-dashboard-url.com"}\n` +
              `2. Click *New? Register*\n` +
              `3. Your Telegram ID is: \`${userId}\`\n\n` +
              `Once registered, send your food photo again!`
            );
          } else {
            await handlePhoto(chatId, msg.message_id, msg.photo);
          }
        } else if (msg.text) {
          await handleText(chatId, msg.text, userId);
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

console.log("🥗 Calorie Tracker Bot started");
if (SHEETS_WEBHOOK) {
  console.log("📊 Google Sheets webhook configured — loading targets from Settings sheet...");
  await fetchTargetsFromSheets();
} else {
  console.log(`Targets: ${TARGETS.calories} kcal | ${TARGETS.protein}g protein | ${TARGETS.carbs}g carbs | ${TARGETS.fat}g fat`);
}
poll();
