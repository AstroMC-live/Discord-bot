/**
 * Single-file Discord bot (discord.js v14)
 *
 * Features:
 * - Slash commands: /ping, /staff, /ticket, /apply
 * - Config: /set ticket|application|applogs
 * - Auto-role on join
 * - Ticket channel creation with secure overwrites
 * - Ticket close button (staff or ticket owner)
 * - Applications channel flow w/ staff approve/deny
 * - Punishments: warns, autoban at 3 warns
 * - Anti-advertise: warn on links (non-staff), 3 ad-warns => permanent mute
 * - Caps spam automod: warn on excessive caps (non-staff)
 * - Mute system: removes roles, saves to SQLite, restores on /unmute
 *
 * Requirements:
 * - .env with BOT_TOKEN=...
 */

"use strict";

require("dotenv").config();

const { DatabaseSync } = require("node:sqlite");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ========= CONFIG (KEEP IDS) =========
const GUILD_ID = "1460760771268051059";
const TICKET_CATEGORY_ID = "1460924804424142973";
const AUTO_ROLE_ID = "1460922502263079052";
const MUTED_ROLE_ID = "1460922503437488138";
const APPLICATION_REVIEW_CHANNEL_ID = "1460965699215167643";

const STAFF_ROLE_IDS = [
  "1460922472328335404",
  "1460922482688131195",
  "1460922475746693120",
  "1460922483933970473",
];
// ====================================

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  // Fail fast so CI / hosting logs show the real issue immediately.
  throw new Error("Missing env var BOT_TOKEN. Put it in your .env file.");
}

// ---- SQLite (single-file persistence) ----
const db = new DatabaseSync("bot.sqlite");
try {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
} catch {
  // Ignore if PRAGMA fails on some platforms.
}

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  ticket_category_id TEXT,
  ticket_channel_id TEXT,
  application_category_id TEXT,
  application_channel_id TEXT,
  applogs_category_id TEXT,
  applogs_channel_id TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS user_punishments (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  warns    INTEGER NOT NULL DEFAULT 0,
  ad_warns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS mute_state (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  muted_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const stmtGetSettings = db.prepare(
  "SELECT * FROM guild_settings WHERE guild_id = ?"
);
const stmtUpsertSettings = db.prepare(`
INSERT INTO guild_settings (
  guild_id,
  ticket_category_id, ticket_channel_id,
  application_category_id, application_channel_id,
  applogs_category_id, applogs_channel_id
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(guild_id) DO UPDATE SET
  ticket_category_id=excluded.ticket_category_id,
  ticket_channel_id=excluded.ticket_channel_id,
  application_category_id=excluded.application_category_id,
  application_channel_id=excluded.application_channel_id,
  applogs_category_id=excluded.applogs_category_id,
  applogs_channel_id=excluded.applogs_channel_id
`);

const stmtGetPunish = db.prepare(
  "SELECT warns, ad_warns FROM user_punishments WHERE guild_id = ? AND user_id = ?"
);
const stmtUpsertPunish = db.prepare(`
INSERT INTO user_punishments (guild_id, user_id, warns, ad_warns)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, user_id) DO UPDATE SET
  warns=excluded.warns,
  ad_warns=excluded.ad_warns
`);
const stmtDeletePunish = db.prepare(
  "DELETE FROM user_punishments WHERE guild_id = ? AND user_id = ?"
);

const stmtGetMute = db.prepare(
  "SELECT roles_json, muted_at FROM mute_state WHERE guild_id = ? AND user_id = ?"
);
const stmtUpsertMute = db.prepare(`
INSERT INTO mute_state (guild_id, user_id, roles_json, muted_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, user_id) DO UPDATE SET
  roles_json=excluded.roles_json,
  muted_at=excluded.muted_at
`);
const stmtDeleteMute = db.prepare(
  "DELETE FROM mute_state WHERE guild_id = ? AND user_id = ?"
);

function getGuildSettings(guildId) {
  const row = stmtGetSettings.get(guildId);
  return (
    row ?? {
      guild_id: guildId,
      ticket_category_id: null,
      ticket_channel_id: null,
      application_category_id: null,
      application_channel_id: null,
      applogs_category_id: null,
      applogs_channel_id: null,
    }
  );
}

function saveGuildSettings(guildId, patch) {
  const current = getGuildSettings(guildId);
  const next = { ...current, ...patch, guild_id: guildId };
  stmtUpsertSettings.run(
    next.guild_id,
    next.ticket_category_id,
    next.ticket_channel_id,
    next.application_category_id,
    next.application_channel_id,
    next.applogs_category_id,
    next.applogs_channel_id
  );
  return next;
}

function getPunishment(guildId, userId) {
  const row = stmtGetPunish.get(guildId, userId);
  return row ?? { warns: 0, ad_warns: 0 };
}

function setPunishment(guildId, userId, warns, adWarns) {
  stmtUpsertPunish.run(guildId, userId, warns, adWarns);
  return { warns, ad_warns: adWarns };
}

function clearPunishment(guildId, userId) {
  stmtDeletePunish.run(guildId, userId);
  return { warns: 0, ad_warns: 0 };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required for automod (links/caps)
  ],
});

