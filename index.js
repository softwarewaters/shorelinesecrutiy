require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = './data.json';
const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const IGNORED_ROLES = (process.env.IGNORED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.PORT || 3000;

// --- Appeal Links (New Constants)
const APPEAL_CHANNEL_LINK = 'https://discord.com/channels/1394343761030676603/1395021234885890160';
const BAN_APPEAL_URL = 'https://shorelineinteractive.netlify.app/banappeal';

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
    if (!member) return false;
    for (const roleIdOrName of IGNORED_ROLES) {
        if (!roleIdOrName) continue;
        const r = member.roles.cache.get(roleIdOrName) || member.roles.cache.find(x => x.name === roleIdOrName);
        if (r) return true;
    }
    return false;
}

function isWhitelisted(guildId, member) {
    if (!member) return false;
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
        console.error('Failed to send log embed:', e);
    }
}

// --- Appeal DM Function (New Function)
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
        console.warn(`Failed to send appeal DM to ${user.tag} (${user.id}) for ${action}:`, e.message);
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
    if (!message.guild || message.author.bot) return;
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;
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
                .setDescription(`An unauthorized message was detected.`)
                .addFields(
                    { name: 'User', value: `<@${message.author.id}>` },
                    { name: 'Channel', value: `${message.channel}` },
                    { name: 'Violation Type', value: 'HATE_SPEECH' },
                    { name: 'Word Detected', value: w },
                    { name: 'Violation ID', value: violation.id },
                    { name: 'Moderator', value: `<@${client.user.id}>` },
                    { name: 'Timestamp', value: new Date().toLocaleString() }
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
                { name: 'Violation ID', value: violation.id }
            ];
            await logEmbed(message.guild, 'Hate Speech Detected', `A user posted a banned word.`, logFields, 'Red');

            const userViolations = getViolations(message.guild.id, message.author.id);
            if (userViolations.length >= 3) {
                try {
                    const memberToTimeout = await message.guild.members.fetch(message.author.id);
                    await memberToTimeout.timeout(30 * 60 * 1000, '3 security violations');
                    const timeoutEmbed = new EmbedBuilder()
                        .setTitle('User Timed Out')
                        .setDescription(`<@${message.author.id}> was timed out for 30 minutes due to reaching 3 violations.`)
                        .addFields(
                            { name: 'User', value: `<@${message.author.id}>` },
                            { name: 'Channel', value: `${message.channel}` },
                            { name: 'Moderator', value: `<@${client.user.id}>` },
                            { name: 'Time', value: new Date().toLocaleString() }
                        )
                        .setColor('Orange')
                        .setTimestamp();
                    await message.channel.send({ embeds: [timeoutEmbed] });
                    // UPDATED: Log function call
                    const timeoutLogFields = [
                        { name: 'User', value: `<@${message.author.id}>`, inline: true },
                        { name: 'Moderator', value: `<@${client.user.id}>`, inline: true },
                        { name: 'Reason', value: 'Reached 3 violations' }
                    ];
                    await logEmbed(message.guild, 'User Timed Out', `<@${message.author.id}> was automatically timed out.`, timeoutLogFields, 'Orange');
                } catch (e) {
                    console.error('Failed to timeout member', e);
                }
            }

            try { await message.delete().catch(() => {}); } catch (e) {}
            return;
        }
    }
});

