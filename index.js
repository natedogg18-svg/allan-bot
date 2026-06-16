require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  PermissionsBitField,
} = require("discord.js");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require("@discordjs/voice");
const config = require("./config");

// ─── State ────────────────────────────────────────────────────────────────────
const lastSpokeAt = {};       // [guildId][userId] = Date.now()
const audioStreams = {};       // [guildId][userId] = audio stream
const aloneTimers = {};        // [guildId][channelId] = setTimeout handle

const AFK_TIMEOUT_MS = config.afkTimeoutMinutes * 60 * 1000;
const ALONE_TIMEOUT_MS = config.aloneTimeoutMinutes * 60 * 1000;
const CHECK_INTERVAL_MS = 30_000;

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`💖 [Allan] ${msg}`); }

function getAfkChannel(guild) {
  if (guild.afkChannelId) return guild.channels.cache.get(guild.afkChannelId);
  return guild.channels.cache.find(
    (c) => c.isVoiceBased() && c.name.toLowerCase().includes("afk")
  );
}

function initGuild(guildId) {
  if (!lastSpokeAt[guildId]) lastSpokeAt[guildId] = {};
  if (!audioStreams[guildId]) audioStreams[guildId] = {};
  if (!aloneTimers[guildId]) aloneTimers[guildId] = {};
}

function markActive(guildId, userId) {
  initGuild(guildId);
  lastSpokeAt[guildId][userId] = Date.now();
}

function barbieEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xff69b4)
    .setTitle(`✨ ${title}`)
    .setDescription(description)
    .setFooter({ text: "Allan • Barbie AFK Bot 💅" })
    .setTimestamp();
}

// ─── Alone Timer ──────────────────────────────────────────────────────────────
function startAloneTimer(channel) {
  const { guild } = channel;
  initGuild(guild.id);

  // Don't start if already have a timer for this channel
  if (aloneTimers[guild.id][channel.id]) return;

  log(`${channel.name}: someone is alone, starting ${config.aloneTimeoutMinutes}m timer`);

  aloneTimers[guild.id][channel.id] = setTimeout(() => {
    delete aloneTimers[guild.id][channel.id];

    // Double-check they're still alone
    const nonBots = channel.members.filter((m) => !m.user.bot);
    if (nonBots.size === 1 && !getVoiceConnection(guild.id)) {
      log(`${channel.name}: still alone after ${config.aloneTimeoutMinutes}m, joining`);
      joinAndListen(channel);
    }
  }, ALONE_TIMEOUT_MS);
}

function cancelAloneTimer(channel) {
  const guildId = channel.guild.id;
  if (aloneTimers[guildId]?.[channel.id]) {
    clearTimeout(aloneTimers[guildId][channel.id]);
    delete aloneTimers[guildId][channel.id];
    log(`${channel.name}: alone timer cancelled`);
  }
}

// ─── Speaking Tracking ───────────────────────────────────────────────────────
// Uses Discord's speaking event — fires whenever someone's mic picks up sound.
// No audio decoding needed, works without opus/opusscript.
function attachSpeakingListener(guildId, receiver) {
  receiver.speaking.on("start", (userId) => {
    markActive(guildId, userId);
  });
  log(`Speaking listener attached for guild ${guildId}`);
}

function unsubscribeFromUser(guildId, userId) {
  delete audioStreams[guildId]?.[userId];
  delete lastSpokeAt[guildId]?.[userId];
}

