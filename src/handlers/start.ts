import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, registerMainMenuItem } from "../toolkit/index.js";

// Register the payment-check menu item (this handler file is auto-loaded by buildBot).
// The payment handler registers its own "💳 Pay for access" item.
registerMainMenuItem({ label: "📋 Check payment", data: "payment:check", order: 30 });

const composer = new Composer<Ctx>();

const WELCOME =
  "👋 Welcome! Premium group access for 500 KES via M-Pesa.\n\n" +
  "Tap a button below to get started.";

composer.command("start", async (ctx) => {
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;