// --- Audit log monitor
async function handleAuditAction(actionType, entity, userThatGotAffected) { // Added userThatGotAffected parameter
    try {
        const guild = entity.guild;
        const logs = await guild.fetchAuditLogs({ limit: 5, type: actionType });
        const entry = logs.entries.first();
        if (!entry) return;
        const executor = entry.executor;
        if (!executor) return;
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return;
        if (executor.id === client.user.id) return;
        if (isIgnored(member) || isWhitelisted(guild.id, member)) return;
        
        // --- DM for external Ban (if the bot didn't issue it)
        if (actionType === 'MemberBan' && userThatGotAffected) {
            await sendAppealDM(userThatGotAffected, 'Banned', 'Banned by a moderator', true);
        }

        const targetName = entity.name || (userThatGotAffected ? userThatGotAffected.tag : entity.id);

        try {
            await member.kick(`Unauthorized ${actionType} detected`);
            const logFields = [
                { name: 'Executor', value: `<@${executor.id}>` },
                { name: 'Action', value: actionType },
                { name: 'Target', value: targetName },
                { name: 'Channel', value: 'Audit Log' },
                { name: 'Time', value: new Date().toLocaleString() }
            ];
            await logEmbed(guild, 'Unauthorized Action - User Kicked', `An unauthorized administrative action was detected and the executor was kicked.`, logFields, 'Red');
        } catch (e) {
            console.error('Failed to kick executor', e);
            const logFields = [
                { name: 'Executor', value: `<@${executor.id}>` },
                { name: 'Action', value: actionType },
                { name: 'Target', value: targetName },
                { name: 'Error', value: e.message },
                { name: 'Time', value: new Date().toLocaleString() }
            ];
            await logEmbed(guild, 'Unauthorized Action - Failed to Kick', `An unauthorized action was detected, but the bot failed to kick the executor.`, logFields, 'Red');
        }
    } catch (err) {
        console.error('handleAuditAction error', err);
    }
}

client.on('channelCreate', async ch => handleAuditAction('ChannelCreate', ch));
client.on('channelDelete', async ch => handleAuditAction('ChannelDelete', ch));
client.on('roleCreate', async role => handleAuditAction('RoleCreate', role));
client.on('roleDelete', async role => handleAuditAction('RoleDelete', role));
client.on('guildBanAdd', async ban => handleAuditAction('MemberBan', ban.user, ban.user));

// --- Slash commands (Updated with new commands)
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
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(client.application?.id || process.env.CLIENT_ID || '0', GUILD_ID), { body: commands.map(c => c.toJSON()) });
            console.log('Registered guild commands');
        } else {
            await rest.put(Routes.applicationCommands(client.application?.id || process.env.CLIENT_ID || '0'), { body: commands.map(c => c.toJSON()) });
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
        activities: [{ name: 'with my ban hammer', type: 0 }], // Changed type from 3 to 0
        status: 'online'
    });
    await registerCommands();
});

