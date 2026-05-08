const {
  Client,
  GatewayIntentBits,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── All IDs hardcoded — only DISCORD_BOT_TOKEN needed in Railway ─────────────
const TOKEN             = process.env.DISCORD_BOT_TOKEN;
const OWNER_ID          = "1501523431697678356";
const CLOSED_BY_ID      = "1370677325733167241";

const VERIFIED_ROLE_ID  = "1501533110121005076";
const PURCHASED_ROLE_ID = "1501533399125594223";
const ORDER_PING_ROLE   = "1501523431697678356";

const VOUCH_CHANNEL_ID  = "1501508189303214080";
const INQUIRY_CHANNEL   = "1501507687563923498";
const ORDER_LOG_CHANNEL = "1501508113260347463";
const ORDER_CATEGORY    = "1501524931794702346";
const REPORT_CATEGORY   = "1501524974194655233";

const PREFIX = ".";

// ─── State ────────────────────────────────────────────────────────────────────
const orderData     = new Map(); // channelId -> { userId, item, quantity, payment, logMsgId }
const statusMsgMap  = new Map(); // channelId -> statusMsgId
const statusAnimMap = new Map(); // channelId -> intervalId
const pendingVouchers = new Set();

// ─── Math helpers ─────────────────────────────────────────────────────────────

function calcCT(amount) {
  const charge = Math.ceil(amount / 0.7);
  return { charge, tax: charge - amount, receive: amount };
}

function calcNCT(amount) {
  const receive = Math.floor(amount * 0.7);
  return { charge: amount, tax: amount - receive, receive };
}

function extractGamepassId(text) {
  if (!text) return null;
  const m = text.match(/game-pass\/(\d+)/i) || text.match(/catalog\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(text.trim())) return text.trim();
  return null;
}

async function fetchGamepassInfo(id) {
  const res = await fetch(`https://economy.roblox.com/v1/game-passes/${id}/game-pass-product-info`);
  if (!res.ok) throw new Error("Gamepass not found.");
  const d = await res.json();
  if (!d.PriceInRobux) throw new Error("Gamepass has no price.");
  return { price: d.PriceInRobux, name: d.Name };
}

// ─── Animation helpers ────────────────────────────────────────────────────────

function stopAnimation(channelId) {
  if (statusAnimMap.has(channelId)) {
    clearInterval(statusAnimMap.get(channelId));
    statusAnimMap.delete(channelId);
  }
}

async function startPulseAnimation(msg, channelId, frames) {
  stopAnimation(channelId);
  let i = 0;
  const interval = setInterval(async () => {
    try { await msg.edit(frames[i % frames.length]); } catch {}
    i++;
    if (i >= 60) clearInterval(interval);
  }, 1000);
  statusAnimMap.set(channelId, interval);
}

async function applyStatus(message, frames) {
  const existing = statusMsgMap.get(message.channel.id);
  let msg;
  if (existing) {
    try {
      msg = await message.channel.messages.fetch(existing);
      await msg.edit(frames[0]);
    } catch {
      msg = await message.channel.send(frames[0]);
      statusMsgMap.set(message.channel.id, msg.id);
    }
  } else {
    msg = await message.channel.send(frames[0]);
    statusMsgMap.set(message.channel.id, msg.id);
  }
  startPulseAnimation(msg, message.channel.id, frames);
}

// ─── Message helpers ──────────────────────────────────────────────────────────

async function fetchAllMessages(channel) {
  const all = [];
  let lastId;
  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;
    all.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

async function awaitReply(channel, userId, timeoutMs = 5 * 60 * 1000) {
  const col = await channel.awaitMessages({
    filter: m => m.author.id === userId && !m.author.bot,
    max: 1,
    time: timeoutMs,
    errors: ["time"],
  }).catch(() => null);
  return col?.first()?.content?.trim() || null;
}

// ─── Order interview ──────────────────────────────────────────────────────────

async function runOrderInterview(channel, userId) {
  await channel.send(`·:¨༺ ♱ 𝐍𝐄𝐖 𝐎𝐑𝐃𝐄𝐑 𝐍𝐎𝐓𝐈𝐂𝐄! ♱ ༻¨:·\n<@&${ORDER_PING_ROLE}>`);
  await new Promise(r => setTimeout(r, 800));
  await channel.send(`Hello Tourist <@${userId}> I'm Neuvillette !`);

  await channel.send(`What are you going to buy? (Robux, Premiums, Boost, etc..)`);
  const item = await awaitReply(channel, userId);
  if (!item) { await channel.send("⏰ Interview timed out."); return; }

  await channel.send(`How many of this item?`);
  const quantity = await awaitReply(channel, userId);
  if (!quantity) { await channel.send("⏰ Interview timed out."); return; }

  await channel.send(`What payment method are you going to use? (Gcash, PayPal, etc...)`);
  const payment = await awaitReply(channel, userId);
  if (!payment) { await channel.send("⏰ Interview timed out."); return; }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("order_confirm_yes").setLabel("𖹭 𝖄𝖊𝖘").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("order_confirm_no").setLabel("ᛝ 𝕹𝖔").setStyle(ButtonStyle.Danger),
  );
  await channel.send({
    content:
      `⁺‧₊˚ ཐི⋆ 𝕾𝖞𝖘𝖙𝖊𝖒 𝕱𝖎𝖓𝖆𝖑𝖎𝖟𝖆𝖙𝖎𝖔𝖗... ⋆ཋྀ ˚₊‧⁺\n\n` +
      `Okay Ma'am/Sir your order needed\nto be finalized. Your order is :\n` +
      `**Item:** ${item}\n**Quantity:** ${quantity}\n**Payment Method:** ${payment}\n\n` +
      `Is it correct Ma'am/Sir?`,
    components: [row],
  });
  orderData.set(channel.id, { userId, item, quantity, payment, logMsgId: null });
}

async function postOrderLog(channel, userId, item, quantity, payment, guild) {
  const logChannel = guild.channels.cache.get(ORDER_LOG_CHANNEL);
  if (!logChannel) return;
  const msg = await logChannel.send(
    `.   .    𝓞rder listed   ୨୧\n\n` +
    `**Customer:** <@${userId}>\n` +
    `**Order:** ${item}\n` +
    `**Quantity:** ${quantity}\n` +
    `**Payment Method:** ${payment}\n` +
    `**Status:** ⏳ Pending`
  );
  const state = orderData.get(channel.id) || {};
  orderData.set(channel.id, { ...state, logMsgId: msg.id });
}

// ─── Bot ready ────────────────────────────────────────────────────────────────

client.once("ready", c => {
  console.log(`✅ Bot online as ${c.user.tag}`);
  c.user.setActivity("your server", { type: ActivityType.Watching });
});

// ─── Commands ─────────────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ── Vouch detection ──────────────────────────────────────────────────────
  if (message.channel.id === VOUCH_CHANNEL_ID) {
    const c = message.content.toLowerCase();
    if (
      c.includes("vouch") &&
      message.mentions.users.size > 0 &&
      c.includes("for") &&
      message.attachments.size > 0
    ) {
      await message.react("✅").catch(() => {});
      if (message.member?.roles.cache.has(PURCHASED_ROLE_ID)) {
        await message.member.roles.remove(PURCHASED_ROLE_ID).catch(() => {});
        pendingVouchers.delete(message.author.id);
      }
    }
    return;
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── .calcu ───────────────────────────────────────────────────────────────
  if (command === "calcu") {
    const expr = args.join(" ");
    if (!expr) return message.reply("❌ Usage: `.calcu 1+1`");
    try {
      const safe = expr.replace(/[^0-9+\-*/().\s]/g, "");
      const result = Function(`"use strict"; return (${safe})`)();
      if (typeof result !== "number" || !isFinite(result)) throw new Error();
      return message.reply(
        `⋆.ೃ࿔*:･{𝕾𝖞𝖘𝖙𝖊𝖒: 𝕮𝖆𝖑𝖈𝖚𝖑𝖆𝖙𝖔𝖗..}\n` +
        `- **__Question__** : **${expr}**\n` +
        `ׂ╰┈➤ **__Answer__** : ${result}`
      );
    } catch { return message.reply("❌ Invalid expression. Example: `.calcu 5*3`"); }
  }

  // ── .ct ──────────────────────────────────────────────────────────────────
  if (command === "ct") {
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Usage: `.ct 100`");
    const { charge, tax, receive } = calcCT(amount);
    return message.reply(
      `ੈ✩‧₊˚ {𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖆𝖝 𝕮𝖆𝖑𝖈𝖚𝖑𝖆𝖙𝖔𝖗...)\n` +
      `- The **Tax** is ${tax} robux\n\n` +
      `- You will get exactly **${receive} robux**\n` +
      `*(Set gamepass to: **${charge} robux**)*`
    );
  }

  // ── .nct ─────────────────────────────────────────────────────────────────
  if (command === "nct") {
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Usage: `.nct 100`");
    const { tax, receive } = calcNCT(amount);
    return message.reply(
      `ੈ✩‧₊˚ {𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖆𝖝 𝕮𝖆𝖑𝖈𝖚𝖑𝖆𝖙𝖔𝖗...)\n` +
      `- The **Tax** is ${tax} robux\n\n` +
      `- You will get exactly **${receive} robux**`
    );
  }

  // ── .scan ────────────────────────────────────────────────────────────────
  if (command === "scan") {
    const mode = args[0]?.toLowerCase();
    const replied = message.reference
      ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
      : null;
    if (!replied) return message.reply("❌ Please **reply** to a message with the gamepass link.");
    const url = replied.content.match(/https?:\/\/[^\s]+/)?.[0] || replied.content;
    const id = extractGamepassId(url);
    if (!id) return message.reply("❌ No valid gamepass ID found.");
    try {
      const { price, name } = await fetchGamepassInfo(id);
      const { tax, receive } = calcNCT(price);
      let body = "";
      if (!mode) {
        body = `- The **Gamepass** is exact :\n**${price} robux** — *${name}*\n\n- And for you (the user/customer)\nyou will receive exactly : **${receive} robux**`;
      } else if (mode === "ct") {
        const r = calcCT(price);
        body = `- The **Gamepass** (CT) :\n**${price} robux** — *${name}*\n\n- Tax covered: ${r.tax} robux\n- You will receive exactly : **${r.receive} robux**`;
      } else {
        body = `- The **Gamepass** (NCT) :\n**${price} robux** — *${name}*\n\n- Tax deducted: ${tax} robux\n- You will receive exactly : **${receive} robux**`;
      }
      return message.reply(`˗ˏˋ ꒰ 𝕾𝖞𝖘𝖙𝖊𝖒 𝕻𝖗𝖔𝖈𝖊𝖘𝖘𝖎𝖓𝖌... ꒱ ˎˊ˗\n**Okay Scanned complete**.\n${body}`);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  // ── .fix ─────────────────────────────────────────────────────────────────
  if (command === "fix") {
    const replied = message.reference
      ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
      : null;
    const raw = replied ? replied.content : args.join(" ");
    const id = extractGamepassId(raw);
    if (!id) return message.reply("❌ Reply to a message with a gamepass link/ID, or type `.fix <id>`");
    return message.reply(
      `𐙚⋆.˚{𝕾𝖞𝖘𝖙𝖊𝖒: 𝕲𝖆𝖒𝖊𝖕𝖆𝖘𝖘 𝕱𝖎𝖝𝖎𝖓𝖌..}\n` +
      `- **__Fixing Complete.__**\n` +
      `ׂ╰ **__Heres your Gamepass Link__** ׂ\n` +
      `ׂ╰ https://www.roblox.com/game-pass/${id}`
    );
  }

  // ── .shopopen ────────────────────────────────────────────────────────────
  if (command === "shopopen") {
    return message.channel.send(
      `𝕾𝖞𝖘𝖙𝖊𝖒 𝕾𝖙𝖆𝖙𝖚𝖘: 𝕾𝖍𝖔𝖕 𝖎𝖘 𝖓𝖔𝖜 𝖔𝖕𝖊𝖓. 𐔌՞. .՞𐦯\n` +
      `- The shop is now open! @everyone\n` +
      `but expect late response from owner\nmaybe he's still busy or sleeping.`
    );
  }

  // ── .shopclosed ──────────────────────────────────────────────────────────
  if (command === "shopclosed") {
    return message.channel.send(
      `𝕾𝖞𝖘𝖙𝖊𝖒 𝕾𝖙𝖆𝖙𝖚𝖘: 𝕾𝖍𝖔𝖕 𝖎𝖘 𝖓𝖔𝖜 𝖈𝖑𝖔𝖘𝖊𝖉. 𐔌՞. .՞𐦯\n` +
      `- The shop is now closed. @everyone\n` +
      `to the tourist who opens a ticket\nright now, owner will check it\n` +
      `tomorrow, wait for his response.\nHave a great night.`
    );
  }

  // ── .help ────────────────────────────────────────────────────────────────
  if (command === "help") {
    return message.reply(
      `**__bot commands__** !!!\n\n` +
      `1. **.calcu** 1+1, 2-2, 3*3, 4/4 ↳ **__mathematical calculator__**\n\n` +
      `2. **.ct** (amount) ↳ **__robux calculator ( ct )__**\n\n` +
      `3. **.nct** (amount) ↳ **__robux calculator ( nct )__**\n\n` +
      `4. **.scan** ( reply to link ) ↳ **__gamepass scanner__**\n\n` +
      `5. **.scan ct** ( reply to link ) ↳ **__gamepass scanner ( ct )__**\n\n` +
      `6. **.scan nct** ( reply to link ) ↳ **__gamepass scanner ( nct )__**\n\n` +
      `7. **.fix** ( reply to link ) ↳ **__gamepass link fixer__**\n\n` +
      `8. **.shopopen** — announces shop is open\n` +
      `9. **.shopclosed** — announces shop is closed`
    );
  }

  // ── .noted ───────────────────────────────────────────────────────────────
  if (command === "noted") {
    await applyStatus(message, [
      `🔴━━━━━━⬤━━━━━━⬤\n**Noted**`,
      `❤️━━━━━━⬤━━━━━━⬤\n**Noted**`,
    ]);
    return;
  }

  // ── .processing ──────────────────────────────────────────────────────────
  if (command === "processing") {
    await applyStatus(message, [
      `⬤━━━━━━🟡━━━━━━⬤\n**Processing**`,
      `⬤━━━━━━💛━━━━━━⬤\n**Processing**`,
    ]);
    return;
  }

  // ── .done ────────────────────────────────────────────────────────────────
  if (command === "done") {
    await applyStatus(message, [
      `⬤━━━━━━⬤━━━━━━🟢\n**Done**`,
      `⬤━━━━━━⬤━━━━━━💚\n**Done**`,
    ]);
    return;
  }

  // ── .orderdone ───────────────────────────────────────────────────────────
  if (command === "orderdone") {
    const state = orderData.get(message.channel.id);
    const customerId = state?.userId;

    await message.channel.send(
      `✧.* 𝕾𝖞𝖘𝖙𝖊𝖒: 𝕺𝖗𝖉𝖊𝖗 𝕯𝖔𝖓𝖊.\n` +
      `- Your order is now done\n` +
      `please vouch in our vouching\nchannel, use the correct format\n` +
      `or your vouch will be voided/invalid. Thank you so much for purchasing!` +
      (customerId ? ` <@${customerId}>` : "")
    );

    if (state?.logMsgId) {
      try {
        const logChannel = message.guild.channels.cache.get(ORDER_LOG_CHANNEL);
        if (logChannel) {
          const logMsg = await logChannel.messages.fetch(state.logMsgId);
          await logMsg.edit(logMsg.content.replace("⏳ Pending", "✅ Done"));
        }
      } catch {}
    }

    stopAnimation(message.channel.id);
    const existingStatus = statusMsgMap.get(message.channel.id);
    if (existingStatus) {
      try {
        const sm = await message.channel.messages.fetch(existingStatus);
        await sm.edit(`⬤━━━━━━⬤━━━━━━🟢\n**Done**`);
      } catch {}
    }

    if (customerId) {
      try {
        const member = await message.guild.members.fetch(customerId);
        await member.roles.add(PURCHASED_ROLE_ID);
        pendingVouchers.add(customerId);
      } catch {}
    }

    orderData.delete(message.channel.id);
    return;
  }

  // ── .close ───────────────────────────────────────────────────────────────
  if (command === "close") {
    const state = orderData.get(message.channel.id);
    const customerId = state?.userId;
    const channelName = message.channel.name;
    const guild = message.guild;

    const countMsg = await message.channel.send(`🔒 𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖍𝖎𝖘 𝖙𝖎𝖈𝖐𝖊𝖙 𝖎𝖘 𝖈𝖑𝖔𝖘𝖎𝖓𝖌 𝖎𝖓 3...`);
    await new Promise(r => setTimeout(r, 1000));
    await countMsg.edit(`🔒 𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖍𝖎𝖘 𝖙𝖎𝖈𝖐𝖊𝖙 𝖎𝖘 𝖈𝖑𝖔𝖘𝖎𝖓𝖌 𝖎𝖓 2...`);
    await new Promise(r => setTimeout(r, 1000));
    await countMsg.edit(`🔒 𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖍𝖎𝖘 𝖙𝖎𝖈𝖐𝖊𝖙 𝖎𝖘 𝖈𝖑𝖔𝖘𝖎𝖓𝖌 𝖎𝖓 1...`);
    await new Promise(r => setTimeout(r, 1000));
    await countMsg.edit(`🔒 𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖍𝖎𝖘 𝖙𝖎𝖈𝖐𝖊𝖙 𝖎𝖘 𝖈𝖑𝖔𝖘𝖎𝖓𝖌 𝖎𝖓 0...`);
    await new Promise(r => setTimeout(r, 1000));

    try {
      const messages = await fetchAllMessages(message.channel);

      const now = new Date();
      const dateGMT8 = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Manila",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      }).format(now).replace(/(\d+)\/(\d+)\/(\d+),/, "$3-$2-$1");
      const dateStr = `${dateGMT8} GMT+8`;

      let transcriptText = `Transcript — #${channelName}\n`;
      transcriptText += `Date: ${dateStr}\n`;
      transcriptText += `Opened by: ${customerId ? `<@${customerId}>` : "Unknown"}\n`;
      transcriptText += `Closed by: ${CLOSED_BY_ID}\n`;
      transcriptText += `${"─".repeat(60)}\n\n`;
      for (const msg of messages) {
        const t = new Date(msg.createdTimestamp).toISOString().replace("T", " ").replace("Z", "");
        const att = msg.attachments.size > 0 ? ` [+${msg.attachments.size} attachment(s)]` : "";
        transcriptText += `[${t}] ${msg.author.username}: ${msg.content || "(embed/no text)"}${att}\n`;
      }

      if (customerId) {
        try {
          const customer = await client.users.fetch(customerId);
          const buf = Buffer.from(transcriptText, "utf-8");
          const file = new AttachmentBuilder(buf, { name: `transcript-${channelName}.txt` });
          await customer.send({
            content:
              `⊱  ۫ ׅ ✧ {𝕾𝖞𝖘𝖙𝖊𝖒: 𝕿𝖗𝖆𝖓𝖘𝖈𝖗𝖎𝖕𝖙}\n` +
              `ׂ╰┈➤ Here's your Transcript from **__Dottorerium__** thank you for purchasing !\n\n` +
              `**Date**: ${dateStr}\n` +
              `**Opened by**: <@${customerId}>\n` +
              `**Closed by**: <@${CLOSED_BY_ID}>\n\n` +
              `ׂׂ╰┈ (see attached file)`,
            files: [file],
          });
        } catch {}
      }
    } catch (err) {
      console.error("Transcript error:", err);
    }

    stopAnimation(message.channel.id);
    orderData.delete(message.channel.id);
    statusMsgMap.delete(message.channel.id);
    await message.channel.delete().catch(() => {});
    return;
  }

  // ── Setup commands (owner only) ───────────────────────────────────────────
  if (message.author.id !== OWNER_ID) return;

  if (command === "verify-setup") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verify").setLabel("🗝️ 𝔙𝔢𝔯𝔦𝔣𝔶").setStyle(ButtonStyle.Primary)
    );
    return message.channel.send({
      content:
        `Welcome to **__Dottorerium__**\n` +
        `verify yourself to access\nthe whole server. Click the\n` +
        `　 🗝️ 𝔙𝔢𝔯𝔦𝔣𝔶 button below ↓`,
      components: [row],
    });
  }

  if (command === "ticket-setup") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("order_ticket").setLabel("✉︎ 𝕺𝖗𝖉𝖊𝖗").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("report_ticket").setLabel("⚠︎ 𝕽𝖊𝖕𝖔𝖗𝖙").setStyle(ButtonStyle.Danger),
    );
    return message.channel.send({
      content:
        `⋆˚࿔ 𝕿𝖎𝖈𝖐𝖊𝖙 𝕾𝖞𝖘𝖙𝖊𝖒 𝜗𝜚˚⋆\n` +
        `\` If you're going to order :\n\` — \` click Order button \`\n\n` +
        `\` If you're going to report a problem/someone :\n\` — \` click Report Button \`\n\n` +
        `**__notes!__**\n` +
        `- please don't create a order or report\nticket for fun or troll, you will get a warning\nif you do.`,
      components: [row],
    });
  }

  if (command === "inquiry-setup") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("order_ticket").setLabel("✉︎ Place Order").setStyle(ButtonStyle.Primary)
    );
    return message.channel.send({
      content:
        `please ping <@${OWNER_ID}> if you need assistance.\n` +
        `**do you want to place order?** Click the **__first__** button.`,
      components: [row],
    });
  }

  if (command === "vouch-setup") {
    return message.channel.send(
      `**Vouching format:** vouch @zi.venrwr  for ( **item** )\n\n` +
      `please  provide an __**image**__ as  proof\n` +
      `of the item,  do not  use the  image\n` +
      `we sent  to  you.  make sure to use\n` +
      `the  correct  format   for  warranty,\n` +
      `**__incorrect__** formats will get **__voided__**.\n\n` +
      `     âœ…  your vouch is correct`
    );
  }
});

