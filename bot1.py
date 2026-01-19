import os
import random
import re
import time
from dataclasses import dataclass, field

import discord
from discord import app_commands
from discord.ext import commands, tasks

TOKEN = os.getenv("DISCORD_TOKEN", "")
if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN environment variable is required.")

GIVEAWAY_EMOJI = "🎉"

# Anti-spam / activity validation rules
MIN_MESSAGE_LENGTH = 6
MIN_ALNUM_CHARS = 3
MIN_SECONDS_BETWEEN_COUNTED_MESSAGES = 3

# Keep ended giveaways for rerolls
ARCHIVE_TTL_SECONDS = 7 * 24 * 3600

intents = discord.Intents.default()
intents.message_content = True
intents.reactions = True

bot = commands.Bot(command_prefix="!", intents=intents)

# message_counts[giveaway_id][user_id] = count
message_counts: dict[int, dict[int, int]] = {}

# message_state[giveaway_id][user_id] = UserMessageState
message_state: dict[int, dict[int, "UserMessageState"]] = {}

# giveaways[message_id] = data
giveaways: dict[int, dict[str, object]] = {}

# giveaway_archive[message_id] = data (ended giveaways)
giveaway_archive: dict[int, dict[str, object]] = {}


@dataclass
class UserMessageState:
    last_counted_at: float = 0.0
    seen_contents: set[str] = field(default_factory=set)


# =====================
# READY
# =====================
@bot.event
async def on_ready():
    await bot.tree.sync()
    if not giveaway_loop.is_running():
        giveaway_loop.start()
    print(f"Logged in as {bot.user}")


# =====================
# MESSAGE TRACKING
# =====================
def normalize_message_content(content: str) -> str:
    return re.sub(r"\s+", " ", content.strip().lower())


def has_real_content(content: str) -> bool:
    if len(content.strip()) < MIN_MESSAGE_LENGTH:
        return False
    alnum = sum(1 for c in content if c.isalnum())
    if alnum < MIN_ALNUM_CHARS:
        return False
    return True


def get_user_state(giveaway_id: int, user_id: int) -> UserMessageState:
    message_state.setdefault(giveaway_id, {})
    if user_id not in message_state[giveaway_id]:
        message_state[giveaway_id][user_id] = UserMessageState()
    return message_state[giveaway_id][user_id]


def is_eligible_to_join(giveaway_id: int, user_id: int, min_messages: int) -> bool:
    if min_messages <= 0:
        return True
    return message_counts.get(giveaway_id, {}).get(user_id, 0) >= min_messages


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot or message.guild is None:
        return

    if isinstance(bot.command_prefix, str) and message.content.startswith(
        bot.command_prefix
    ):
        await bot.process_commands(message)
        return

    for gid, g in list(giveaways.items()):
        activity_channel = g.get("activity_channel")
        channel_ok = activity_channel is None or message.channel.id == activity_channel
        if not channel_ok:
            continue

        if message.created_at.timestamp() < float(g["start_time"]):
            continue

        content = message.content or ""
        if not has_real_content(content):
            continue

        state = get_user_state(gid, message.author.id)
        normalized = normalize_message_content(content)
        if normalized in state.seen_contents:
            continue

        now_ts = message.created_at.timestamp()
        state.seen_contents.add(normalized)

        if now_ts - state.last_counted_at < MIN_SECONDS_BETWEEN_COUNTED_MESSAGES:
            continue

        message_counts.setdefault(gid, {})
        message_counts[gid][message.author.id] = (
            message_counts[gid].get(message.author.id, 0) + 1
        )
        state.last_counted_at = now_ts

    await bot.process_commands(message)


# =====================
# REACTION GATE
# =====================
@bot.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    if bot.user and payload.user_id == bot.user.id:
        return

    if str(payload.emoji) != GIVEAWAY_EMOJI:
        return

    g = giveaways.get(payload.message_id)
    if not g:
        return

    min_messages = int(g["min_messages"])
    if is_eligible_to_join(payload.message_id, payload.user_id, min_messages):
        return

    channel = bot.get_channel(payload.channel_id)
    if channel is None:
        try:
            channel = await bot.fetch_channel(payload.channel_id)
        except discord.HTTPException:
            channel = None

    user = payload.member or bot.get_user(payload.user_id)
    if user is None:
        try:
            user = await bot.fetch_user(payload.user_id)
        except discord.HTTPException:
            user = None

    if channel and user:
        try:
            msg = await channel.fetch_message(payload.message_id)
            await msg.remove_reaction(GIVEAWAY_EMOJI, user)
        except discord.HTTPException:
            pass

    remaining = max(
        min_messages
        - message_counts.get(payload.message_id, {}).get(payload.user_id, 0),
        0,
    )
    if user:
        try:
            await user.send(
                "Du kan ikke joine giveaway enda. "
                f"Du mangler {remaining} ekte meldinger (ingen spam/duplikater)."
            )
        except discord.HTTPException:
            pass