function joinAndListen(channel) {
  const { guild } = channel;
  initGuild(guild.id);

  if (getVoiceConnection(guild.id)) return;

  log(`Joining #${channel.name} in ${guild.name}`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  connection.on(VoiceConnectionStatus.Connecting, () => log(`Voice: Connecting in ${guild.name}`));
  connection.on(VoiceConnectionStatus.Signalling, () => log(`Voice: Signalling in ${guild.name}`));
  connection.on(VoiceConnectionStatus.Ready, () => {
    log(`Voice connection Ready in ${guild.name} — seeding timers`);
    const receiver = connection.receiver;
    const afkChannel = getAfkChannel(guild);

    // Seed everyone's timer backdated by ALONE_TIMEOUT_MS so the 20-min
    // post-join AFK window starts from when Allan arrives, not from zero.
    for (const vc of guild.channels.cache.values()) {
      if (!vc.isVoiceBased() || vc.id === afkChannel?.id) continue;
      for (const [, member] of vc.members) {
        if (member.user.bot) continue;
        initGuild(guild.id);
        lastSpokeAt[guild.id][member.id] = Date.now() - ALONE_TIMEOUT_MS;
      }
    }

    // One listener for all speaking activity in the guild
    attachSpeakingListener(guild.id, receiver);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });
}

function leaveIfEmpty(guild) {
  const afkChannel = getAfkChannel(guild);
  const anyoneLeft = guild.channels.cache.some(
    (c) =>
      c.isVoiceBased() &&
      c.id !== afkChannel?.id &&
      c.members.some((m) => !m.user.bot)
  );

  if (!anyoneLeft) {
    const conn = getVoiceConnection(guild.id);
    if (conn) {
      conn.destroy();
      log(`Left voice in ${guild.name} — nobody left`);
    }
    if (lastSpokeAt[guild.id]) lastSpokeAt[guild.id] = {};
  }
}

// ─── Voice State Updates ──────────────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  const { guild } = newState;
  const member = newState.member;
  if (member?.user.bot) return;

  initGuild(guild.id);
  const afkChannel = getAfkChannel(guild);
  const userId = newState.id;

  // User joined a non-AFK channel
  if (!oldState.channelId && newState.channelId && newState.channelId !== afkChannel?.id) {
    const channel = newState.channel;
    const nonBots = channel.members.filter((m) => !m.user.bot);

    if (getVoiceConnection(guild.id)) {
      // Allan is already in — just seed the new person's timer
      markActive(guild.id, userId);
    } else if (nonBots.size === 1) {
      // They're alone — start the alone timer
      startAloneTimer(channel);
    } else {
      // Multiple people, cancel any alone timer
      cancelAloneTimer(channel);
    }
    return;
  }

  // User left
  if (oldState.channelId && !newState.channelId) {
    unsubscribeFromUser(guild.id, userId);

    const oldChannel = oldState.channel;
    if (oldChannel) {
      const nonBots = oldChannel.members.filter((m) => !m.user.bot);
      if (nonBots.size === 1) {
        // One person left alone
        if (!getVoiceConnection(guild.id)) startAloneTimer(oldChannel);
      } else if (nonBots.size === 0) {
        cancelAloneTimer(oldChannel);
        leaveIfEmpty(guild);
      }
    }
    return;
  }

  // User moved channels
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    if (newState.channelId === afkChannel?.id) {
      unsubscribeFromUser(guild.id, userId);
    } else {
      markActive(guild.id, userId);
    }

    // Check alone status on both channels
    const oldChannel = oldState.channel;
    const newChannel = newState.channel;

    if (oldChannel) {
      const oldNonBots = oldChannel.members.filter((m) => !m.user.bot);
      if (oldNonBots.size === 1 && !getVoiceConnection(guild.id)) startAloneTimer(oldChannel);
      else if (oldNonBots.size === 0) cancelAloneTimer(oldChannel);
    }

    if (newChannel && newChannel.id !== afkChannel?.id) {
      const newNonBots = newChannel.members.filter((m) => !m.user.bot);
      if (newNonBots.size > 1) cancelAloneTimer(newChannel);
    }
  }
});