// â”€â”€â”€ Button interactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  // â”€â”€ Verify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (interaction.customId === "verify") {
    const role = interaction.guild.roles.cache.get(VERIFIED_ROLE_ID);
    if (!role) return interaction.reply({ content: "âŒ Verified role not found.", ephemeral: true });
    if (interaction.member.roles.cache.has(VERIFIED_ROLE_ID))
      return interaction.reply({ content: "âœ… You are already verified!", ephemeral: true });
    await interaction.member.roles.add(role);
    return interaction.reply({ content: "âœ… You have been verified! Welcome to **Dottorerium**.", ephemeral: true });
  }

  // â”€â”€ Order ticket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (interaction.customId === "order_ticket") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = await interaction.guild.channels.create({
        name: `order-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: ORDER_CATEGORY,
        permissionOverwrites: [
          { id: interaction.guild.id,          deny:  [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id,           allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: interaction.client.user.id,    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: ORDER_PING_ROLE,               allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ],
      });
      await interaction.editReply({ content: `âœ… Your ticket has been created: ${channel}` });
      runOrderInterview(channel, interaction.user.id).catch(console.error);
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: "âŒ Could not create ticket. Check bot permissions." });
    }
    return;
  }

  // â”€â”€ Report ticket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (interaction.customId === "report_ticket") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = await interaction.guild.channels.create({
        name: `report-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: REPORT_CATEGORY,
        permissionOverwrites: [
          { id: interaction.guild.id,          deny:  [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id,           allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: interaction.client.user.id,    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: ORDER_PING_ROLE,               allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ],
      });
      await channel.send(
        `Â·:Â¨à¼º â™± ð‘ð„ððŽð‘ð“ ð‘ð„ð‚ð„ðˆð•ð„ðƒ â™± à¼»Â¨:Â·\n<@&${ORDER_PING_ROLE}>\n\n` +
        `Hello <@${interaction.user.id}>, please explain your issue and wait for a response.`
      );
      await interaction.editReply({ content: `âœ… Your report ticket: ${channel}` });
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: "âŒ Could not create ticket. Check bot permissions." });
    }
    return;
  }

  // â”€â”€ Order confirm Yes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (interaction.customId === "order_confirm_yes") {
    const state = orderData.get(interaction.channel.id);
    if (!state || interaction.user.id !== state.userId)
      return interaction.reply({ content: "âŒ This is not your order.", ephemeral: true });
    await interaction.update({ components: [] });
    await interaction.channel.send(`Okay Ma'am/Sir kindly ping <@${OWNER_ID}> for assistance!`);
    await postOrderLog(interaction.channel, state.userId, state.item, state.quantity, state.payment, interaction.guild);
    return;
  }

  // â”€â”€ Order confirm No â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (interaction.customId === "order_confirm_no") {
    const state = orderData.get(interaction.channel.id);
    if (!state || interaction.user.id !== state.userId)
      return interaction.reply({ content: "âŒ This is not your order.", ephemeral: true });
    await interaction.update({ components: [] });
    await interaction.channel.send(`Okay! Let's redo your order.`);
    runOrderInterview(interaction.channel, state.userId).catch(console.error);
    return;
  }
});

client.on("error", err => console.error("Discord error:", err));
client.login(TOKEN);
