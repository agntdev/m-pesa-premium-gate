# Premium Group Access Bot — Bot specification

**Archetype:** commerce

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot that automates paid access to a premium group via M-Pesa. Users submit their phone number, complete payment verification, and receive an invite link automatically. Admins get notifications about successful payments, failed attempts, and refund requests.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram users seeking premium group access
- M-Pesa users

## Success criteria

- User receives invite link after successful M-Pesa payment verification
- Admin receives real-time notifications for all payment outcomes

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu with pricing and payment instructions
- **Check payment status** (button, actor: user, callback: payment:check) — Verify M-Pesa transaction status after payment attempt
  - inputs: M-Pesa transaction ID
  - outputs: Payment verification result

## Flows

### Payment flow
_Trigger:_ /start

1. Display pricing and request M-Pesa number
2. Initiate M-Pesa payment request
3. Verify transaction status
4. Send invite link on success
5. Handle failure with retry option

_Data touched:_ User, PaymentAttempt, InviteLinkIssuance

### Admin notifications
_Trigger:_ Payment success/failure

1. Generate admin message with user details
2. Send direct Telegram notification to owner

_Data touched:_ User, PaymentAttempt

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **User** _(retention: persistent)_ — Telegram user with M-Pesa payment details
  - fields: telegram_id, mpesa_number, payment_attempts
- **PaymentAttempt** _(retention: persistent)_ — Transaction record with verification status
  - fields: amount, mpesa_number, timestamp, status, transaction_id
- **InviteLinkIssuance** _(retention: persistent)_ — Generated invite link tracking
  - fields: link, expiry, usage_status

## Integrations

- **Telegram** (required) — Bot API messaging and admin notifications
- **M-Pesa** (required) — Payment verification and transaction status checks
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure pricing amount
- Manage invite link regeneration
- Approve refunds with manual override

## Notifications

- Admin alerts for successful joins
- Failed payment retry notifications
- Refund request notifications

## Permissions & privacy

- Store user phone numbers and payment records for 180 days
- Telegram ID tracking for access control
- Admin access to transaction history

## Edge cases

- Failed M-Pesa transactions with retry limits
- Duplicate transaction attempts
- Expired invite link regeneration

## Required tests

- End-to-end payment verification flow
- Admin notification delivery test
- Invite link expiration handling

## Assumptions

- Single fixed pricing model
- M-Pesa verification API availability
- Admin will manually handle refunds
