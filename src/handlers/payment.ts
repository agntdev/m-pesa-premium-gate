import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import type { StorageAdapter } from "grammy";

// Persistent storage for durable data (users, payments, invite links).
// Uses the toolkit's Redis-backed StorageAdapter — not in-memory Maps.
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
const PRICING_AMOUNT = 500;
const CURRENCY = "KES";
const MPESA_TILL = "123456";
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID ?? "0");
const INVITE_LINK_TTL = 7 * 24 * 60 * 60; // 7 days

// --- Helpers ---

function now(): number {
  return Date.now();
}

function isValidMpesaNumber(num: string): boolean {
  return /^(\+?254|0)?[17]\d{8}$/.test(num.replace(/\s/g, ""));
}

function formatMpesaNumber(raw: string): string {
  const digits = raw.replace(/\s/g, "").replace(/^\+?254/, "").replace(/^0/, "");
  return `254${digits}`;
}

async function recordPaymentAttempt(
  userId: number,
  mpesaNumber: string,
  amount: number,
): Promise<string> {
  const txnId = `MP${now()}${Math.floor(Math.random() * 1000)}`;
  await storeSet(`user:${userId}`, {
    telegram_id: userId,
    mpesa_number: mpesaNumber,
    updated_at: now(),
  });
  await storeSet(`payment:${txnId}`, {
    amount,
    mpesa_number: mpesaNumber,
    timestamp: now(),
    status: "pending",
    transaction_id: txnId,
    user_id: userId,
  });
  // Maintain per-user payment index (avoid keyspace scan)
  const userPaymentsKey = `user_payments:${userId}`;
  const existing = await storeGet<{ ids: string[] }>(userPaymentsKey);
  const ids = existing?.ids ?? [];
  ids.push(txnId);
  await storeSet(userPaymentsKey, { ids });
  return txnId;
}

async function updatePaymentStatus(
  txnId: string,
  status: "completed" | "failed",
): Promise<void> {
  const payment = await storeGet<{
    amount: number;
    mpesa_number: string;
    timestamp: number;
    user_id: number;
  }>(`payment:${txnId}`);
  if (!payment) return;
  await storeSet(`payment:${txnId}`, {
    ...payment,
    status,
    updated_at: now(),
  });
}

async function generateInviteLink(userId: number): Promise<string> {
  const code = `INV${userId}${Date.now()}`;
  const expiresAt = now() + INVITE_LINK_TTL * 1000;
  await storeSet(`invite:${code}`, {
    user_id: userId,
    expires_at: expiresAt,
    used: false,
  });
  await storeSet(`user_invite:${userId}`, { code, expires_at: expiresAt });
  return `https://t.me/${process.env.BOT_USERNAME ?? "your_bot"}?start=${code}`;
}