# =====================
# TIME PARSER
# =====================
def parse_duration(text: str) -> int:
    text = text.strip().lower()
    units = [
        ("mo", 2592000),
        ("w", 604800),
        ("d", 86400),
        ("h", 3600),
        ("m", 60),
        ("y", 31536000),
    ]
    for unit, seconds in units:
        if text.endswith(unit):
            return int(text[: -len(unit)]) * seconds
    raise ValueError("Invalid duration")


# =====================
# GIVEAWAY HELPERS
# =====================
async def resolve_channel(channel_id: int) -> discord.TextChannel | None:
    channel = bot.get_channel(channel_id)
    if channel is not None:
        return channel
    try:
        fetched = await bot.fetch_channel(channel_id)
    except discord.HTTPException:
        return None
    if isinstance(fetched, discord.TextChannel):
        return fetched
    return None


async def end_giveaway(message_id: int, data: dict[str, object]) -> list[int]:
    channel = await resolve_channel(int(data["channel_id"]))
    eligible_ids: list[int] = []

    if channel is not None:
        msg = None
        try:
            msg = await channel.fetch_message(message_id)
        except discord.HTTPException:
            msg = None

        if msg is not None:
            participants: list[discord.User] = []
            for reaction in msg.reactions:
                if str(reaction.emoji) == GIVEAWAY_EMOJI:
                    participants = [
                        user async for user in reaction.users() if not user.bot
                    ]
                    break

            eligible: list[discord.User] = []
            for user in participants:
                count = message_counts.get(message_id, {}).get(user.id, 0)
                if count >= int(data["min_messages"]):
                    eligible.append(user)

            eligible_ids = [user.id for user in eligible]

            if eligible:
                winners = random.sample(
                    eligible, min(len(eligible), int(data["winners"]))
                )
                await channel.send(
                    f"{GIVEAWAY_EMOJI} Winner(s): "
                    f"{', '.join(w.mention for w in winners)}\n"
                    f"Prize: {data['prize']}"
                )
            else:
                await channel.send(
                    "No eligible participants (activity requirement not met)."
                )

    giveaway_archive[message_id] = {
        **data,
        "ended_at": time.time(),
        "eligible_ids": eligible_ids,
    }

    giveaways.pop(message_id, None)
    message_counts.pop(message_id, None)
    message_state.pop(message_id, None)

    return eligible_ids


async def reroll_giveaway(message_id: int, data: dict[str, object]) -> None:
    channel = await resolve_channel(int(data["channel_id"]))
    if channel is None:
        return

    eligible_ids = [int(uid) for uid in data.get("eligible_ids", [])]
    if not eligible_ids:
        await channel.send("No eligible participants for reroll.")
        return

    winner_count = min(len(eligible_ids), int(data["winners"]))
    winners = random.sample(eligible_ids, winner_count)
    mentions = ", ".join(f"<@{uid}>" for uid in winners)
    await channel.send(
        f"{GIVEAWAY_EMOJI} Reroll winner(s): {mentions}\n"
        f"Prize: {data['prize']}"
    )


def prune_archive() -> None:
    now = time.time()
    expired = [
        mid for mid, data in giveaway_archive.items()
        if now - float(data.get("ended_at", now)) > ARCHIVE_TTL_SECONDS
    ]
    for mid in expired:
        giveaway_archive.pop(mid, None)


