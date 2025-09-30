require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = './data.json';
const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
// IMPORTANT: Role names are case-sensitive. Use role IDs for stability.
const IGNORED_ROLES = (process.env.IGNORED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.PORT || 3000;

// --- Appeal Links 
const APPEAL_CHANNEL_LINK = 'https://discord.com/channels/1394343761030676603/1395021234885890160';
const BAN_APPEAL_URL = 'https://shorelineinteractive.netlify.app/banappeal';
// CONSTANT for 30 minutes in milliseconds
const TIMEOUT_DURATION_MS = 30 * 60 * 1000;

if (!TOKEN) {
    console.error('Please set TOKEN in .env');
    process.exit(1);
}

// --- Load / Save data
function loadData() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        // Initialize data file if it doesn't exist or is invalid
        const init = { whitelist: { users: [], roles: [] }, violations: { byGuild: {} } };
        fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
}

function saveData(d) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

let data = loadData();

// --- Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildBans
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- Utility functions
function isIgnored(member) {
    if (!member || !member.roles) return false;
    for (const roleIdOrName of IGNORED_ROLES) {
        if (!roleIdOrName) continue;
        // Check both by ID and by name (prefer ID)
        const r = member.roles.cache.get(roleIdOrName) || member.roles.cache.find(x => x.name === roleIdOrName);
        if (r) return true;
    }
    return false;
}

function isWhitelisted(guildId, member) {
    if (!member || !member.roles) return false;
    const guildWhitelist = data.whitelist || { users: [], roles: [] };
    if (guildWhitelist.users.includes(member.id)) return true;
    for (const r of member.roles.cache.values()) {
        if (guildWhitelist.roles.includes(r.id)) return true;
    }
    return false;
}

// --- Log Embed (UPDATED: More detailed)
async function logEmbed(guild, actionTitle, actionDescription, fields, color) {
    try {
        if (!LOG_CHANNEL_ID) return;
        const ch = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!ch) return;

        const embed = new EmbedBuilder()
            .setTitle(actionTitle)
            .setDescription(actionDescription)
            .addFields(fields)
            .setColor(color)
            .setTimestamp();

        await ch.send({ embeds: [embed] });
    } catch (e) {
        console.error('Failed to send log embed:', e.message);
    }
}