// ---- Helpers ----
function isStaff(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return member.roles.cache.some((r) => STAFF_ROLE_IDS.includes(r.id));
}

function getTicketOwnerIdFromChannel(channel) {
  // Expected: ticket-<userId>
  const m = /^ticket-(\d+)$/.exec(channel?.name ?? "");
  return m ? m[1] : null;
}

function getApplicationOwnerIdFromChannel(channel) {
  // Expected: application-<userId>
  const m = /^application-(\d+)$/.exec(channel?.name ?? "");
  return m ? m[1] : null;
}

function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🎫 Create a Ticket")
    .setDescription(
      [
        "Need help from staff?",
        "Click the button below to create a private support ticket.",
      ].join("\n")
    )
    .setColor(0x5865f2);
}

function buildApplyPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("📝 Apply Now (Moderator)")
    .setDescription(
      [
        "Want to join the team?",
        "Click the button below to apply for **Moderator**.",
      ].join("\n")
    )
    .setColor(0x57f287);
}

function buildDecisionEmbed(decision, staffUser, reason) {
  const approved = decision === "approved";
  return new EmbedBuilder()
    .setTitle(approved ? "✅ Application Approved" : "❌ Application Denied")
    .setDescription(
      [
        approved
          ? "Congratulations! Your application for **Moderator** has been approved."
          : "Your application for **Moderator** has been denied.",
        "",
        staffUser ? `Reviewed by: ${staffUser.tag}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setColor(approved ? 0x57f287 : 0xed4245)
    .setTimestamp();
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    console.error("❌ Interaction reply error:", err);
    return null;
  }
}

async function logToAppLogs(guild, content, embeds = []) {
  try {
    const settings = getGuildSettings(guild.id);
    const channelId = settings.applogs_channel_id;
    if (!channelId) return;
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !("send" in ch)) return;
    await ch.send({ content, embeds });
  } catch (err) {
    console.warn("⚠️ applogs send failed:", err);
  }
}

async function sendTicketPanelToChannel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_ticket_create")
      .setLabel("Create a Ticket")
      .setStyle(ButtonStyle.Primary)
  );
  await channel.send({ embeds: [buildTicketPanelEmbed()], components: [row] });
}

async function sendApplyPanelToChannel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_apply_open")
      .setLabel("Apply Now")
      .setStyle(ButtonStyle.Success)
  );
  await channel.send({ embeds: [buildApplyPanelEmbed()], components: [row] });
}

async function createTicketForUser(guild, user) {
  const settings = getGuildSettings(guild.id);
  const ticketCategoryId = settings.ticket_category_id || TICKET_CATEGORY_ID;

  // Ensure cache is populated enough to find existing channels reliably.
  try {
    await guild.channels.fetch();
  } catch {
    // ignore
  }

  const existing = guild.channels.cache.find(
    (c) => c.name === `ticket-${user.id}` && c.parentId === ticketCategoryId
  );
  if (existing) return { channel: existing, alreadyExisted: true };

  const channel = await guild.channels.create({
    name: `ticket-${user.id}`,
    type: ChannelType.GuildText,
    parent: ticketCategoryId,
    topic: `Ticket owner: ${user.tag} (${user.id})`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...STAFF_ROLE_IDS.map((id) => ({
        id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })),
    ],
  });

  const embed = new EmbedBuilder()
    .setTitle("🎫 Support Ticket")
    .setDescription(
      [
        `Hi ${user}, please describe your issue and staff will help you.`,
        "",
        "When you're done, you (or staff) can close the ticket with the button below.",
      ].join("\n")
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close ticket")
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `<@${user.id}>`,
    embeds: [embed],
    components: [row],
  });

  return { channel, alreadyExisted: false };
}

async function applyPermanentMute(member, reason) {
  const guild = member.guild;
  const mutedRole = guild.roles.cache.get(MUTED_ROLE_ID) ?? (await guild.roles.fetch(MUTED_ROLE_ID).catch(() => null));
  if (!mutedRole) throw new Error("Muted role not found.");

  // If already muted, do not overwrite stored roles unless empty.
  const existing = stmtGetMute.get(guild.id, member.id);
  if (!existing) {
    const rolesToSave = member.roles.cache
      .filter((r) => r.id !== guild.id && r.id !== MUTED_ROLE_ID && !r.managed)
      .map((r) => r.id);
    stmtUpsertMute.run(guild.id, member.id, JSON.stringify(rolesToSave), Date.now());
  }

  // Remove roles we can remove, then add muted role.
  const removable = member.roles.cache
    .filter((r) => r.id !== guild.id && r.id !== MUTED_ROLE_ID && !r.managed)
    .map((r) => r.id);
  if (removable.length) {
    await member.roles.remove(removable, reason).catch(() => null);
  }
  await member.roles.add(MUTED_ROLE_ID, reason);
}

async function removePermanentMute(member, reason) {
  const guild = member.guild;
  const row = stmtGetMute.get(guild.id, member.id);
  if (!row) {
    // Still remove muted role if present.
    await member.roles.remove(MUTED_ROLE_ID, reason).catch(() => null);
    return { restored: 0 };
  }

  let rolesToRestore = [];
  try {
    rolesToRestore = JSON.parse(row.roles_json) || [];
  } catch {
    rolesToRestore = [];
  }

  // Remove muted role first (optional order).
  await member.roles.remove(MUTED_ROLE_ID, reason).catch(() => null);

  // Restore roles that still exist and are not managed.
  const existingRoles = new Set(guild.roles.cache.map((r) => r.id));
  const filtered = rolesToRestore.filter((id) => existingRoles.has(id) && id !== guild.id && id !== MUTED_ROLE_ID);
  if (filtered.length) {
    await member.roles.add(filtered, reason).catch(() => null);
  }

  stmtDeleteMute.run(guild.id, member.id);
  return { restored: filtered.length };
}

async function addWarn(guild, userId, reason, source = "manual") {
  const p = getPunishment(guild.id, userId);
  const warns = (p.warns ?? 0) + 1;
  const adWarns = p.ad_warns ?? 0;
  setPunishment(guild.id, userId, warns, adWarns);

  await logToAppLogs(
    guild,
    `⚠️ Warn: <@${userId}> (warns=${warns}/3) | source=${source} | ${reason || "No reason"}`
  );

  // Auto-ban at 3 warns
  if (warns >= 3) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await guild.members.ban(userId, {
        reason: `Auto-ban: 3 warns. Last reason: ${reason || "No reason"}`,
      });
      await logToAppLogs(guild, `🔨 Auto-banned <@${userId}> (3 warns).`);
    } else {
      await guild.members.ban(userId, {
        reason: `Auto-ban: 3 warns (member not cached). Last reason: ${reason || "No reason"}`,
      });
      await logToAppLogs(guild, `🔨 Auto-banned <@${userId}> (3 warns).`);
    }
  }

  return warns;
}

async function addAdWarn(guild, userId, reason, source = "anti_advertise") {
  const p = getPunishment(guild.id, userId);
  const warns = p.warns ?? 0;
  const adWarns = (p.ad_warns ?? 0) + 1;
  setPunishment(guild.id, userId, warns, adWarns);

  await logToAppLogs(
    guild,
    `🚫 Ad-warn: <@${userId}> (ad_warns=${adWarns}/3) | source=${source} | ${reason || "No reason"}`
  );

  // 3 ad-warns => permanent mute
  if (adWarns >= 3) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await applyPermanentMute(member, `Permanent mute: 3 ad-warns. Last reason: ${reason || "No reason"}`);
      await logToAppLogs(guild, `🔇 Permanently muted <@${userId}> (3 ad-warns).`);
    }
  }

  return adWarns;
}

// ---- Slash commands ----
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Replies with Pong!"),
  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Ping all staff roles (staff only)"),
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Create a support ticket"),
  new SlashCommandBuilder()
    .setName("apply")
    .setDescription("Send a staff application"),
  new SlashCommandBuilder()
    .setName("set")
    .setDescription("Configure bot modules (staff only)")
    .addSubcommand((sc) =>
      sc
        .setName("ticket")
        .setDescription("Set ticket category and panel channel")
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Ticket category")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Ticket panel channel")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("application")
        .setDescription("Set application category and review channel")
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Application category")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Staff review channel (applications sent here)")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("applogs")
        .setDescription("Set application logs category and channel")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Logs channel")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Logs category")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
        )
    ),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user (staff only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User to warn").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings for a user (staff only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("clearwarns")
    .setDescription("Clear warnings for a user (staff only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Permanently mute a user (staff only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a user and restore roles (staff only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("User").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Show current config (staff only)"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands,
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Slash command registration failed:", err);
  }
});

// ---- Auto-role only ----
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.guild.id !== GUILD_ID) return;
    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (err) {
    console.error("❌ Auto-role error:", err);
  }
});

// ---- Automod (anti-advertise + caps spam) ----
const capsWarnCooldown = new Map(); // key: `${guildId}:${userId}` -> timestamp
function now() {
  return Date.now();
}

function looksLikeLink(content) {
  const text = content.toLowerCase();
  // Basic patterns: http(s), www, discord invites, and common TLDs.
  const re =
    /\bhttps?:\/\/\S+|\bwww\.\S+|\bdiscord\.gg\/\S+|\bdiscord\.com\/invite\/\S+|\b\S+\.(com|net|org|gg|io|xyz|info|no|se|dk|de|fr|uk)\b/;
  return re.test(text);
}

function isMostlyCaps(content) {
  const letters = content.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.75 && content.length >= 12;
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.inGuild()) return;
    if (message.author.bot) return;
    if (message.guild.id !== GUILD_ID) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;
    if (isStaff(member)) return;

    // Anti-advertise
    if (looksLikeLink(message.content)) {
      await message.delete().catch(() => null);
      const adWarns = await addAdWarn(
        message.guild,
        message.author.id,
        "Posting links / advertising is not allowed.",
        "anti_advertise"
      );
      const reply = await message.channel
        .send(`🚫 <@${message.author.id}> links are not allowed here. (ad-warns: ${adWarns}/3)`)
        .catch(() => null);
      if (reply) setTimeout(() => reply.delete().catch(() => null), 8000);
      return;
    }

    // Caps spam automod
    if (isMostlyCaps(message.content)) {
      const key = `${message.guild.id}:${message.author.id}`;
      const last = capsWarnCooldown.get(key) ?? 0;
      if (now() - last < 30_000) {
        // Still delete, but avoid warning spam.
        await message.delete().catch(() => null);
        return;
      }
      capsWarnCooldown.set(key, now());
      await message.delete().catch(() => null);
      const warns = await addWarn(
        message.guild,
        message.author.id,
        "Caps spam / excessive caps.",
        "caps_automod"
      );
      const reply = await message.channel
        .send(`⚠️ <@${message.author.id}> please avoid caps spam. (warns: ${warns}/3)`)
        .catch(() => null);
      if (reply) setTimeout(() => reply.delete().catch(() => null), 8000);
    }
  } catch (err) {
    console.error("❌ Automod error:", err);
  }
});

// ---- Interactions ----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button: close ticket
    if (interaction.isButton()) {
      if (interaction.customId === "ticket_close") {
        if (!interaction.inGuild()) {
          return safeReply(interaction, {
            content: "❌ This button can only be used in a server.",
            ephemeral: true,
          });
        }

        const channel = interaction.channel;
        const ownerId = getTicketOwnerIdFromChannel(channel);
        const member = interaction.member;
        const allowed =
          isStaff(member) || (ownerId && interaction.user.id === ownerId);

        if (!allowed) {
          return safeReply(interaction, {
            content: "❌ You are not allowed to close this ticket.",
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });
        await channel.delete("Ticket closed via button");
        return;
      }

      // Panel button: create ticket
      if (interaction.customId === "panel_ticket_create") {
        if (!interaction.inGuild()) {
          return safeReply(interaction, {
            content: "❌ This button can only be used in a server.",
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });
        const { channel, alreadyExisted } = await createTicketForUser(
          interaction.guild,
          interaction.user
        );
        return safeReply(interaction, {
          content: alreadyExisted
            ? `❗ You already have an open ticket: ${channel}`
            : `✅ Your ticket has been created: ${channel}`,
          ephemeral: true,
        });
      }

      // Panel button: open application modal
      if (interaction.customId === "panel_apply_open") {
        if (!interaction.inGuild()) {
          return safeReply(interaction, {
            content: "❌ This button can only be used in a server.",
            ephemeral: true,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId("application_modal")
          .setTitle("Moderator Application");

        const age = new TextInputBuilder()
          .setCustomId("age")
          .setLabel("Age")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3);

        const experience = new TextInputBuilder()
          .setCustomId("experience")
          .setLabel("Experience (short)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        const why = new TextInputBuilder()
          .setCustomId("why")
          .setLabel("Why do you want to be a Moderator?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(
          new ActionRowBuilder().addComponents(age),
          new ActionRowBuilder().addComponents(experience),
          new ActionRowBuilder().addComponents(why)
        );

        await interaction.showModal(modal);
        return;
      }

      // Application approve/deny
      if (interaction.customId.startsWith("app_")) {
        if (!interaction.inGuild()) {
          return safeReply(interaction, {
            content: "❌ This button can only be used in a server.",
            ephemeral: true,
          });
        }
        if (!isStaff(interaction.member)) {
          return safeReply(interaction, {
            content: "❌ Staff only.",
            ephemeral: true,
          });
        }

        const parts = interaction.customId.split(":"); // app_action:userId:channelId
        const action = parts[0]; // app_approve / app_deny / app_close
        const userId = parts[1];
        const channelId = parts[2];
        const guild = interaction.guild;

        const targetMember = await guild.members.fetch(userId).catch(() => null);
        const appChannel = await guild.channels.fetch(channelId).catch(() => null);

        await interaction.deferReply({ ephemeral: true });

        if (action === "app_approve") {
          if (targetMember) {
            await targetMember
              .send({
                embeds: [
                  buildDecisionEmbed(
                    "approved",
                    interaction.user,
                    "You have been accepted as Moderator."
                  ),
                ],
              })
              .catch(() => null);
          }
          await logToAppLogs(guild, `✅ Application approved for <@${userId}> by <@${interaction.user.id}>.`);
          if (appChannel && "delete" in appChannel) await appChannel.delete("Application approved").catch(() => null);
          return;
        }

        if (action === "app_deny") {
          if (targetMember) {
            await targetMember
              .send({
                embeds: [buildDecisionEmbed("denied", interaction.user)],
              })
              .catch(() => null);
          }
          await logToAppLogs(guild, `❌ Application denied for <@${userId}> by <@${interaction.user.id}>.`);
          if (appChannel && "delete" in appChannel) await appChannel.delete("Application denied").catch(() => null);
          return;
        }

        if (action === "app_close") {
          await logToAppLogs(guild, `🗑️ Application closed for <@${userId}> by <@${interaction.user.id}>.`);
          if (appChannel && "delete" in appChannel) await appChannel.delete("Application closed").catch(() => null);
          return;
        }
      }

      return;
    }

    // Modal submit: application
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== "application_modal") return;
      if (!interaction.inGuild()) {
        return safeReply(interaction, {
          content: "❌ This can only be used in a server.",
          ephemeral: true,
        });
      }

      const guild = interaction.guild;
      const user = interaction.user;
      const settings = getGuildSettings(guild.id);

      const appCategoryId = settings.application_category_id;
      if (!appCategoryId) {
        return safeReply(interaction, {
          content:
            "❌ Applications are not configured. Staff must run `/set application` first.",
          ephemeral: true,
        });
      }

      // Ensure cache is populated enough to find existing channels reliably.
      try {
        await guild.channels.fetch();
      } catch {
        // ignore
      }

      const existing = guild.channels.cache.find(
        (c) => c.name === `application-${user.id}` && c.parentId === appCategoryId
      );
      if (existing) {
        return safeReply(interaction, {
          content: `❗ You already have an open application: ${existing}`,
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const age = interaction.fields.getTextInputValue("age");
      const exp = interaction.fields.getTextInputValue("experience");
      const why = interaction.fields.getTextInputValue("why");

      const appChannel = await guild.channels.create({
        name: `application-${user.id}`,
        type: ChannelType.GuildText,
        parent: appCategoryId,
        topic: `Application owner: ${user.tag} (${user.id})`,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          ...STAFF_ROLE_IDS.map((id) => ({
            id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          })),
        ],
      });

      const embed = new EmbedBuilder()
        .setTitle("📝 New Application")
        .setColor(0x3498db)
        .addFields(
          { name: "User", value: `<@${user.id}> (${user.tag})`, inline: false },
          { name: "Age", value: age || "N/A", inline: true },
          { name: "Experience", value: exp || "N/A", inline: false },
          { name: "Why staff?", value: why || "N/A", inline: false }
        )
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`app_approve:${user.id}:${appChannel.id}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`app_deny:${user.id}:${appChannel.id}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`app_close:${user.id}:${appChannel.id}`)
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary)
      );

      await appChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: [row] });

      const reviewChannel = await guild.channels
        .fetch(APPLICATION_REVIEW_CHANNEL_ID)
        .catch(() => null);
      if (reviewChannel && "send" in reviewChannel) {
        await reviewChannel.send({
          content: `📝 New application from <@${user.id}> in ${appChannel}`,
          embeds: [embed],
          components: [row],
          allowedMentions: { users: [user.id] },
        });
      }

      await logToAppLogs(guild, `📝 Application submitted by <@${user.id}> (${user.tag}).`, [embed]);

      return safeReply(interaction, {
        content: `✅ Your application has been created: ${appChannel}`,
        ephemeral: true,
      });
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      return safeReply(interaction, {
        content: "❌ Commands can only be used in a server.",
        ephemeral: true,
      });
    }

    // /ping
    if (interaction.commandName === "ping") {
      return safeReply(interaction, "🏓 Pong!");
    }

    // /staff (staff only)
    if (interaction.commandName === "staff") {
      const member = interaction.member;
      if (!isStaff(member)) {
        return safeReply(interaction, {
          content: "❌ You are not allowed to use this command.",
          ephemeral: true,
        });
      }

      const mentions = STAFF_ROLE_IDS.map((id) => `<@&${id}>`).join(" ");
      return safeReply(interaction, {
        content: `🚨 **Staff Notification** 🚨\n${mentions}`,
        allowedMentions: { roles: STAFF_ROLE_IDS },
      });
    }

    // /ticket
    if (interaction.commandName === "ticket") {
      const guild = interaction.guild;
      const user = interaction.user;
      await interaction.deferReply({ ephemeral: true });
      const { channel, alreadyExisted } = await createTicketForUser(guild, user);
      return safeReply(interaction, {
        content: alreadyExisted
          ? `❗ You already have an open ticket: ${channel}`
          : `✅ Your ticket has been created: ${channel}`,
        ephemeral: true,
      });
    }

    // /apply
    if (interaction.commandName === "apply") {
      // Show modal for application content
      const modal = new ModalBuilder()
        .setCustomId("application_modal")
        .setTitle("Moderator Application");

      const age = new TextInputBuilder()
        .setCustomId("age")
        .setLabel("Age")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3);

      const experience = new TextInputBuilder()
        .setCustomId("experience")
        .setLabel("Experience (short)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const why = new TextInputBuilder()
        .setCustomId("why")
        .setLabel("Why do you want to be a Moderator?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(
        new ActionRowBuilder().addComponents(age),
        new ActionRowBuilder().addComponents(experience),
        new ActionRowBuilder().addComponents(why)
      );

      await interaction.showModal(modal);
      return;
    }

    // /set ... (staff only)
    if (interaction.commandName === "set") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, {
          content: "❌ Staff only.",
          ephemeral: true,
        });
      }

      const sub = interaction.options.getSubcommand();
      const guild = interaction.guild;

      if (sub === "ticket") {
        const category = interaction.options.getChannel("category", true);
        const channel = interaction.options.getChannel("channel", true);
        const next = saveGuildSettings(guild.id, {
          ticket_category_id: category.id,
          ticket_channel_id: channel.id,
        });
        try {
          await sendTicketPanelToChannel(channel);
        } catch (err) {
          console.warn("⚠️ Could not send ticket panel:", err);
        }
        return safeReply(interaction, {
          content: `✅ Ticket settings saved.\nCategory: <#${next.ticket_category_id}>\nPanel channel: <#${next.ticket_channel_id}>\n\nI posted the **Create a Ticket** panel embed in the panel channel.`,
          ephemeral: true,
        });
      }

      if (sub === "application") {
        const category = interaction.options.getChannel("category", true);
        const channel = interaction.options.getChannel("channel", true);
        const next = saveGuildSettings(guild.id, {
          application_category_id: category.id,
          application_channel_id: channel.id,
        });
        try {
          await sendApplyPanelToChannel(channel);
        } catch (err) {
          console.warn("⚠️ Could not send apply panel:", err);
        }
        return safeReply(interaction, {
          content: `✅ Application settings saved.\nCategory: <#${next.application_category_id}>\nPanel channel: <#${next.application_channel_id}>\nReview channel: <#${APPLICATION_REVIEW_CHANNEL_ID}>\n\nI posted the **Apply Now (Moderator)** panel embed in the panel channel.`,
          ephemeral: true,
        });
      }

      if (sub === "applogs") {
        const channel = interaction.options.getChannel("channel", true);
        const category = interaction.options.getChannel("category", true);
        const next = saveGuildSettings(guild.id, {
          applogs_channel_id: channel.id,
          applogs_category_id: category.id,
        });
        return safeReply(interaction, {
          content: `✅ Application logs settings saved.\nCategory: <#${next.applogs_category_id}>\nLogs channel: <#${next.applogs_channel_id}>`,
          ephemeral: true,
        });
      }
    }

    // /config (staff only)
    if (interaction.commandName === "config") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const s = getGuildSettings(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Bot Config")
        .setColor(0xf1c40f)
        .addFields(
          {
            name: "Tickets",
            value: [
              `Category: ${s.ticket_category_id ? `<#${s.ticket_category_id}>` : "(default)"}`,
              `Channel: ${s.ticket_channel_id ? `<#${s.ticket_channel_id}>` : "(not set)"}`,
            ].join("\n"),
          },
          {
            name: "Applications",
            value: [
              `Category: ${s.application_category_id ? `<#${s.application_category_id}>` : "(not set)"}`,
              `Panel channel: ${s.application_channel_id ? `<#${s.application_channel_id}>` : "(not set)"}`,
              `Review channel: <#${APPLICATION_REVIEW_CHANNEL_ID}>`,
            ].join("\n"),
          },
          {
            name: "App logs",
            value: [
              `Category: ${s.applogs_category_id ? `<#${s.applogs_category_id}>` : "(not set)"}`,
              `Logs channel: ${s.applogs_channel_id ? `<#${s.applogs_channel_id}>` : "(not set)"}`,
            ].join("\n"),
          }
        );
      return safeReply(interaction, { embeds: [embed], ephemeral: true });
    }

    // /warn (staff only)
    if (interaction.commandName === "warn") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const warns = await addWarn(interaction.guild, user.id, reason, "manual");
      return safeReply(interaction, {
        content: `✅ Warned <@${user.id}>. (warns: ${warns}/3)`,
        ephemeral: true,
      });
    }

    // /warnings (staff only)
    if (interaction.commandName === "warnings") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const user = interaction.options.getUser("user", true);
      const p = getPunishment(interaction.guild.id, user.id);
      return safeReply(interaction, {
        content: `Warnings for <@${user.id}>:\n- warns: ${p.warns ?? 0}/3\n- ad-warns: ${p.ad_warns ?? 0}/3`,
        ephemeral: true,
      });
    }

    // /clearwarns (staff only)
    if (interaction.commandName === "clearwarns") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const user = interaction.options.getUser("user", true);
      clearPunishment(interaction.guild.id, user.id);
      await logToAppLogs(interaction.guild, `🧽 Cleared warnings for <@${user.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, {
        content: `✅ Cleared warnings for <@${user.id}>.`,
        ephemeral: true,
      });
    }

    // /mute (staff only)
    if (interaction.commandName === "mute") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      }
      await applyPermanentMute(member, `Manual mute by ${interaction.user.tag}: ${reason}`);
      await logToAppLogs(interaction.guild, `🔇 Muted <@${user.id}> by <@${interaction.user.id}> | ${reason}`);
      return safeReply(interaction, { content: `✅ Muted <@${user.id}>.`, ephemeral: true });
    }

    // /unmute (staff only)
    if (interaction.commandName === "unmute") {
      if (!isStaff(interaction.member)) {
        return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
      }
      const user = interaction.options.getUser("user", true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      }
      const res = await removePermanentMute(member, `Unmute by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `🔈 Unmuted <@${user.id}> by <@${interaction.user.id}> (restored roles: ${res.restored}).`);
      return safeReply(interaction, {
        content: `✅ Unmuted <@${user.id}>. Restored roles: ${res.restored}`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("❌ Interaction handler error:", err);
    // Best-effort response; avoid throwing inside the event.
    if (interaction?.isRepliable?.()) {
      await safeReply(interaction, {
        content: "❌ Something went wrong. Please try again.",
        ephemeral: true,
      });
    }
  }
});

// ---- Process-level safety ----
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
});

client.login(BOT_TOKEN);