# =====================
# GIVEAWAY GROUP
# =====================
class Giveaway(app_commands.Group):
    def __init__(self):
        super().__init__(name="giveaway", description="Giveaway commands")

    @app_commands.command(name="start", description="Start a giveaway")
    @app_commands.checks.has_permissions(manage_guild=True)
    async def start(
        self,
        interaction: discord.Interaction,
        prize: str,
        duration: str,
        winners: int = 1,
        min_messages: int = 0,
        activity_channel: discord.TextChannel | None = None,
    ):
        if winners < 1:
            await interaction.response.send_message(
                "Winners must be at least 1.", ephemeral=True
            )
            return
        if min_messages < 0:
            await interaction.response.send_message(
                "Min messages cannot be negative.", ephemeral=True
            )
            return

        try:
            seconds = parse_duration(duration)
        except ValueError:
            await interaction.response.send_message(
                "Invalid duration. Examples: 30m, 2h, 7d.", ephemeral=True
            )
            return

        end_time = int(time.time() + seconds)

        embed = discord.Embed(
            title=f"{GIVEAWAY_EMOJI} GIVEAWAY {GIVEAWAY_EMOJI}",
            description=(
                f"Prize: {prize}\n"
                f"Winners: {winners}\n"
                f"Ends: <t:{end_time}:R>\n"
                f"Min messages: {min_messages}\n"
                f"Activity channel: "
                f"{activity_channel.mention if activity_channel else 'Any'}\n\n"
                f"React with {GIVEAWAY_EMOJI} to enter.\n"
                "Duplicate/spam messages do not count."
            ),
            color=0x00FFCC,
        )

        msg = await interaction.channel.send(embed=embed)
        await msg.add_reaction(GIVEAWAY_EMOJI)

        giveaways[msg.id] = {
            "channel_id": interaction.channel.id,
            "start_time": time.time(),
            "end_time": end_time,
            "winners": winners,
            "prize": prize,
            "min_messages": min_messages,
            "activity_channel": activity_channel.id if activity_channel else None,
            "host_id": interaction.user.id,
        }

        message_counts[msg.id] = {}
        message_state[msg.id] = {}

        await interaction.response.send_message(
            f"Giveaway started! Message ID: {msg.id}", ephemeral=True
        )

    @app_commands.command(name="end", description="End a giveaway early")
    @app_commands.checks.has_permissions(manage_guild=True)
    async def end(
        self,
        interaction: discord.Interaction,
        message_id: str,
    ):
        try:
            mid = int(message_id)
        except ValueError:
            await interaction.response.send_message(
                "Invalid message ID.", ephemeral=True
            )
            return

        data = giveaways.get(mid)
        if not data:
            await interaction.response.send_message(
                "Giveaway not found or already ended.", ephemeral=True
            )
            return

        await interaction.response.send_message(
            "Ending giveaway...", ephemeral=True
        )
        await end_giveaway(mid, data)

    @app_commands.command(name="reroll", description="Reroll a giveaway")
    @app_commands.checks.has_permissions(manage_guild=True)
    async def reroll(
        self,
        interaction: discord.Interaction,
        message_id: str,
    ):
        try:
            mid = int(message_id)
        except ValueError:
            await interaction.response.send_message(
                "Invalid message ID.", ephemeral=True
            )
            return

        data = giveaway_archive.get(mid)
        if not data:
            await interaction.response.send_message(
                "Giveaway not found or not ended.", ephemeral=True
            )
            return

        await interaction.response.send_message(
            "Rerolling winners...", ephemeral=True
        )
        await reroll_giveaway(mid, data)

    @app_commands.command(name="status", description="Show giveaway status")
    async def status(
        self,
        interaction: discord.Interaction,
        message_id: str,
    ):
        try:
            mid = int(message_id)
        except ValueError:
            await interaction.response.send_message(
                "Invalid message ID.", ephemeral=True
            )
            return

        data = giveaways.get(mid)
        if not data:
            await interaction.response.send_message(
                "Giveaway not found or already ended.", ephemeral=True
            )
            return

        user_count = message_counts.get(mid, {}).get(interaction.user.id, 0)
        min_messages = int(data["min_messages"])
        remaining = max(min_messages - user_count, 0)

        await interaction.response.send_message(
            f"Prize: {data['prize']}\n"
            f"Ends: <t:{int(data['end_time'])}:R>\n"
            f"Min messages: {min_messages}\n"
            f"Your valid messages: {user_count}\n"
            f"Remaining: {remaining}",
            ephemeral=True,
        )


# Register group
bot.tree.add_command(Giveaway())


# =====================
# GIVEAWAY LOOP
# =====================
@tasks.loop(seconds=15)
async def giveaway_loop():
    now = time.time()
    ended = []

    for mid, g in list(giveaways.items()):
        if now >= float(g["end_time"]):
            ended.append((mid, g))

    for mid, g in ended:
        await end_giveaway(mid, g)

    prune_archive()


# =====================
# RUN
# =====================
bot.run(TOKEN)