// --- Appeal DM Function
async function sendAppealDM(user, action, reason, isBan = false) {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Moderation Action: You were ${action}!`)
            .setDescription(`A moderation action has been taken against you in the server.`)
            .addFields(
                { name: 'Action', value: action.toUpperCase(), inline: true },
                { name: 'Reason', value: reason || 'No specific reason provided.' }
            )
            .setColor(isBan ? 'DarkRed' : 'Orange')
            .setFooter({ text: 'This is an automated notification from the server security bot.' })
            .setTimestamp();

        if (isBan) {
            embed.addFields(
                { name: 'Ban Appeal', value: `If you wish to appeal your ban, please use this dedicated form: [Ban Appeal Form](${BAN_APPEAL_URL})` }
            );
        } else {
            embed.addFields(
                { name: 'Appeal a Warning, Violation, or Kick', value: `You can attempt to appeal this action in the designated appeal channel. **Note:** This link only works if you are still in the server.` },
                { name: 'Appeal Link', value: `[Go to Appeal Channel](${APPEAL_CHANNEL_LINK})` }
            );
        }

        await user.send({ embeds: [embed] });
    } catch (e) {
        // This is normal if a user has DMs disabled
        console.warn(`Failed to send appeal DM to ${user.tag} (${user.id}) for ${action}: ${e.message}`);
    }
}


// --- Violations
function addViolation(guildId, userId, { type, reason, moderatorId, channelId }) {
    if (!data.violations.byGuild[guildId]) data.violations.byGuild[guildId] = {};
    if (!data.violations.byGuild[guildId][userId]) data.violations.byGuild[guildId][userId] = [];
    const id = uuidv4();
    const violation = { id, type, reason, moderatorId, channelId, timestamp: new Date().toISOString() };
    data.violations.byGuild[guildId][userId].push(violation);
    saveData(data);
    return violation;
}

function removeViolation(guildId, userId, violationId) {
    const guild = data.violations.byGuild[guildId];
    if (!guild || !guild[userId]) return false;
    const arr = guild[userId];
    const idx = arr.findIndex(v => v.id === violationId);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    saveData(data);
    return true;
}

function getViolations(guildId, userId) {
    return (data.violations.byGuild[guildId] && data.violations.byGuild[guildId][userId]) || [];
}

// --- Offensive words
const offensiveWords = ["nigger", "nigga"];

// --- Message monitor
client.on('messageCreate', async (message) => {
    // Check if the message is in a guild, not from a bot, and not a system message
    if (!message.guild || message.author.bot || message.system) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return; // Member is not cached or fetch failed
    
    // Check for ignore/whitelist status before processing
    if (isIgnored(member) || isWhitelisted(message.guild.id, member)) return;

    const content = (message.content || '').toLowerCase();
    for (const w of offensiveWords) {
        if (content.includes(w)) {
            const reason = `Use of banned word: ${w}`;
            const violation = addViolation(message.guild.id, message.author.id, {
                type: 'HATE_SPEECH',
                reason: reason,
                moderatorId: client.user.id,
                channelId: message.channel.id
            });
            
            // --- DM for auto-violation
            await sendAppealDM(message.author, 'Violation', reason);

            const embed = new EmbedBuilder()
                .setTitle('🚨 Security Violation — HATE_SPEECH')
                .setDescription(`An unauthorized message was detected and deleted.`)
                .addFields(
                    { name: 'User', value: `<@${message.author.id}>`, inline: true },
                    { name: 'Channel', value: `${message.channel}`, inline: true },
                    { name: 'Violation Type', value: 'HATE_SPEECH' },
                    { name: 'Word Detected', value: w },
                    { name: 'Violation ID', value: `\`${violation.id.substring(0, 8)}...\`` },
                    { name: 'Moderator', value: `<@${client.user.id}>` }
                )
                .setColor('Red')
                .setTimestamp();

            await message.channel.send({ embeds: [embed] });

            // UPDATED: Log function call with more details
            const logFields = [
                { name: 'User', value: `<@${message.author.id}>`, inline: true },
                { name: 'Channel', value: `${message.channel}`, inline: true },
                { name: 'Violation Type', value: 'HATE_SPEECH' },
                { name: 'Word Detected', value: w },
                { name: 'Violation ID', value: `\`${violation.id}\`` }
            ];
            await logEmbed(message.guild, 'Hate Speech Detected', `A user posted a banned word.`, logFields, 'Red');

            const userViolations = getViolations(message.guild.id, message.author.id);
            if (userViolations.length >= 3) {
                try {
                    // Fetch member again to ensure we have the most current object
                    const memberToTimeout = await message.guild.members.fetch(message.author.id);
                    // FIX: Timeout duration is now TIMEOUT_DURATION_MS constant (30 min)
                    await memberToTimeout.timeout(TIMEOUT_DURATION_MS, 'Reached 3 security violations'); 
                    
                    const timeoutEmbed = new EmbedBuilder()
                        .setTitle('User Timed Out')
                        .setDescription(`<@${message.author.id}> was timed out for 30 minutes due to reaching 3 violations.`)
                        .addFields(
                            { name: 'User', value: `<@${message.author.id}>` },
                            { name: 'Moderator', value: `<@${client.user.id}>` },
                            { name: 'Reason', value: 'Reached 3 violations' }
                        )
                        .setColor('Orange')
                        .setTimestamp();
                    await message.channel.send({ embeds: [timeoutEmbed] });
                    
                    // UPDATED: Log function call
                    const timeoutLogFields = [
                        { name: 'User', value: `<@${message.author.id}>`, inline: true },
                        { name: 'Moderator', value: `<@${client.user.id}>`, inline: true },
                        { name: 'Reason', value: 'Reached 3 violations (Auto-Timeout)' }
                    ];
                    await logEmbed(message.guild, 'User Auto-Timed Out', `<@${message.author.id}> was automatically timed out.`, timeoutLogFields, 'Orange');
                } catch (e) {
                    console.error('Failed to auto-timeout member', e.message);
                }
            }

            try { await message.delete().catch(() => {}); } catch (e) { /* Ignore deletion errors */ }
            return;
        }
    }
});