// ─── AFK Check Loop ───────────────────────────────────────────────────────────
async function checkAfkUsers() {
  for (const guild of client.guilds.cache.values()) {
    const afkChannel = getAfkChannel(guild);
    if (!afkChannel) continue;

    initGuild(guild.id);

    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased() || channel.id === afkChannel.id) continue;

      for (const [memberId, member] of channel.members) {
        if (member.user.bot) continue;
        if (member.permissions.has(PermissionsBitField.Flags.Administrator)) continue;
        if (member.voice.streaming || member.voice.selfVideo) continue;

        const last = lastSpokeAt[guild.id][memberId];
        if (!last) continue;

        const idle = Date.now() - last;
        log(`Checking ${member.user.tag}: idle ${Math.round(idle/60000)}m, threshold ${config.afkTimeoutMinutes}m, streaming=${member.voice.streaming}, video=${member.voice.selfVideo}`);
        if (idle < AFK_TIMEOUT_MS) continue;

        try {
          await member.voice.setChannel(afkChannel);
          log(`Moved ${member.user.tag} to AFK (silent ${Math.round(idle / 60000)}m)`);
          unsubscribeFromUser(guild.id, memberId);

          try {
            await member.send({
              embeds: [barbieEmbed(
                "You've been moved to AFK! 💤",
                `Hey **${member.displayName}**! You were silent in **${channel.name}** for ${config.afkTimeoutMinutes} minutes, so Allan moved you to **${afkChannel.name}**. Come back soon! 💖`
              )],
            });
          } catch { /* DMs off */ }
        } catch (err) {
          log(`Couldn't move ${member.user.tag}: ${err.message}`);
        }
      }
    }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;
  const args = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === "allan") {
    await message.reply({
      embeds: [barbieEmbed(
        "Hi, I'm Allan! 💖",
        `I stay out of calls unless someone is alone for **${config.aloneTimeoutMinutes} minute(s)** or I'm called in with \`!watch\`.\n\n` +
        `**Commands:**\n` +
        `\`${config.prefix}allan\` — this help message\n` +
        `\`${config.prefix}afkstatus\` — see idle times\n` +
        `\`${config.prefix}watch\` — call Allan into your channel\n` +
        `\`${config.prefix}leave\` — make Allan leave the channel`
      )],
    });
  }

  if (command === "watch") {
    const voiceChannel = message.member?.voice?.channel;
    log(`!watch — user: ${message.author.tag}, voiceChannel: ${voiceChannel?.name ?? "none"}, existingConn: ${!!getVoiceConnection(message.guild.id)}`);
    if (!voiceChannel) return message.reply("You need to be in a voice channel first! 💔");
    if (getVoiceConnection(message.guild.id)) return message.reply("Allan is already in a channel! 💖");

    joinAndListen(voiceChannel);
    await message.reply({
      embeds: [barbieEmbed("On my way! 💅", `Allan is now watching **${voiceChannel.name}** for silence.`)],
    });
  }

  if (command === "leave") {
    const conn = getVoiceConnection(message.guild.id);
    if (!conn) return message.reply("Allan isn't in a channel! 💖");
    conn.destroy();
    lastSpokeAt[message.guild.id] = {};
    await message.reply({ embeds: [barbieEmbed("Bye! 💖", "Allan has left the channel.")] });
  }

  if (command === "afkstatus") {
    if (!message.guild) return;
    initGuild(message.guild.id);
    const entries = Object.entries(lastSpokeAt[message.guild.id]);

    if (!entries.length) {
      return message.reply({ embeds: [barbieEmbed("AFK Status 💅", "Nobody is being tracked!")] });
    }

    const lines = entries.map(([uid, ts]) => {
      const idle = Math.round((Date.now() - ts) / 1000);
      const minsLeft = Math.max(0, Math.round((AFK_TIMEOUT_MS - (Date.now() - ts)) / 60000));
      const name = message.guild.members.cache.get(uid)?.displayName ?? uid;
      return `• **${name}** — silent ${idle}s (AFK in ~${minsLeft}m)`;
    });

    await message.reply({ embeds: [barbieEmbed("AFK Status 💅", lines.join("\n"))] });
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("ready", () => {
  log(`Logged in as ${client.user.tag} 💅`);
  client.user.setActivity("voice channels 💖", { type: ActivityType.Watching });

  // On startup, check if anyone is alone in a channel
  for (const guild of client.guilds.cache.values()) {
    const afkChannel = getAfkChannel(guild);
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased() || channel.id === afkChannel?.id) continue;
      const nonBots = channel.members.filter((m) => !m.user.bot);
      if (nonBots.size === 1) startAloneTimer(channel);
    }
  }

  setInterval(checkAfkUsers, CHECK_INTERVAL_MS);
  log(`Ready! Alone timeout: ${config.aloneTimeoutMinutes}m, AFK timeout: ${config.afkTimeoutMinutes}m`);
});

client.login(config.token);
