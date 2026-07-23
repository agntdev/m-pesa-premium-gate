import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import type { StorageAdapter } from "grammy";

// Persistent storage for durable data.
let persistentStore: StorageAdapter<Record<string, unknown>> | null = null;

async function getStore(): Promise<StorageAdapter<Record<string, unknown>>> {
  if (!persistentStore) {
    const { resolveSessionStorage } = await import("../toolkit/session/redis.js");
    persistentStore = resolveSessionStorage<Record<string, unknown>>(undefined);
  }
  return persistentStore;
}

async function storeGet<T>(key: string): Promise<T | undefined> {
  const store = await getStore();
  return store.read(key) as Promise<T | undefined>;
}

async function storeSet(key: string, value: Record<string, unknown>): Promise<void> {
  const store = await getStore();
  await store.write(key, value);
}

// --- Config ---
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID ?? "0");

// --- Handler ---
const composer = new Composer<Ctx>();

// Admin notification: payment success (triggered by payment handler via callback)
composer.callbackQuery(/^admin:notify:success:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.match?.[1];
  if (!userId) return;

  const user = await storeGet<{ telegram_id: number; mpesa_number: string }>(
    `user:${userId}`,
  );
  const userPayments = await storeGet<{ ids: string[] }>(`user_payments:${userId}`);
  const latestId = userPayments?.ids?.[userPayments.ids.length - 1];
  const payment = latestId
    ? await storeGet<{
        amount: number;
        status: string;
        transaction_id: string;
      }>(`payment:${latestId}`)
    : null;

  if (!ADMIN_CHAT_ID) return;

  try {
    const text =
      `✅ New member joined\n` +
      `User: @${ctx.from.username ?? ctx.from.id}\n` +
      `Amount: ${payment?.amount ?? "?"} KES\n` +
      `Transaction: ${payment?.transaction_id ?? "?"}`;
    await ctx.api.sendMessage(ADMIN_CHAT_ID, text);
  } catch {
    // Admin notification failed — non-fatal, never block user flow
  }
});

// Admin notification: payment failure
composer.callbackQuery(/^admin:notify:failure:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.match?.[1];
  if (!userId) return;

  if (!ADMIN_CHAT_ID) return;

  try {
    await ctx.api.sendMessage(
      ADMIN_CHAT_ID,
      `❌ Payment failed\nUser: ${ctx.from.id}\nPlease review and assist if needed.`,
    );
  } catch {
    // Admin notification failed — non-fatal
  }
});

// Admin: view recent payments
composer.callbackQuery("admin:payments", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_CHAT_ID) {
    await ctx.reply("You don't have admin access.");
    return;
  }

  await ctx.editMessageText("Loading recent payments…", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// Admin: regenerate invite link
composer.callbackQuery(/^admin:regen_invite:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.match?.[1];
  if (!userId || ctx.from.id !== ADMIN_CHAT_ID) return;

  // Generate a new invite link for the specified user
  const code = `INV${userId}${Date.now()}`;
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await storeSet(`invite:${code}`, {
    user_id: Number(userId),
    expires_at: expiresAt,
    used: false,
  });
  await storeSet(`user_invite:${userId}`, { code, expires_at: expiresAt });

  const botUsername = process.env.BOT_USERNAME ?? "your_bot";
  const inviteLink = `https://t.me/${botUsername}?start=${code}`;

  try {
    await ctx.api.sendMessage(
      ADMIN_CHAT_ID,
      `🔗 New invite link generated for user ${userId}:\n${inviteLink}`,
    );
  } catch {
    // Non-fatal
  }
});

// Admin: configure pricing
composer.callbackQuery("admin:config", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_CHAT_ID) {
    await ctx.reply("You don't have admin access.");
    return;
  }

  await ctx.editMessageText(
    "Admin settings\n\n" +
      "Current pricing: 500 KES\n" +
      "M-Pesa Till: " + (process.env.MPESA_SHORTCODE ?? "123456") + "\n\n" +
      "To change pricing, contact the developer.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