// --- Audit log monitor
// FIX: userThatGotAffected is now an optional User object for clarity on ban logging
async function handleAuditAction(actionType, entity, userThatGotAffected = null) { 
    try {
        const guild = entity.guild || (entity.channel ? entity.channel.guild : null);
        if (!guild) return;

        const logs = await guild.fetchAuditLogs({ limit: 5, type: actionType });
        const entry = logs.entries.first();
        
        // Ensure the log entry exists, is recent, and target matches the entity (where applicable)
        if (!entry || (entry.targetId && entity.id && entry.targetId !== entity.id)) return;
        
        const executor = entry.executor;
        if (!executor) return;
        
        // Prevent bot from kicking itself or ignored/whitelisted users
        if (executor.id === client.user.id) return;
        
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return; // Executor is not a member of the guild anymore
        
        if (isIgnored(member) || isWhitelisted(guild.id, member)) return;
        
        // --- DM for external Ban (if the bot didn't issue it)
        if (actionType === 'MemberBan' && userThatGotAffected) {
            // Check if the bot was the one who logged the ban, if not, send appeal DM
            if (entry.executor.id !== client.user.id) {
                await sendAppealDM(userThatGotAffected, 'Banned', entry.reason || 'Banned by a moderator', true);
            }
        }

        // Get a target name for logging
        const targetName = entity.name || (userThatGotAffected ? userThatGotAffected.tag : entity.id);

        try {
            await member.kick(`Unauthorized administrative action (${actionType}) detected`);
            const logFields = [
                { name: 'Executor', value: `<@${executor.id}>` },
                { name: 'Action', value: actionType },
                { name: 'Target', value: targetName },
                { name: 'Bot Action', value: 'Executor Kicked' }
            ];
            await logEmbed(guild, 'Unauthorized Action - User Kicked', `An unauthorized administrative action was detected and the executor was kicked.`, logFields, 'Red');
        } catch (e) {
            console.error('Failed to kick executor', e.message);
            const logFields = [
                { name: 'Executor', value: `<@${executor.id}>` },
                { name: 'Action', value: actionType },
                { name: 'Target', value: targetName },
                { name: 'Bot Action', value: 'Failed to Kick Executor' },
                { name: 'Error', value: e.message }
            ];
            await logEmbed(guild, 'Unauthorized Action - Failed to Kick', `An unauthorized action was detected, but the bot failed to kick the executor.`, logFields, 'Red');
        }
    } catch (err) {
        console.error('handleAuditAction error', err.message);
    }
}

// Event Listeners for Audit Log Monitoring
client.on('channelCreate', async ch => handleAuditAction(Routes.AuditLogEntry.ChannelCreate, ch));
client.on('channelDelete', async ch => handleAuditAction(Routes.AuditLogEntry.ChannelDelete, ch));
client.on('roleCreate', async role => handleAuditAction(Routes.AuditLogEntry.RoleCreate, role));
client.on('roleDelete', async role => handleAuditAction(Routes.AuditLogEntry.RoleDelete, role));
// FIX: Pass the user object for ban DMs
client.on('guildBanAdd', async ban => handleAuditAction(Routes.AuditLogEntry.MemberBan, ban.guild, ban.user));

