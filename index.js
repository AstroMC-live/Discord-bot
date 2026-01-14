/**
 * Single-file Discord bot (discord.js v14)
 *
 * Features:
 * - Slash commands: /ping, /staff, /ticket
 * - Auto-role on join
 * - Ticket channel creation with secure overwrites
 * - Ticket close button (staff or ticket owner)
 *
 * Requirements:
 * - .env with BOT_TOKEN=...
 */

"use strict";

require("dotenv").config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ========= CONFIG (KEEP IDS) =========
const GUILD_ID = "1460760771268051059";
const TICKET_CATEGORY_ID = "1460924804424142973";
const AUTO_ROLE_ID = "1460922502263079052";

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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

// ---- Slash commands ----
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Replies with Pong!"),
  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Ping all staff roles (staff only)"),
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Create a support ticket"),
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

// ---- Interactions ----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button: close ticket
    if (interaction.isButton()) {
      if (interaction.customId !== "ticket_close") return;
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

      // Ensure cache is populated enough to find existing channels reliably.
      try {
        await guild.channels.fetch();
      } catch (err) {
        console.warn("⚠️ Could not fetch channels (continuing):", err);
      }

      const existing = guild.channels.cache.find(
        (c) => c.name === `ticket-${user.id}` && c.parentId === TICKET_CATEGORY_ID
      );

      if (existing) {
        return safeReply(interaction, {
          content: `❗ You already have an open ticket: ${existing}`,
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const channel = await guild.channels.create({
        name: `ticket-${user.id}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
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
        .setTitle("✅ Ticket created")
        .setDescription(
          [
            `Hi ${user}, describe your issue here and staff will help you.`,
            "",
            "When you're done, you (or staff) can close the ticket with the button below.",
          ].join("\n")
        )
        .setColor(0x2ecc71);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket_close")
          .setLabel("Close ticket")
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [row] });

      return safeReply(interaction, {
        content: `✅ Your ticket has been created: ${channel}`,
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

