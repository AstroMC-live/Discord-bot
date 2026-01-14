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

const Database = require("better-sqlite3");

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
const db = new Database("bot.sqlite");
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
  applogs_channel_id TEXT,
  automod_link_enabled INTEGER NOT NULL DEFAULT 1,
  automod_link_action TEXT NOT NULL DEFAULT 'adwarn',
  automod_link_delete INTEGER NOT NULL DEFAULT 1,
  automod_caps_enabled INTEGER NOT NULL DEFAULT 1,
  automod_caps_ratio REAL NOT NULL DEFAULT 0.75,
  automod_caps_min_letters INTEGER NOT NULL DEFAULT 8,
  automod_caps_min_len INTEGER NOT NULL DEFAULT 12,
  automod_caps_cooldown_ms INTEGER NOT NULL DEFAULT 30000,
  autoban_warn_threshold INTEGER NOT NULL DEFAULT 3,
  adwarn_mute_threshold INTEGER NOT NULL DEFAULT 3
);
`);

function ensureColumn(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  } catch {
    // Column likely exists already.
  }
}

// Backfill columns for older DBs
ensureColumn("guild_settings", "automod_link_enabled INTEGER NOT NULL DEFAULT 1");
ensureColumn("guild_settings", "automod_link_action TEXT NOT NULL DEFAULT 'adwarn'");
ensureColumn("guild_settings", "automod_link_delete INTEGER NOT NULL DEFAULT 1");
ensureColumn("guild_settings", "automod_caps_enabled INTEGER NOT NULL DEFAULT 1");
ensureColumn("guild_settings", "automod_caps_ratio REAL NOT NULL DEFAULT 0.75");
ensureColumn("guild_settings", "automod_caps_min_letters INTEGER NOT NULL DEFAULT 8");
ensureColumn("guild_settings", "automod_caps_min_len INTEGER NOT NULL DEFAULT 12");
ensureColumn("guild_settings", "automod_caps_cooldown_ms INTEGER NOT NULL DEFAULT 30000");
ensureColumn("guild_settings", "autoban_warn_threshold INTEGER NOT NULL DEFAULT 3");
ensureColumn("guild_settings", "adwarn_mute_threshold INTEGER NOT NULL DEFAULT 3");

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

db.exec(`
CREATE TABLE IF NOT EXISTS channel_locks (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  locked_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS user_notes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
  applogs_category_id, applogs_channel_id,
  automod_link_enabled, automod_link_action, automod_link_delete,
  automod_caps_enabled, automod_caps_ratio, automod_caps_min_letters, automod_caps_min_len, automod_caps_cooldown_ms,
  autoban_warn_threshold, adwarn_mute_threshold
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(guild_id) DO UPDATE SET
  ticket_category_id=excluded.ticket_category_id,
  ticket_channel_id=excluded.ticket_channel_id,
  application_category_id=excluded.application_category_id,
  application_channel_id=excluded.application_channel_id,
  applogs_category_id=excluded.applogs_category_id,
  applogs_channel_id=excluded.applogs_channel_id,
  automod_link_enabled=excluded.automod_link_enabled,
  automod_link_action=excluded.automod_link_action,
  automod_link_delete=excluded.automod_link_delete,
  automod_caps_enabled=excluded.automod_caps_enabled,
  automod_caps_ratio=excluded.automod_caps_ratio,
  automod_caps_min_letters=excluded.automod_caps_min_letters,
  automod_caps_min_len=excluded.automod_caps_min_len,
  automod_caps_cooldown_ms=excluded.automod_caps_cooldown_ms,
  autoban_warn_threshold=excluded.autoban_warn_threshold,
  adwarn_mute_threshold=excluded.adwarn_mute_threshold
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

const stmtLockChannel = db.prepare(
  "INSERT INTO channel_locks (guild_id, channel_id, locked_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET locked_at=excluded.locked_at"
);
const stmtUnlockChannel = db.prepare(
  "DELETE FROM channel_locks WHERE guild_id = ? AND channel_id = ?"
);
const stmtIsLocked = db.prepare(
  "SELECT locked_at FROM channel_locks WHERE guild_id = ? AND channel_id = ?"
);

const stmtAddNote = db.prepare(
  "INSERT INTO user_notes (guild_id, user_id, note, staff_id, created_at) VALUES (?, ?, ?, ?, ?)"
);
const stmtGetNotes = db.prepare(
  "SELECT note, staff_id, created_at FROM user_notes WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?"
);
const stmtClearNotes = db.prepare(
  "DELETE FROM user_notes WHERE guild_id = ? AND user_id = ?"
);

const settingsCache = new Map(); // guildId -> { ts, value }
const SETTINGS_TTL_MS = 10_000;

function getGuildSettings(guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && Date.now() - cached.ts < SETTINGS_TTL_MS) return cached.value;

  const row = stmtGetSettings.get(guildId);
  const value =
    row ?? {
      guild_id: guildId,
      ticket_category_id: null,
      ticket_channel_id: null,
      application_category_id: null,
      application_channel_id: null,
      applogs_category_id: null,
      applogs_channel_id: null,
      automod_link_enabled: 1,
      automod_link_action: "adwarn",
      automod_link_delete: 1,
      automod_caps_enabled: 1,
      automod_caps_ratio: 0.75,
      automod_caps_min_letters: 8,
      automod_caps_min_len: 12,
      automod_caps_cooldown_ms: 30000,
      autoban_warn_threshold: 3,
      adwarn_mute_threshold: 3,
    };

  settingsCache.set(guildId, { ts: Date.now(), value });
  return value;
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
    next.applogs_channel_id,
    Number(next.automod_link_enabled ?? 1),
    String(next.automod_link_action ?? "adwarn"),
    Number(next.automod_link_delete ?? 1),
    Number(next.automod_caps_enabled ?? 1),
    Number(next.automod_caps_ratio ?? 0.75),
    Number(next.automod_caps_min_letters ?? 8),
    Number(next.automod_caps_min_len ?? 12),
    Number(next.automod_caps_cooldown_ms ?? 30000),
    Number(next.autoban_warn_threshold ?? 3),
    Number(next.adwarn_mute_threshold ?? 3)
  );
  settingsCache.set(guildId, { ts: Date.now(), value: next });
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

  // Auto-ban at configured threshold
  const threshold = Number(getGuildSettings(guild.id).autoban_warn_threshold ?? 3);
  if (warns >= threshold) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await guild.members.ban(userId, {
        reason: `Auto-ban: ${threshold} warns. Last reason: ${reason || "No reason"}`,
      });
      await logToAppLogs(guild, `🔨 Auto-banned <@${userId}> (${threshold} warns).`);
    } else {
      await guild.members.ban(userId, {
        reason: `Auto-ban: ${threshold} warns (member not cached). Last reason: ${reason || "No reason"}`,
      });
      await logToAppLogs(guild, `🔨 Auto-banned <@${userId}> (${threshold} warns).`);
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

  // ad-warns => permanent mute at configured threshold
  const threshold = Number(getGuildSettings(guild.id).adwarn_mute_threshold ?? 3);
  if (adWarns >= threshold) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await applyPermanentMute(member, `Permanent mute: ${threshold} ad-warns. Last reason: ${reason || "No reason"}`);
      await logToAppLogs(guild, `🔇 Permanently muted <@${userId}> (${threshold} ad-warns).`);
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
    )
    .addSubcommand((sc) =>
      sc
        .setName("automod_links")
        .setDescription("Configure link/advertise automod")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("Enable link detection").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("What to do when links are posted")
            .setRequired(true)
            .addChoices(
              { name: "ad-warn (default)", value: "adwarn" },
              { name: "warn", value: "warn" }
            )
        )
        .addBooleanOption((o) =>
          o
            .setName("delete")
            .setDescription("Delete link messages")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("automod_caps")
        .setDescription("Configure caps automod")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("Enable caps detection").setRequired(true)
        )
        .addNumberOption((o) =>
          o
            .setName("ratio")
            .setDescription("Caps ratio threshold (0.50 - 1.00)")
            .setRequired(true)
            .setMinValue(0.5)
            .setMaxValue(1.0)
        )
        .addIntegerOption((o) =>
          o
            .setName("min_letters")
            .setDescription("Minimum letters to trigger (e.g. 8)")
            .setRequired(true)
            .setMinValue(4)
            .setMaxValue(50)
        )
        .addIntegerOption((o) =>
          o
            .setName("min_len")
            .setDescription("Minimum message length to trigger (e.g. 12)")
            .setRequired(true)
            .setMinValue(6)
            .setMaxValue(200)
        )
        .addIntegerOption((o) =>
          o
            .setName("cooldown_seconds")
            .setDescription("Cooldown per user between caps punishments")
            .setRequired(true)
            .setMinValue(5)
            .setMaxValue(600)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("punishments")
        .setDescription("Configure warning thresholds")
        .addIntegerOption((o) =>
          o
            .setName("autoban_warns")
            .setDescription("Warns needed for auto-ban")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20)
        )
        .addIntegerOption((o) =>
          o
            .setName("adwarns_to_mute")
            .setDescription("Ad-warns needed for permanent mute")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20)
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

  // --- Staff utility commands ---
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false))
    .addIntegerOption((o) =>
      o
        .setName("delete_days")
        .setDescription("Delete message history (0-7 days)")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(7)
    ),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by ID (staff only)")
    .addStringOption((o) =>
      o.setName("user_id").setDescription("User ID").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("minutes")
        .setDescription("Minutes (1-10080)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(10080)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove timeout from a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages (staff only)")
    .addIntegerOption((o) =>
      o
        .setName("amount")
        .setDescription("How many (1-100)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addUserOption((o) =>
      o.setName("user").setDescription("Only delete from this user").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode (staff only)")
    .addIntegerOption((o) =>
      o
        .setName("seconds")
        .setDescription("Seconds (0-21600)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600)
    ),
  new SlashCommandBuilder().setName("lock").setDescription("Lock the current channel (staff only)"),
  new SlashCommandBuilder().setName("unlock").setDescription("Unlock the current channel (staff only)"),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement embed (staff only)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Target channel")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption((o) =>
      o.setName("title").setDescription("Title").setRequired(true).setMaxLength(256)
    )
    .addStringOption((o) =>
      o.setName("message").setDescription("Message").setRequired(true).setMaxLength(4000)
    ),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot send a message (staff only)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Target channel")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption((o) =>
      o.setName("message").setDescription("Message").setRequired(true).setMaxLength(2000)
    ),
  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add a role to a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove a role from a user (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Change a user's nickname (staff only)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) =>
      o.setName("nickname").setDescription("New nickname (empty clears)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("infractions")
    .setDescription("View or reset a user's infractions (staff only)")
    .addSubcommand((sc) =>
      sc
        .setName("view")
        .setDescription("View warns/ad-warns")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("reset")
        .setDescription("Reset warns/ad-warns")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("pardon")
        .setDescription("Remove N warns")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(20)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("pardon_ad")
        .setDescription("Remove N ad-warns")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(20)
        )
    ),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Staff notes for a user (staff only)")
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Add a note")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption((o) =>
          o.setName("text").setDescription("Note text").setRequired(true).setMaxLength(1000)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List last notes")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("limit").setDescription("How many (1-10)").setRequired(false).setMinValue(1).setMaxValue(10)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription("Clear notes")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    ),
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
  // Caller applies thresholds.
  if (letters.length < 1) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length;
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.inGuild()) return;
    if (message.author.bot) return;
    if (message.guild.id !== GUILD_ID) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;
    if (isStaff(member)) return;

    const settings = getGuildSettings(message.guild.id);

    // Anti-advertise
    if (Number(settings.automod_link_enabled ?? 1) === 1 && looksLikeLink(message.content)) {
      if (Number(settings.automod_link_delete ?? 1) === 1) {
        await message.delete().catch(() => null);
      }

      const action = String(settings.automod_link_action ?? "adwarn");
      if (action === "warn") {
        const warns = await addWarn(
          message.guild,
          message.author.id,
          "Posting links / advertising is not allowed.",
          "anti_advertise"
        );
        const threshold = Number(getGuildSettings(message.guild.id).autoban_warn_threshold ?? 3);
        const reply = await message.channel
          .send(`🚫 <@${message.author.id}> links are not allowed here. (warns: ${warns}/${threshold})`)
          .catch(() => null);
        if (reply) setTimeout(() => reply.delete().catch(() => null), 8000);
      } else {
        const adWarns = await addAdWarn(
          message.guild,
          message.author.id,
          "Posting links / advertising is not allowed.",
          "anti_advertise"
        );
        const th = Number(getGuildSettings(message.guild.id).adwarn_mute_threshold ?? 3);
        const reply = await message.channel
          .send(`🚫 <@${message.author.id}> links are not allowed here. (ad-warns: ${adWarns}/${th})`)
          .catch(() => null);
        if (reply) setTimeout(() => reply.delete().catch(() => null), 8000);
      }
      return;
    }

    // Caps spam automod
    if (Number(settings.automod_caps_enabled ?? 1) === 1) {
      const ratio = Number(settings.automod_caps_ratio ?? 0.75);
      const minLetters = Number(settings.automod_caps_min_letters ?? 8);
      const minLen = Number(settings.automod_caps_min_len ?? 12);
      const cooldownMs = Number(settings.automod_caps_cooldown_ms ?? 30000);

      const lettersOnly = message.content.replace(/[^a-zA-Z]/g, "");
      const capsRatio = isMostlyCaps(message.content);
      const shouldTrigger =
        lettersOnly.length >= minLetters &&
        message.content.length >= minLen &&
        capsRatio >= ratio;

      if (!shouldTrigger) return;

      const key = `${message.guild.id}:${message.author.id}`;
      const last = capsWarnCooldown.get(key) ?? 0;
      if (now() - last < cooldownMs) {
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
      const threshold = Number(getGuildSettings(message.guild.id).autoban_warn_threshold ?? 3);
      const reply = await message.channel
        .send(`⚠️ <@${message.author.id}> please avoid caps spam. (warns: ${warns}/${threshold})`)
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

    // --- Staff gate for staff utility commands ---
    const staffOnlyCommands = new Set([
      "set",
      "config",
      "warn",
      "warnings",
      "clearwarns",
      "mute",
      "unmute",
      "ban",
      "unban",
      "kick",
      "timeout",
      "untimeout",
      "purge",
      "slowmode",
      "lock",
      "unlock",
      "announce",
      "say",
      "addrole",
      "removerole",
      "nick",
      "infractions",
      "note",
    ]);
    if (staffOnlyCommands.has(interaction.commandName) && !isStaff(interaction.member)) {
      return safeReply(interaction, { content: "❌ Staff only.", ephemeral: true });
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

      if (sub === "automod_links") {
        const enabled = interaction.options.getBoolean("enabled", true);
        const action = interaction.options.getString("action", true);
        const del = interaction.options.getBoolean("delete", true);
        const next = saveGuildSettings(guild.id, {
          automod_link_enabled: enabled ? 1 : 0,
          automod_link_action: action,
          automod_link_delete: del ? 1 : 0,
        });
        return safeReply(interaction, {
          content:
            `✅ Link automod saved.\n` +
            `Enabled: ${next.automod_link_enabled ? "Yes" : "No"}\n` +
            `Action: ${next.automod_link_action}\n` +
            `Delete: ${next.automod_link_delete ? "Yes" : "No"}`,
          ephemeral: true,
        });
      }

      if (sub === "automod_caps") {
        const enabled = interaction.options.getBoolean("enabled", true);
        const ratio = interaction.options.getNumber("ratio", true);
        const minLetters = interaction.options.getInteger("min_letters", true);
        const minLen = interaction.options.getInteger("min_len", true);
        const cooldownSeconds = interaction.options.getInteger("cooldown_seconds", true);
        const next = saveGuildSettings(guild.id, {
          automod_caps_enabled: enabled ? 1 : 0,
          automod_caps_ratio: ratio,
          automod_caps_min_letters: minLetters,
          automod_caps_min_len: minLen,
          automod_caps_cooldown_ms: cooldownSeconds * 1000,
        });
        return safeReply(interaction, {
          content:
            `✅ Caps automod saved.\n` +
            `Enabled: ${next.automod_caps_enabled ? "Yes" : "No"}\n` +
            `Ratio: ${next.automod_caps_ratio}\n` +
            `Min letters: ${next.automod_caps_min_letters}\n` +
            `Min length: ${next.automod_caps_min_len}\n` +
            `Cooldown: ${Math.round(next.automod_caps_cooldown_ms / 1000)}s`,
          ephemeral: true,
        });
      }

      if (sub === "punishments") {
        const autobanWarns = interaction.options.getInteger("autoban_warns", true);
        const adWarnsToMute = interaction.options.getInteger("adwarns_to_mute", true);
        const next = saveGuildSettings(guild.id, {
          autoban_warn_threshold: autobanWarns,
          adwarn_mute_threshold: adWarnsToMute,
        });
        return safeReply(interaction, {
          content:
            `✅ Punishment thresholds saved.\n` +
            `Auto-ban warns: ${next.autoban_warn_threshold}\n` +
            `Permanent mute ad-warns: ${next.adwarn_mute_threshold}`,
          ephemeral: true,
        });
      }
    }

    // /config (staff only)
    if (interaction.commandName === "config") {
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
          },
          {
            name: "Automod",
            value: [
              `Links: ${s.automod_link_enabled ? "On" : "Off"} (action=${s.automod_link_action}, delete=${s.automod_link_delete ? "Yes" : "No"})`,
              `Caps: ${s.automod_caps_enabled ? "On" : "Off"} (ratio=${s.automod_caps_ratio}, minLetters=${s.automod_caps_min_letters}, minLen=${s.automod_caps_min_len}, cooldown=${Math.round((s.automod_caps_cooldown_ms ?? 30000) / 1000)}s)`,
              `Auto-ban warns: ${s.autoban_warn_threshold ?? 3}`,
              `Permanent mute ad-warns: ${s.adwarn_mute_threshold ?? 3}`,
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
      const user = interaction.options.getUser("user", true);
      const p = getPunishment(interaction.guild.id, user.id);
      const s = getGuildSettings(interaction.guild.id);
      return safeReply(interaction, {
        content:
          `Infractions for <@${user.id}>:\n` +
          `- warns: ${p.warns ?? 0}/${s.autoban_warn_threshold ?? 3}\n` +
          `- ad-warns: ${p.ad_warns ?? 0}/${s.adwarn_mute_threshold ?? 3}`,
        ephemeral: true,
      });
    }

    // /clearwarns (staff only)
    if (interaction.commandName === "clearwarns") {
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

    // --- New staff utility commands ---
    if (interaction.commandName === "ban") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const deleteDays = interaction.options.getInteger("delete_days") ?? 0;
      await interaction.guild.members.ban(user.id, {
        reason: `Ban by ${interaction.user.tag}: ${reason}`,
        deleteMessageSeconds: deleteDays * 86400,
      });
      await logToAppLogs(interaction.guild, `🔨 Banned <@${user.id}> by <@${interaction.user.id}> | ${reason}`);
      return safeReply(interaction, { content: `✅ Banned <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === "unban") {
      const userId = interaction.options.getString("user_id", true);
      await interaction.guild.bans.remove(userId, `Unban by ${interaction.user.tag}`).catch((e) => {
        throw e;
      });
      await logToAppLogs(interaction.guild, `✅ Unbanned <@${userId}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Unbanned \`${userId}\`.`, ephemeral: true });
    }

    if (interaction.commandName === "kick") {
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.kick(`Kick by ${interaction.user.tag}: ${reason}`);
      await logToAppLogs(interaction.guild, `👢 Kicked <@${user.id}> by <@${interaction.user.id}> | ${reason}`);
      return safeReply(interaction, { content: `✅ Kicked <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === "timeout") {
      const user = interaction.options.getUser("user", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.timeout(minutes * 60_000, `Timeout by ${interaction.user.tag}: ${reason}`);
      await logToAppLogs(interaction.guild, `⏳ Timed out <@${user.id}> for ${minutes}m by <@${interaction.user.id}> | ${reason}`);
      return safeReply(interaction, { content: `✅ Timed out <@${user.id}> for ${minutes} minutes.`, ephemeral: true });
    }

    if (interaction.commandName === "untimeout") {
      const user = interaction.options.getUser("user", true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.timeout(null, `Timeout removed by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `✅ Removed timeout for <@${user.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Removed timeout for <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === "purge") {
      const amount = interaction.options.getInteger("amount", true);
      const user = interaction.options.getUser("user");
      const channel = interaction.channel;
      if (!channel || !("messages" in channel)) {
        return safeReply(interaction, { content: "❌ This command must be used in a text channel.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const fetched = await channel.messages.fetch({ limit: amount }).catch(() => null);
      if (!fetched) return safeReply(interaction, { content: "❌ Could not fetch messages.", ephemeral: true });
      const toDelete = user ? fetched.filter((m) => m.author.id === user.id) : fetched;
      const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
      const count = deleted ? deleted.size : 0;
      await logToAppLogs(interaction.guild, `🧹 Purged ${count} messages in <#${channel.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Deleted ${count} messages.`, ephemeral: true });
    }

    if (interaction.commandName === "slowmode") {
      const seconds = interaction.options.getInteger("seconds", true);
      const channel = interaction.channel;
      if (!channel || !("setRateLimitPerUser" in channel)) {
        return safeReply(interaction, { content: "❌ Use this in a text channel.", ephemeral: true });
      }
      await channel.setRateLimitPerUser(seconds, `Slowmode set by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `🐢 Set slowmode ${seconds}s in <#${channel.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Slowmode set to ${seconds}s.`, ephemeral: true });
    }

    if (interaction.commandName === "lock") {
      const channel = interaction.channel;
      if (!channel || !("permissionOverwrites" in channel)) {
        return safeReply(interaction, { content: "❌ Use this in a guild channel.", ephemeral: true });
      }
      if (stmtIsLocked.get(interaction.guild.id, channel.id)) {
        return safeReply(interaction, { content: "ℹ️ Channel is already locked.", ephemeral: true });
      }
      await channel.permissionOverwrites.edit(
        interaction.guild.id,
        { SendMessages: false, AddReactions: false },
        { reason: `Lock by ${interaction.user.tag}` }
      );
      stmtLockChannel.run(interaction.guild.id, channel.id, Date.now());
      await logToAppLogs(interaction.guild, `🔒 Locked <#${channel.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: "✅ Channel locked.", ephemeral: true });
    }

    if (interaction.commandName === "unlock") {
      const channel = interaction.channel;
      if (!channel || !("permissionOverwrites" in channel)) {
        return safeReply(interaction, { content: "❌ Use this in a guild channel.", ephemeral: true });
      }
      await channel.permissionOverwrites.edit(
        interaction.guild.id,
        { SendMessages: null, AddReactions: null },
        { reason: `Unlock by ${interaction.user.tag}` }
      );
      stmtUnlockChannel.run(interaction.guild.id, channel.id);
      await logToAppLogs(interaction.guild, `🔓 Unlocked <#${channel.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: "✅ Channel unlocked.", ephemeral: true });
    }

    if (interaction.commandName === "announce") {
      const channel = interaction.options.getChannel("channel", true);
      const title = interaction.options.getString("title", true);
      const msg = interaction.options.getString("message", true);
      const embed = new EmbedBuilder().setTitle(title).setDescription(msg).setColor(0xf1c40f).setTimestamp();
      await channel.send({ embeds: [embed] });
      await logToAppLogs(interaction.guild, `📣 Announcement sent in <#${channel.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Sent announcement in ${channel}.`, ephemeral: true });
    }

    if (interaction.commandName === "say") {
      const channel = interaction.options.getChannel("channel", true);
      const msg = interaction.options.getString("message", true);
      await channel.send({ content: msg, allowedMentions: { parse: [] } });
      return safeReply(interaction, { content: `✅ Sent message in ${channel}.`, ephemeral: true });
    }

    if (interaction.commandName === "addrole") {
      const user = interaction.options.getUser("user", true);
      const role = interaction.options.getRole("role", true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.roles.add(role.id, `Role add by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `➕ Added role <@&${role.id}> to <@${user.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Added <@&${role.id}> to <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === "removerole") {
      const user = interaction.options.getUser("user", true);
      const role = interaction.options.getRole("role", true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.roles.remove(role.id, `Role remove by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `➖ Removed role <@&${role.id}> from <@${user.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: `✅ Removed <@&${role.id}> from <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === "nick") {
      const user = interaction.options.getUser("user", true);
      const nickname = interaction.options.getString("nickname") ?? null;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "❌ User not found in guild.", ephemeral: true });
      await member.setNickname(nickname, `Nickname set by ${interaction.user.tag}`);
      await logToAppLogs(interaction.guild, `🏷️ Nickname changed for <@${user.id}> by <@${interaction.user.id}>.`);
      return safeReply(interaction, { content: "✅ Nickname updated.", ephemeral: true });
    }

    if (interaction.commandName === "infractions") {
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser("user", true);
      const p = getPunishment(interaction.guild.id, user.id);
      const s = getGuildSettings(interaction.guild.id);

      if (sub === "view") {
        const embed = new EmbedBuilder()
          .setTitle("📋 Infractions")
          .setColor(0x95a5a6)
          .setDescription(
            [
              `User: <@${user.id}>`,
              `Warns: ${p.warns ?? 0}/${s.autoban_warn_threshold ?? 3}`,
              `Ad-warns: ${p.ad_warns ?? 0}/${s.adwarn_mute_threshold ?? 3}`,
            ].join("\n")
          );
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (sub === "reset") {
        clearPunishment(interaction.guild.id, user.id);
        await logToAppLogs(interaction.guild, `🧽 Reset infractions for <@${user.id}> by <@${interaction.user.id}>.`);
        return safeReply(interaction, { content: `✅ Reset infractions for <@${user.id}>.`, ephemeral: true });
      }

      if (sub === "pardon") {
        const amount = interaction.options.getInteger("amount", true);
        const nextWarns = Math.max(0, (p.warns ?? 0) - amount);
        setPunishment(interaction.guild.id, user.id, nextWarns, p.ad_warns ?? 0);
        await logToAppLogs(interaction.guild, `✅ Pardoned ${amount} warns for <@${user.id}> by <@${interaction.user.id}>.`);
        return safeReply(interaction, { content: `✅ Removed ${amount} warns. Now: ${nextWarns}.`, ephemeral: true });
      }

      if (sub === "pardon_ad") {
        const amount = interaction.options.getInteger("amount", true);
        const nextAd = Math.max(0, (p.ad_warns ?? 0) - amount);
        setPunishment(interaction.guild.id, user.id, p.warns ?? 0, nextAd);
        await logToAppLogs(interaction.guild, `✅ Pardoned ${amount} ad-warns for <@${user.id}> by <@${interaction.user.id}>.`);
        return safeReply(interaction, { content: `✅ Removed ${amount} ad-warns. Now: ${nextAd}.`, ephemeral: true });
      }
    }

    if (interaction.commandName === "note") {
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser("user", true);

      if (sub === "add") {
        const text = interaction.options.getString("text", true);
        stmtAddNote.run(interaction.guild.id, user.id, text, interaction.user.id, Date.now());
        await logToAppLogs(interaction.guild, `🗒️ Note added for <@${user.id}> by <@${interaction.user.id}>.`);
        return safeReply(interaction, { content: "✅ Note added.", ephemeral: true });
      }

      if (sub === "list") {
        const limit = interaction.options.getInteger("limit") ?? 5;
        const rows = stmtGetNotes.all(interaction.guild.id, user.id, limit);
        const lines = rows.map((r, i) => {
          const when = new Date(r.created_at).toISOString().replace("T", " ").replace("Z", "");
          return `**${i + 1}.** ${r.note}\n- by <@${r.staff_id}> at ${when}`;
        });
        const embed = new EmbedBuilder()
          .setTitle("🗒️ Staff Notes")
          .setColor(0x9b59b6)
          .setDescription(lines.length ? lines.join("\n\n") : "No notes found.");
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (sub === "clear") {
        stmtClearNotes.run(interaction.guild.id, user.id);
        await logToAppLogs(interaction.guild, `🗑️ Notes cleared for <@${user.id}> by <@${interaction.user.id}>.`);
        return safeReply(interaction, { content: "✅ Notes cleared.", ephemeral: true });
      }
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

