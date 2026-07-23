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

const composer = new Composer<Ctx>();

// Check payment status — triggered from main menu button
composer.callbackQuery("payment:check", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_payment_check";
  await ctx.editMessageText(
    "Enter your M-Pesa transaction ID or phone number to check payment status:",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