// --- Slash command handler (UPDATED: All replies are now embeds in the channel)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
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

    // --- Warn (New Handler)
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

    // --- Kick (New Handler)
    else if (commandName === 'kick') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setDescription('User not found in guild.').setColor('Red')] });
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

    // --- Ban (New Handler)
    else if (commandName === 'ban') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const deleteMessagesDays = interaction.options.getInteger('deletemessages') || 0; // Default to 0 days

        try {
            // --- DM the banned user before banning
            await sendAppealDM(target, 'Banned', reason, true);

            await interaction.guild.bans.create(target.id, {
                reason: reason,
                deleteMessageSeconds: deleteMessagesDays * 24 * 60 * 60, // Convert days to seconds
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
                { name: 'Violation ID', value: violation.id },
                { name: 'Channel', value: `${interaction.channel}` },
                { name: 'Time', value: new Date().toLocaleString() }
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
                await member.timeout(30 * 60 * 1000, 'Reached 3 violations');
                const embed2 = new EmbedBuilder()
                    .setTitle('User Timed Out')
                    .setDescription(`<@${target.id}> timed out for 30 minutes due to 3 violations.`)
                    .addFields(
                        { name: 'User', value: `<@${target.id}>` },
                        { name: 'Moderator', value: `<@${interaction.user.id}>` },
                        { name: 'Channel', value: `${interaction.channel}` },
                        { name: 'Time', value: new Date().toLocaleString() }
                    )
                    .setColor('Red')
                    .setTimestamp();
                await interaction.followUp({ embeds: [embed2] });

                // UPDATED: Log function call
                const timeoutLogFields = [
                    { name: 'User', value: `<@${target.id}>`, inline: true },
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: 'Reached 3 violations' }
                ];
                await logEmbed(interaction.guild, 'User Timed Out', `<@${target.id}> was automatically timed out by a moderator's command.`, timeoutLogFields, 'Red');
            } catch(e) { console.error('Failed to timeout user', e); }
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
            .setDescription(ok ? `Removed violation **\`${violationId}\`** for <@${target.id}>.` : `Violation **\`${violationId}\`** not found for <@${target.id}>.`)
            .addFields(
                { name: 'User', value: `<@${target.id}>` },
                { name: 'Moderator', value: `<@${interaction.user.id}>` },
                { name: 'Violation ID', value: `\`${violationId}\`` },
                { name: 'Channel', value: `${interaction.channel}` },
                { name: 'Time', value: new Date().toLocaleString() }
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
                .setDescription(`<@${target.id}> has no violations.`)
                .setColor('Green')
                .setTimestamp();
            return await interaction.editReply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle(`Violations for ${target.tag}`)
            .setDescription(`Found **${viols.length}** violations.`)
            .setColor('Orange')
            .setTimestamp();

        viols.slice(0, 10).forEach((v, index) => {
            embed.addFields({
                name: `Violation ${index + 1}: ${v.type} — \`${v.id.substring(0, 8)}\``,
                value: `**Reason:** ${v.reason}\n**Moderator:** <@${v.moderatorId}>\n**Channel:** <#${v.channelId}>\n**Time:** <t:${Math.floor(new Date(v.timestamp).getTime() / 1000)}:F>`
            });
        });

        await interaction.editReply({ embeds: [embed] });
    }

    // --- Whitelist
    else if (commandName === 'whitelist') {
        const sub = interaction.options.getSubcommand();
        const userOpt = interaction.options.getUser('user');
        const roleOpt = interaction.options.getRole('role');

        let embed;
        let logTitle, logDescription, logColor, logFields = [];

        if (sub === 'add') {
            if (userOpt) {
                if (!data.whitelist.users.includes(userOpt.id)) {
                    data.whitelist.users.push(userOpt.id);
                }
                embed = new EmbedBuilder().setTitle('Whitelist Add').setDescription(`User <@${userOpt.id}> added to whitelist`).setColor('Green');
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
                embed = new EmbedBuilder().setTitle('Whitelist Add').setDescription(`Role <@&${roleOpt.id}> added to whitelist`).setColor('Green');
                logTitle = 'Whitelist Addition';
                logDescription = `A role was manually whitelisted.`;
                logColor = 'Green';
                logFields = [
                    { name: 'Action', value: 'Whitelist Add' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'Role Added', value: `<@&${roleOpt.id}>` }
                ];
            } else {
                embed = new EmbedBuilder().setDescription('You must provide a user or a role.').setColor('Red');
            }
        } else if (sub === 'remove') {
            if (userOpt) {
                const initialLength = data.whitelist.users.length;
                data.whitelist.users = data.whitelist.users.filter(x => x !== userOpt.id);
                const removed = initialLength !== data.whitelist.users.length;
                embed = new EmbedBuilder().setTitle('Whitelist Removal').setDescription(removed ? `User <@${userOpt.id}> removed from whitelist` : `User not found in whitelist`).setColor(removed ? 'Orange' : 'Red');
                logTitle = 'Whitelist Removal';
                logDescription = `A user was removed from the whitelist.`;
                logColor = 'Orange';
                logFields = [
                    { name: 'Action', value: 'Whitelist Removal' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'User Removed', value: `<@${userOpt.id}>` },
                    { name: 'Status', value: removed ? 'Success' : 'Failed' }
                ];
            } else if (roleOpt) {
                const initialLength = data.whitelist.roles.length;
                data.whitelist.roles = data.whitelist.roles.filter(x => x !== roleOpt.id);
                const removed = initialLength !== data.whitelist.roles.length;
                embed = new EmbedBuilder().setTitle('Whitelist Removal').setDescription(removed ? `Role <@&${roleOpt.id}> removed from whitelist` : `Role not found in whitelist`).setColor(removed ? 'Orange' : 'Red');
                logTitle = 'Whitelist Removal';
                logDescription = `A role was removed from the whitelist.`;
                logColor = 'Orange';
                logFields = [
                    { name: 'Action', value: 'Whitelist Removal' },
                    { name: 'Moderator', value: `<@${interaction.user.id}>` },
                    { name: 'Role Removed', value: `<@&${roleOpt.id}>` },
                    { name: 'Status', value: removed ? 'Success' : 'Failed' }
                ];
            } else {
                embed = new EmbedBuilder().setDescription('You must provide a user or a role.').setColor('Red');
            }
        }

        saveData(data);
        embed.setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        if (logFields.length > 0) {
            await logEmbed(interaction.guild, logTitle, logDescription, logFields, logColor);
        }
    }
});

// --- Login
client.login(TOKEN);

// --- Keep-alive server
const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));