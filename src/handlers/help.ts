import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "ℹ️ How to get access:\n\n" +
  "1. Tap \"💳 Pay for access\" on the menu\n" +
  "2. Enter your M-Pesa number\n" +
  "3. Confirm the payment on your phone\n" +
  "4. Get your invite link instantly\n\n" +
  "You can check your payment status anytime with \"📋 Check payment\".";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;