// --- Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency'),
    
    // NEW COMMAND: WARN
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issue a formal warning to a user (no violation tracking)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User to warn').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the warning').setRequired(true)),
    
    // NEW COMMAND: KICK
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from the guild')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User to kick').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the kick').setRequired(true)),
    
    // NEW COMMAND: BAN
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user from the guild')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban').setRequired(true))
        .addIntegerOption(opt => opt.setName('deletemessages').setDescription('Days of messages to delete (0-7)').setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('createviolation')
        .setDescription('Create a violation for a user')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User to mark').setRequired(true))
        .addStringOption(opt => opt.setName('type').setDescription('Violation type').setRequired(true)
            .addChoices(
                { name: 'TOS', value: 'TOS' },
                { name: 'SECURITY', value: 'SECURITY' },
                { name: 'HATE_SPEECH', value: 'HATE_SPEECH' },
                { name: 'MESSAGE_SPAM', value: 'MESSAGE_SPAM' },
                { name: 'EMOJI_SPAM', value: 'EMOJI_SPAM' }
            ))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason or notes').setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('removeviolation')
        .setDescription('Remove a violation by ID')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addStringOption(opt => opt.setName('violationid').setDescription('Violation ID').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('checkuser')
        .setDescription('Display all violations for a user')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Manage whitelist (users & roles)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sc => sc.setName('add').setDescription('Add user/role to whitelist')
            .addUserOption(o => o.setName('user').setDescription('User to add'))
            .addRoleOption(o => o.setName('role').setDescription('Role to add')))
        .addSubcommand(sc => sc.setName('remove').setDescription('Remove user/role from whitelist')
            .addUserOption(o => o.setName('user').setDescription('User to remove'))
            .addRoleOption(o => o.setName('role').setDescription('Role to remove')))
];

// --- Register commands
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        const clientId = client.application?.id || process.env.CLIENT_ID;
        if (!clientId) {
            console.error('CLIENT_ID is required to register commands.');
            return;
        }

        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: commands.map(c => c.toJSON()) });
            console.log('Registered guild commands');
        } else {
            await rest.put(Routes.applicationCommands(clientId), { body: commands.map(c => c.toJSON()) });
            console.log('Registered global commands');
        }
    } catch (e) {
        console.error('Failed to register commands', e);
    }
}

// --- Ready
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: 'with my ban hammer', type: 0 }],
        status: 'online'
    });
    // Check if client.application is available before registering commands
    if (client.application) {
        await registerCommands();
    } else {
        // This can happen if the client hasn't fully authenticated yet.
        console.warn('Client application not ready yet, command registration deferred.');
    }
});