// Simulate M-Pesa STK push (replace with real Daraja API call in production).
// In production, this calls Safaricom's Daraja API via fetch().
async function initiateStkPush(
  mpesaNumber: string,
  amount: number,
): Promise<{ success: boolean; checkoutRequestId?: string; error?: string }> {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE ?? MPESA_TILL;
  const passkey = process.env.MPESA_PASSKEY;

  if (!consumerKey || !consumerSecret || !passkey) {
    // M-Pesa credentials not configured — prompt user to pay manually
    return {
      success: false,
      error: "M-Pesa integration not configured. Please pay manually.",
    };
  }

  try {
    // Step 1: Get OAuth token
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const tokenRes = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!tokenRes.ok) throw new Error(`OAuth failed: ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // Step 2: Initiate STK push
    const timestamp = new Date()
      .toISOString()
      .replace(/[-T:.Z]/g, "")
      .slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
      "base64",
    );

    const stkRes = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: amount,
          PartyA: mpesaNumber,
          PartyB: shortcode,
          PhoneNumber: mpesaNumber,
          CallBackURL: process.env.MPESA_CALLBACK_URL ?? "https://example.com/callback",
          AccountReference: `PremiumAccess`,
          TransactionDesc: `Payment for premium group access`,
        }),
      },
    );

    if (!stkRes.ok) throw new Error(`STK push failed: ${stkRes.status}`);
    const stkData = (await stkRes.json()) as {
      ResponseCode: string;
      CheckoutRequestID: string;
    };

    if (stkData.ResponseCode === "0") {
      return { success: true, checkoutRequestId: stkData.CheckoutRequestID };
    }
    return { success: false, error: "STK push was declined." };
  } catch (err) {
    return {
      success: false,
      error: `Payment initiation failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

// Poll M-Pesa transaction status (replace with real Daraja query in production).
async function queryTransactionStatus(
  checkoutRequestId: string,
): Promise<{ status: "completed" | "pending" | "failed"; result_code?: string }> {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE ?? MPESA_TILL;
  const passkey = process.env.MPESA_PASSKEY;

  if (!consumerKey || !consumerSecret || !passkey) {
    return { status: "pending" };
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const tokenRes = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!tokenRes.ok) throw new Error(`OAuth failed: ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const timestamp = new Date()
      .toISOString()
      .replace(/[-T:.Z]/g, "")
      .slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
      "base64",
    );

    const queryRes = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        }),
      },
    );

    if (!queryRes.ok) throw new Error(`Query failed: ${queryRes.status}`);
    const data = (await queryRes.json()) as {
      ResultCode: string;
      ResultDesc: string;
    };

    if (data.ResultCode === "0") return { status: "completed", result_code: "0" };
    if (data.ResultCode === "1032") return { status: "pending", result_code: "1032" };
    return { status: "failed", result_code: data.ResultCode };
  } catch {
    return { status: "pending" };
  }
}

// --- Main menu registration ---
registerMainMenuItem({
  label: "💳 Pay for access",
  data: "payment:start",
  order: 10,
});

// --- Handler ---
const composer = new Composer<Ctx>();

// Entry point: "Pay for access" button from main menu
composer.callbackQuery("payment:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_mpesa_number";
  await ctx.editMessageText(
    `Premium group access costs ${PRICING_AMOUNT} ${CURRENCY}.\n\n` +
      `Enter your M-Pesa phone number to receive a payment prompt:`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// Handle text input during payment flow
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step === "awaiting_mpesa_number") {
    const raw = ctx.message.text.trim();
    if (!isValidMpesaNumber(raw)) {
      await ctx.reply(
        "Invalid phone number. Enter a valid M-Pesa number (e.g. 0712345678):",
      );
      return;
    }

    const mpesaNumber = formatMpesaNumber(raw);
    ctx.session.mpesa_number = mpesaNumber;
    ctx.session.amount = PRICING_AMOUNT;
    ctx.session.step = undefined;

    await ctx.reply(
      `You'll pay ${PRICING_AMOUNT} ${CURRENCY} to M-Pesa Till ${MPESA_TILL}.\n\n` +
        `A payment prompt will be sent to ${mpesaNumber}.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Pay now", `payment:confirm:${mpesaNumber}`)],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  if (ctx.session.step === "awaiting_payment_check") {
    const input = ctx.message.text.trim();
    ctx.session.step = undefined;

    // Check by transaction ID first
    const payment = await storeGet<{
      amount: number;
      mpesa_number: string;
      status: string;
      transaction_id: string;
    }>(`payment:${input}`);

    if (payment) {
      const statusEmoji =
        payment.status === "completed"
          ? "✅"
          : payment.status === "failed"
            ? "❌"
            : "⏳";
      await ctx.reply(
        `${statusEmoji} Payment ${payment.transaction_id}\n` +
          `Amount: ${payment.amount} ${CURRENCY}\n` +
          `Status: ${payment.status}`,
        {
          reply_markup: inlineKeyboard([
            [inlineButton("⬅️ Back to menu", "menu:main")],
          ]),
        },
      );
      return;
    }

    // Check by M-Pesa number — find latest payment
    const userPayments = await storeGet<{ ids: string[] }>(
      `user_payments:${ctx.from?.id}`,
    );
    if (userPayments?.ids?.length) {
      const latestId = userPayments.ids[userPayments.ids.length - 1];
      const latest = await storeGet<{
        amount: number;
        mpesa_number: string;
        status: string;
        transaction_id: string;
      }>(`payment:${latestId}`);
      if (latest) {
        const statusEmoji =
          latest.status === "completed"
            ? "✅"
            : latest.status === "failed"
              ? "❌"
              : "⏳";
        await ctx.reply(
          `${statusEmoji} Payment ${latest.transaction_id}\n` +
            `Amount: ${latest.amount} ${CURRENCY}\n` +
            `Status: ${latest.status}`,
          {
            reply_markup: inlineKeyboard([
              [inlineButton("⬅️ Back to menu", "menu:main")],
            ]),
          },
        );
        return;
      }
    }

    await ctx.reply(
      "No payment found for that reference. Check the transaction ID and try again.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  return next();
});

// Confirm payment → initiate STK push
composer.callbackQuery(/^payment:confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Initiating payment…" });
  const match = ctx.match;
  const mpesaNumber = match?.[1];
  if (!mpesaNumber) return;

  const amount = ctx.session.amount ?? PRICING_AMOUNT;

  // Record the payment attempt
  const txnId = await recordPaymentAttempt(ctx.from.id, mpesaNumber, amount);
  ctx.session.transaction_id = txnId;

  // Initiate M-Pesa STK push
  const stkResult = await initiateStkPush(mpesaNumber, amount);

  if (!stkResult.success) {
    await updatePaymentStatus(txnId, "failed");
    await ctx.editMessageText(
      `Payment could not be initiated: ${stkResult.error}\n\n` +
        `You can retry or check your payment status later.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔄 Try again", "payment:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    // Notify admin of failed attempt
    if (ADMIN_CHAT_ID) {
      try {
        await ctx.api.sendMessage(
          ADMIN_CHAT_ID,
          `❌ Payment failed\nUser: ${ctx.from.id}\nM-Pesa: ${mpesaNumber}\nReason: ${stkResult.error}`,
        );
      } catch {
        // Admin notification failed — non-fatal
      }
    }
    return;
  }

  // Poll for transaction result (best-effort, with timeout)
  await ctx.editMessageText(
    "Payment prompt sent. Complete the payment on your phone.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏳ Checking status…", `payment:poll:${txnId}`)],
      ]),
    },
  );

  // Attempt to poll for status (up to 3 attempts, 5s apart)
  let finalStatus: "completed" | "pending" | "failed" = "pending";
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await queryTransactionStatus(stkResult.checkoutRequestId!);
    if (status.status === "completed") {
      finalStatus = "completed";
      break;
    }
    if (status.status === "failed") {
      finalStatus = "failed";
      break;
    }
  }

  if (finalStatus !== "pending") {
    await updatePaymentStatus(txnId, finalStatus);
  }

  if (finalStatus === "completed") {
    const inviteLink = await generateInviteLink(ctx.from.id);
    await ctx.editMessageText(
      "✅ Payment confirmed!\n\nHere's your invite link:",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔗 Join group", inviteLink)],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    // Notify admin of successful payment
    if (ADMIN_CHAT_ID) {
      try {
        await ctx.api.sendMessage(
          ADMIN_CHAT_ID,
          `✅ New member joined\nUser: @${ctx.from.username ?? ctx.from.id}\nAmount: ${amount} ${CURRENCY}\nTransaction: ${txnId}`,
        );
      } catch {
        // Admin notification failed — non-fatal
      }
    }
  } else if (finalStatus === "failed") {
    await ctx.editMessageText(
      "❌ Payment was not completed. You can try again.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔄 Try again", "payment:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    // Notify admin of failed payment
    if (ADMIN_CHAT_ID) {
      try {
        await ctx.api.sendMessage(
          ADMIN_CHAT_ID,
          `❌ Payment failed\nUser: ${ctx.from.id}\nM-Pesa: ${mpesaNumber}\nTransaction: ${txnId}`,
        );
      } catch {
        // Admin notification failed — non-fatal
      }
    }
  } else {
    await ctx.editMessageText(
      "⏳ Payment is still processing. Check your status later.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔄 Check status", `payment:poll:${txnId}`)],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  }
});

// Poll payment status on demand
composer.callbackQuery(/^payment:poll:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Checking status…" });
  const txnId = ctx.match?.[1];
  if (!txnId) return;

  const payment = await storeGet<{
    amount: number;
    status: string;
    mpesa_number: string;
  }>(`payment:${txnId}`);
  if (!payment) {
    await ctx.reply("Payment record not found.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  if (payment.status === "completed") {
    const inviteLink = await generateInviteLink(ctx.from.id);
    await ctx.editMessageText("✅ Payment confirmed! Here's your invite link:", {
      reply_markup: inlineKeyboard([
        [inlineButton("🔗 Join group", inviteLink)],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
  } else if (payment.status === "failed") {
    await ctx.editMessageText("❌ Payment was not completed.", {
      reply_markup: inlineKeyboard([
        [inlineButton("🔄 Try again", "payment:start")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
  } else {
    await ctx.editMessageText("⏳ Payment is still processing. Try again in a moment.", {
      reply_markup: inlineKeyboard([
        [inlineButton("🔄 Check again", `payment:poll:${txnId}`)],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
  }
});

export default composer;
