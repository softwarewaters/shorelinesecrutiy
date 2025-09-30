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

// Appeal links
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
    } catch {
        const init = { whitelist: { users: [], roles: [] }, violations: { byGuild: {} } };
        fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let data = loadData();

// --- Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildBans
    ],
    partials: [Partials.Channel, Partials.Message]
});

// --- Utility
const isIgnored = member => member ? IGNORED_ROLES.some(r => member.roles.cache.has(r) || member.roles.cache.find(x => x.name === r)) : false;
const isWhitelisted = (guildId, member) => {
    if (!member) return false;
    const guildWhitelist = data.whitelist || { users: [], roles: [] };
    if (guildWhitelist.users.includes(member.id)) return true;
    return member.roles.cache.some(r => guildWhitelist.roles.includes(r.id));
};

async function logEmbed(guild, title, description, fields, color='Blue') {
    if (!LOG_CHANNEL_ID || !guild) return;
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .addFields(fields || [])
        .setColor(color)
        .setTimestamp();
    await ch.send({ embeds: [embed] }).catch(() => {});
}

async function sendAppealDM(user, action, reason, isBan=false) {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Moderation Action: You were ${action}!`)
            .setDescription('A moderation action has been taken against you in the server.')
            .addFields(
                { name: 'Action', value: action.toUpperCase(), inline: true },
                { name: 'Reason', value: reason || 'No reason provided.' }
            )
            .setColor(isBan ? 'DarkRed' : 'Orange')
            .setFooter({ text: 'Automated notification from server security bot.' })
            .setTimestamp();

        if (isBan) embed.addFields({ name: 'Ban Appeal', value: `[Ban Appeal Form](${BAN_APPEAL_URL})` });
        else embed.addFields({ name: 'Appeal Link', value: `[Go to Appeal Channel](${APPEAL_CHANNEL_LINK})` });

        await user.send({ embeds: [embed] });
    } catch { /* silently fail */ }
}

// --- Violations
function addViolation(guildId, userId, { type, reason, moderatorId, channelId }) {
    data.violations.byGuild[guildId] ||= {};
    data.violations.byGuild[guildId][userId] ||= [];
    const id = uuidv4();
    const violation = { id, type, reason, moderatorId, channelId, timestamp: new Date().toISOString() };
    data.violations.byGuild[guildId][userId].push(violation);
    saveData(data);
    return violation;
}
function removeViolation(guildId, userId, violationId) {
    const arr = data.violations.byGuild[guildId]?.[userId];
    if (!arr) return false;
    const idx = arr.findIndex(v => v.id === violationId);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    saveData(data);
    return true;
}
function getViolations(guildId, userId) {
    return data.violations.byGuild[guildId]?.[userId] || [];
}

// --- Offensive words
const offensiveWords = ["nigger", "nigga"];

// --- Message monitor
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member || isIgnored(member) || isWhitelisted(message.guild.id, member)) return;

    const content = (message.content || '').toLowerCase();
    for (const w of offensiveWords) {
        if (content.includes(w)) {
            const reason = `Use of banned word: ${w}`;
            const violation = addViolation(message.guild.id, message.author.id, { type: 'HATE_SPEECH', reason, moderatorId: client.user.id, channelId: message.channel.id });
            await sendAppealDM(message.author, 'Violation', reason);

            const embed = new EmbedBuilder()
                .setTitle('🚨 Security Violation — HATE_SPEECH')
                .setDescription('An unauthorized message was detected.')
                .addFields(
                    { name: 'User', value: `<@${message.author.id}>` },
                    { name: 'Channel', value: `${message.channel}` },
                    { name: 'Violation Type', value: 'HATE_SPEECH' },
                    { name: 'Word Detected', value: w },
                    { name: 'Violation ID', value: violation.id }
                )
                .setColor('Red')
                .setTimestamp();

            await message.channel.send({ embeds: [embed] }).catch(() => {});
            await logEmbed(message.guild, 'Hate Speech Detected', `User posted a banned word.`, [
                { name: 'User', value: `<@${message.author.id}>`, inline: true },
                { name: 'Channel', value: `${message.channel}`, inline: true },
                { name: 'Violation ID', value: violation.id }
            ], 'Red');

            const userViolations = getViolations(message.guild.id, message.author.id);
            if (userViolations.length >= 3) {
                try {
                    await member.timeout(30*60*1000, 'Reached 3 violations');
                    await logEmbed(message.guild, 'User Timed Out', `User reached 3 violations.`, [
                        { name: 'User', value: `<@${member.id}>`, inline: true }
                    ], 'Orange');
                } catch {}
            }
            await message.delete().catch(() => {});
            return;
        }
    }
});

// --- Audit log monitor
async function handleAuditAction(type, entity, userAffected) {
    try {
        const guild = entity.guild;
        const logs = await guild.fetchAuditLogs({ limit: 5, type });
        const entry = logs.entries.first();
        if (!entry) return;
        const executor = entry.executor;
        if (!executor || executor.id === client.user.id) return;
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member || isIgnored(member) || isWhitelisted(guild.id, member)) return;

        if (type === 'MemberBan' && userAffected) await sendAppealDM(userAffected, 'Banned', 'Banned by a moderator', true);

        try {
            await member.kick(`Unauthorized ${type} detected`);
            await logEmbed(guild, 'Unauthorized Action', `Executor kicked for unauthorized action.`, [
                { name: 'Executor', value: `<@${executor.id}>` },
                { name: 'Action', value: type },
                { name: 'Target', value: userAffected ? userAffected.tag : entity.id }
            ], 'Red');
        } catch {}
    } catch {}
}

client.on('channelCreate', ch => handleAuditAction('ChannelCreate', ch));
client.on('channelDelete', ch => handleAuditAction('ChannelDelete', ch));
client.on('roleCreate', r => handleAuditAction('RoleCreate', r));
client.on('roleDelete', r => handleAuditAction('RoleDelete', r));
client.on('guildBanAdd', ban => handleAuditAction('MemberBan', ban.user, ban.user));

// --- Register slash commands
const commands = [ /* your commands from above */ ]; // reuse your defined SlashCommandBuilder array
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        const appId = client.application?.id || process.env.CLIENT_ID || '0';
        if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands.map(c => c.toJSON()) });
        else await rest.put(Routes.applicationCommands(appId), { body: commands.map(c => c.toJSON()) });
    } catch(e) { console.error(e); }
}

// --- Ready
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({ activities:[{ name: 'with my ban hammer', type: 0 }], status:'online' });
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