// --- Slash command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;
    const { commandName } = interaction;

    // Acknowledge the interaction publicly to prevent the "This interaction failed" message
    await interaction.deferReply({ ephemeral: false });

    // --- Ping
    if (commandName === 'ping') {
        const embed = new EmbedBuilder()
            .setTitle('🏓 Pong!')
            .setDescription(`Latency: ${client.ws.ping}ms`)
            .setColor('Green')
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }

    // --- Warn
    else if (commandName === 'warn') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);

        // --- DM the warned user
        await sendAppealDM(target, 'Warned', reason);

        const embed = new EmbedBuilder()
            .setTitle('User Warned')
            .setDescription(`<@${target.id}> has received a warning.`)
            .addFields(
                { name: 'User', value: `<@${target.id}>`, inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Reason', value: reason }
            )
            .setColor('Yellow')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // --- Log function call
        const logFields = [
            { name: 'Action', value: 'Warning', inline: true },
            { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Target User', value: `<@${target.id}>`, inline: true },
            { name: 'Reason', value: reason }
        ];
        await logEmbed(interaction.guild, 'User Warned', `A moderator issued a formal warning.`, logFields, 'Yellow');
    }

    // --- Kick
    else if (commandName === 'kick') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setDescription('User not found in guild.').setColor('Red')] });
        }
        if (!member.kickable) {
             return interaction.editReply({ embeds: [new EmbedBuilder().setDescription(`Cannot kick <@${target.id}>. Check bot and user hierarchy.`).setColor('Red')] });
        }

        try {
            // --- DM the kicked user before kicking
            await sendAppealDM(target, 'Kicked', reason);

            await member.kick(reason);

            const embed = new EmbedBuilder()
                .setTitle('User Kicked')
                .setDescription(`<@${target.id}> was successfully kicked.`)
                .addFields(
                    { name: 'User', value: `<@${target.id}>`, inline: true },
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason }
                )
                .setColor('Orange')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

            // --- Log function call
            const logFields = [
                { name: 'Action', value: 'Kick', inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Target User', value: `<@${target.id}>`, inline: true },
                { name: 'Reason', value: reason }
            ];
            await logEmbed(interaction.guild, 'User Kicked', `A user was removed from the guild.`, logFields, 'Orange');

        } catch (e) {
            console.error('Failed to kick user:', e);
            await interaction.editReply({ embeds: [new EmbedBuilder().setDescription(`Failed to kick <@${target.id}>. Error: ${e.message}`).setColor('Red')] });
        }
    }

    // --- Ban
    else if (commandName === 'ban') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const deleteMessagesDays = interaction.options.getInteger('deletemessages') || 0; 
        const deleteMessageSeconds = deleteMessagesDays * 24 * 60 * 60; // Convert days to seconds

        // Basic check if the bot can ban the user
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (member && !member.bannable) {
             return interaction.editReply({ embeds: [new EmbedBuilder().setDescription(`Cannot ban <@${target.id}>. Check bot and user hierarchy.`).setColor('Red')] });
        }
        
        try {
            // --- DM the banned user before banning
            await sendAppealDM(target, 'Banned', reason, true);

            await interaction.guild.bans.create(target.id, {
                reason: reason,
                deleteMessageSeconds: deleteMessageSeconds,
            });

            const embed = new EmbedBuilder()
                .setTitle('User Banned')
                .setDescription(`<@${target.id}> was permanently banned.`)
                .addFields(
                    { name: 'User', value: `<@${target.id}>`, inline: true },
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Messages Deleted (Days)', value: deleteMessagesDays.toString() }
                )
                .setColor('DarkRed')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });

            // --- Log function call
            const logFields = [
                { name: 'Action', value: 'Ban', inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Target User', value: `<@${target.id}>`, inline: true },
                { name: 'Reason', value: reason }
            ];
            await logEmbed(interaction.guild, 'User Banned', `A user was permanently banned from the guild.`, logFields, 'DarkRed');

        } catch (e) {
            console.error('Failed to ban user:', e);
            await interaction.editReply({ embeds: [new EmbedBuilder().setDescription(`Failed to ban <@${target.id}>. Error: ${e.message}`).setColor('Red')] });
        }
    }

    // --- Create Violation
    else if (commandName === 'createviolation') {
        // Permissions check is already done by Discord, but kept for double-check
        if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            const embed = new EmbedBuilder()
                .setDescription('You lack permissions to create violations.')
                .setColor('Red')
                .setTimestamp();
            return interaction.editReply({ embeds: [embed] });
        }

        const target = interaction.options.getUser('user', true);
        const type = interaction.options.getString('type', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';

        const violation = addViolation(interaction.guild.id, target.id, {
            type, reason, moderatorId: interaction.user.id, channelId: interaction.channelId
        });
        
        // --- DM the user for manual violation
        await sendAppealDM(target, 'Violation', reason);

        const embed = new EmbedBuilder()
            .setTitle('Violation Created')
            .setDescription(`<@${target.id}> has been given a violation.`)
            .addFields(
                { name: 'User', value: `<@${target.id}>`, inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Type', value: type },
                { name: 'Reason', value: reason },
                { name: 'Violation ID', value: `\`${violation.id.substring(0, 8)}...\`` },
                { name: 'Channel', value: `${interaction.channel}` }
            )
            .setColor('Orange')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // UPDATED: Log function call with more details
        const logFields = [
            { name: 'Action', value: 'Manual Violation Creation', inline: true },
            { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Target User', value: `<@${target.id}>`, inline: true },
            { name: 'Violation Type', value: type },
            { name: 'Reason', value: reason },
            { name: 'Violation ID', value: `\`${violation.id}\`` }
        ];
        await logEmbed(interaction.guild, 'Violation Created by Moderator', `A moderator manually added a violation to a user.`, logFields, 'Orange');

        const userViolations = getViolations(interaction.guild.id, target.id);
        if (userViolations.length >= 3) {
            try {
                const member = await interaction.guild.members.fetch(target.id);
                // FIX: Timeout duration uses the constant (30 min)
                await member.timeout(TIMEOUT_DURATION_MS, 'Reached 3 violations');
                
                const embed2 = new EmbedBuilder()
                    .setTitle('User Timed Out')
                    .setDescription(`<@${target.id}> timed out for 30 minutes due to 3 violations.`)
                    .addFields(
                        { name: 'User', value: `<@${target.id}>` },
                        { name: 'Moderator', value: `<@${interaction.user.id}>` },
                        { name: 'Reason', value: 'Reached 3 violations (Manual Violation)' }
                    )
                    .setColor('Red')
                    .setTimestamp();
                await interaction.followUp({ embeds: [embed2] });

                // UPDATED: Log function call
                const timeoutLogFields = [
                    { name: 'User', value: `<@${target.id}>`, inline: true },
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: 'Reached 3 violations (Manual Timeout)' }
                ];
                await logEmbed(interaction.guild, 'User Timed Out', `<@${target.id}> was automatically timed out by a moderator's command.`, timeoutLogFields, 'Red');
            } catch(e) { console.error('Failed to timeout user', e.message); }
        }
    }

    // --- Remove Violation
    else if (commandName === 'removeviolation') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            const embed = new EmbedBuilder()
                .setDescription('You lack permissions to remove violations.')
                .setColor('Red')
                .setTimestamp();
            return interaction.editReply({ embeds: [embed] });
        }
        const target = interaction.options.getUser('user', true);
        const violationId = interaction.options.getString('violationid', true);
        const ok = removeViolation(interaction.guild.id, target.id, violationId);
        
        const embed = new EmbedBuilder()
            .setTitle('Violation Removal')
            .setDescription(ok ? `Removed violation **\`${violationId.substring(0, 8)}...\`** for <@${target.id}>.` : `Violation **\`${violationId.substring(0, 8)}...\`** not found for <@${target.id}>.`)
            .addFields(
                { name: 'User', value: `<@${target.id}>`, inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Violation ID', value: `\`${violationId}\`` },
                { name: 'Status', value: ok ? 'Success' : 'Failed' }
            )
            .setColor(ok ? 'Green' : 'Red')
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });

        // UPDATED: Log function call
        const logFields = [
            { name: 'Action', value: 'Violation Removal', inline: true },
            { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Target User', value: `<@${target.id}>`, inline: true },
            { name: 'Violation ID', value: `\`${violationId}\`` },
            { name: 'Status', value: ok ? 'Success' : 'Failed' }
        ];
        await logEmbed(interaction.guild, 'Violation Removed', `A violation was removed.`, logFields, ok ? 'Green' : 'Red');
    }

    // --- Check User
    else if (commandName === 'checkuser') {
        const target = interaction.options.getUser('user', true);
        const viols = getViolations(interaction.guild.id, target.id);
        
        if (viols.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('User Violations')
                .setDescription(`<@${target.id}> has no recorded violations.`)
                .setColor('Green')
                .setTimestamp();
            return await interaction.editReply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle(`Violations for ${target.tag}`)
            .setDescription(`Found **${viols.length}** violations. Showing the latest 10.`)
            .setColor('Orange')
            .setTimestamp();

        // Display only the latest 10 violations for brevity in an embed
        viols.slice(-10).reverse().forEach((v, index) => {
            embed.addFields({
                name: `Violation ${viols.length - index}: ${v.type} — \`${v.id.substring(0, 8)}\``,
                // Use relative timestamp for better Discord display
                value: `**Reason:** ${v.reason}\n**Moderator:** <@${v.moderatorId}>\n**Channel:** <#${v.channelId}>\n**Time:** <t:${Math.floor(new Date(v.timestamp).getTime() / 1000)}:R>`
            });
        });

        await interaction.editReply({ embeds: [embed] });
    }

    // --- Whitelist
    else if (commandName === 'whitelist') {
        const sub = interaction.options.getSubcommand();
        const userOpt = interaction.options.getUser('user');
        const roleOpt = interaction.options.getRole('role');
        const entity = userOpt || roleOpt;
        
        if (!entity) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setDescription('You must provide a user or a role.').setColor('Red')] });
        }

        let embed;
        let logTitle, logDescription, logColor, logFields = [];

        if (sub === 'add') {
            if (userOpt) {
                if (!data.whitelist.users.includes(userOpt.id)) {
                    data.whitelist.users.push(userOpt.id);
                }
                embed = new EmbedBuilder().setTitle('Whitelist Add').setDescription(`User <@${userOpt.id}> added to whitelist.`).setColor('Green');
                logTitle = 'Whitelist Addition';
                logDescription = `A user was manually whitelisted.`;
                logColor = 'Green';
                logFields = [
                    { name: 'Action', value: 'Whitelist Add' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'User Added', value: `<@${userOpt.id}>` }
                ];
            } else if (roleOpt) {
                if (!data.whitelist.roles.includes(roleOpt.id)) {
                    data.whitelist.roles.push(roleOpt.id);
                }
                embed = new EmbedBuilder().setTitle('Whitelist Add').setDescription(`Role **${roleOpt.name}** added to whitelist.`).setColor('Green');
                logTitle = 'Whitelist Addition';
                logDescription = `A role was manually whitelisted.`;
                logColor = 'Green';
                logFields = [
                    { name: 'Action', value: 'Whitelist Add' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'Role Added', value: `${roleOpt.name} (\`${roleOpt.id}\`)` }
                ];
            }
            saveData(data);

        } else if (sub === 'remove') {
            let removed = false;
            if (userOpt) {
                const index = data.whitelist.users.indexOf(userOpt.id);
                if (index > -1) {
                    data.whitelist.users.splice(index, 1);
                    removed = true;
                }
                embed = new EmbedBuilder().setTitle('Whitelist Remove').setDescription(removed ? `User <@${userOpt.id}> removed from whitelist.` : `User <@${userOpt.id}> was not in the whitelist.`).setColor(removed ? 'Orange' : 'Red');
                logTitle = 'Whitelist Removal';
                logDescription = `A user was removed from the whitelist.`;
                logColor = removed ? 'Orange' : 'Red';
                logFields = [
                    { name: 'Action', value: 'Whitelist Remove' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'User Removed', value: `<@${userOpt.id}>` },
                    { name: 'Status', value: removed ? 'Success' : 'Failed (Not Found)' }
                ];
            } else if (roleOpt) {
                const index = data.whitelist.roles.indexOf(roleOpt.id);
                if (index > -1) {
                    data.whitelist.roles.splice(index, 1);
                    removed = true;
                }
                embed = new EmbedBuilder().setTitle('Whitelist Remove').setDescription(removed ? `Role **${roleOpt.name}** removed from whitelist.` : `Role **${roleOpt.name}** was not in the whitelist.`).setColor(removed ? 'Orange' : 'Red');
                logTitle = 'Whitelist Removal';
                logDescription = `A role was removed from the whitelist.`;
                logColor = removed ? 'Orange' : 'Red';
                logFields = [
                    { name: 'Action', value: 'Whitelist Remove' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'Role Removed', value: `${roleOpt.name} (\`${roleOpt.id}\`)` },
                    { name: 'Status', value: removed ? 'Success' : 'Failed (Not Found)' }
                ];
            }
            saveData(data);
        }

        if (embed) {
            embed.setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            await logEmbed(interaction.guild, logTitle, logDescription, logFields, logColor);
        } else {
            // Should not happen with the command structure, but good for error handling
            await interaction.editReply({ embeds: [new EmbedBuilder().setDescription('Invalid whitelist action.').setColor('Red')] });
        }
    }
});

// --- Web Server (for keep-alive/monitoring if hosted externally)
const app = express();
app.get('/', (req, res) => {
    res.send(`Bot is running. Logged in as ${client.user?.tag || '...'}!`);
});
app.listen(PORT, () => {
    console.log(`Web server listening at http://localhost:${PORT}`);
});

// --- Login
client.login(TOKEN).catch(e => {
    console.error('Failed to log into Discord:', e.message);
    process.exit(1);
});