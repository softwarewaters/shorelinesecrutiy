require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
// IGNORED_ROLES check: This array holds the Role IDs (or names) that bypass all security checks.
const IGNORED_ROLES = (process.env.IGNORED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = process.env.PORT || 3000;
const DATA_FILE = './data.json';

const APPEAL_CHANNEL_LINK = 'https://discord.com/channels/1394343761030676603/1395021234885890160';
const BAN_APPEAL_URL = 'https://shorelineinteractive.netlify.app/banappeal';

if (!TOKEN) { console.error('Please set TOKEN in .env'); process.exit(1); }

// --- Load / Save Data
function loadData() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } 
    catch { const init = { whitelist: { users: [], roles: [] }, violations: { byGuild: {} } }; fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2)); return init; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
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

// --- Utilities
// Check if a member has an ignored role
const isIgnored = member => IGNORED_ROLES.some(r => member.roles.cache.get(r) || member.roles.cache.find(x => x.name === r));
const isWhitelisted = (guildId, member) => {
    if (!member) return false;
    const whitelist = data.whitelist;
    if (whitelist.users.includes(member.id)) return true;
    return member.roles.cache.some(r => whitelist.roles.includes(r.id));
};

// --- Log Embed
async function logEmbed(guild, title, desc, fields, color) {
    if (!LOG_CHANNEL_ID) return;
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(desc).addFields(fields).setColor(color).setTimestamp();
    await ch.send({ embeds: [embed] });
}

// --- Appeal DM (For Bans/Kicks/Warns)
async function sendAppealDM(user, action, reason, isBan = false) {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Moderation Action: You were ${action}!`)
            .setDescription(`A moderation action has been taken against you.`)
            .addFields(
                { name: 'Action', value: action.toUpperCase(), inline: true },
                { name: 'Reason', value: reason || 'No specific reason provided.' }
            )
            .setColor(isBan ? 'DarkRed' : 'Orange')
            .setFooter({ text: 'Automated notification' })
            .setTimestamp();
        if (isBan) embed.addFields({ name: 'Ban Appeal', value: `[Ban Appeal Form](${BAN_APPEAL_URL})` });
        else embed.addFields({ name: 'Appeal Link', value: `[Go to Appeal Channel](${APPEAL_CHANNEL_LINK})` });
        await user.send({ embeds: [embed] });
    } catch (e) { console.warn(`Failed DM: ${user.tag}`, e.message); }
}

// --- Violation DM (For auto-logged security violations)
async function sendViolationDM(user, violationId, type, reason) {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Security Violation Added`)
            .setDescription(`A violation has been logged against you for unauthorized action or content.`)
            .addFields(
                { name: 'Violation Type', value: type, inline: true },
                { name: 'Violation ID (Needed for Appeal)', value: `\`${violationId}\`` },
                { name: 'Reason', value: reason || 'No specific reason provided.' }
            )
            .setColor('DarkOrange')
            .setFooter({ text: 'This is a security record. No immediate ban/kick was issued.' })
            .setTimestamp()
            .addFields({ name: 'Appeal Link', value: `[Go to Appeal Channel](${APPEAL_CHANNEL_LINK})` });
        await user.send({ embeds: [embed] });
    } catch (e) { console.warn(`Failed DM: ${user.tag}`, e.message); }
}

// --- Violations
function addViolation(guildId, userId, { type, reason, moderatorId, channelId }) {
    if (!data.violations.byGuild[guildId]) data.violations.byGuild[guildId] = {};
    if (!data.violations.byGuild[guildId][userId]) data.violations.byGuild[guildId][userId] = [];
    const violation = { id: uuidv4(), type, reason, moderatorId, channelId, timestamp: new Date().toISOString() };
    data.violations.byGuild[guildId][userId].push(violation);
    saveData(data);
    return violation;
}
function removeViolation(guildId, userId, violationId) {
    const arr = data.violations.byGuild[guildId]?.[userId]; if (!arr) return false;
    const idx = arr.findIndex(v => v.id === violationId); if (idx === -1) return false;
    arr.splice(idx, 1); saveData(data); return true;
}
function getViolations(guildId, userId) { return data.violations.byGuild[guildId]?.[userId] || []; }

// --- Offensive Words
const offensiveWords = ["nigger","nigga"];

// --- Message Monitor
client.on('messageCreate', async msg => {
    if (!msg.guild || msg.author.bot) return;
    const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    // CRITICAL CHECK: Ignore if the member has an ignored role or is whitelisted
    if (!member || isIgnored(member) || isWhitelisted(msg.guild.id, member)) return; 
    
    const content = msg.content.toLowerCase();
    for (const w of offensiveWords) {
        if (content.includes(w)) {
            const reason = `Use of banned word: ${w}`;
            const type = 'HATE_SPEECH';
            
            const violation = addViolation(msg.guild.id, msg.author.id, { type, reason, moderatorId: client.user.id, channelId: msg.channel.id });
            await sendViolationDM(msg.author, violation.id, type, reason);
            
            const replyEmbed = new EmbedBuilder()
                .setTitle('🚨 Security Violation — HATE_SPEECH')
                .setDescription('Unauthorized message detected and logged.')
                .addFields(
                    { name: 'User', value: `<@${msg.author.id}>`, inline: true },
                    { name: 'Channel', value: `${msg.channel}`, inline: true },
                    { name: 'Violation ID', value: `\`${violation.id}\`` }
                )
                .setColor('Red').setTimestamp();
            await msg.channel.send({ embeds: [replyEmbed] });
            
            await logEmbed(msg.guild, 'Hate Speech Detected (Violation Logged)', `Banned word used.`, [
                { name:'User',value:`<@${msg.author.id}>` },
                { name:'Channel',value:`${msg.channel}` },
                { name:'Violation ID', value: `\`${violation.id}\`` }
            ], 'Red');

            await msg.delete().catch(()=>{});
            return;
        }
    }
});

// --- Audit Log Monitor
async function handleAuditAction(actionType, entity, violationType, actionName) {
    try {
        const guild = entity.guild || entity.client.guilds.cache.get(GUILD_ID);
        if (!guild) return;

        const logs = await guild.fetchAuditLogs({ limit: 5, type: actionType });
        const entry = logs.entries.first(); 
        if (!entry) return;
        
        const executor = entry.executor; 
        if (!executor || executor.id === client.user.id) return;
        
        const member = await guild.members.fetch(executor.id).catch(()=>null); 
        // CRITICAL CHECK: Ignore if the member has an ignored role or is whitelisted
        if(!member || isIgnored(member) || isWhitelisted(guild.id, member)) return;

        // Log Violation instead of kick/ban
        const reason = `Unauthorized ${actionName} attempt.`;
        const violation = addViolation(guild.id, executor.id, { 
            type: violationType, 
            reason, 
            moderatorId: client.user.id, 
            channelId: entry.targetId 
        });

        await sendViolationDM(executor, violation.id, violationType, reason);

        // Log Channel Embed
        await logEmbed(guild, '🚨 Security Violation (Audit)', reason, [
            { name:'Executor',value:`<@${executor.id}>` },
            { name:'Action',value:actionName },
            { name:'Violation ID', value: `\`${violation.id}\`` }
        ], 'DarkRed');

        // Send a brief warning to the executor
        const warningEmbed = new EmbedBuilder()
            .setTitle('🚫 Unauthorized Action Logged')
            .setDescription(`The action **${actionName}** has been performed outside the whitelist. A violation has been logged.`)
            .addFields({ name: 'Violation ID', value: `\`${violation.id}\`` })
            .setColor('Red');
        await member.send({ embeds: [warningEmbed] }).catch(() => console.warn(`Failed to DM ${member.user.tag}`));


    } catch(err){ console.error('handleAuditAction error',err);}
}

client.on('channelCreate', ch => handleAuditAction('ChannelCreate', ch, 'CHANNEL_CREATE', 'Channel Creation'));
client.on('channelDelete', ch => handleAuditAction('ChannelDelete', ch, 'CHANNEL_DELETE', 'Channel Deletion'));
client.on('roleCreate', r => handleAuditAction('RoleCreate', r, 'ROLE_CREATE', 'Role Creation'));
client.on('roleDelete', r => handleAuditAction('RoleDelete', r, 'ROLE_DELETE', 'Role Deletion'));
client.on('guildBanAdd', ban => handleAuditAction('MemberBan', ban.user, 'MEMBER_BAN', 'Member Ban (User Banned)'));

// --- Slash Commands (ALL require Administrator)
const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    // Ban command with appeal link DM
    new SlashCommandBuilder().setName('ban').setDescription('Ban a user, DM them the appeal link, and log the action.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o=>o.setName('user').setDescription('User to be banned').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason for the ban').setRequired(true))
        .addIntegerOption(o=>o.setName('deletemessages').setDescription('Days of messages to delete (0-7)').setRequired(false)),
        
    new SlashCommandBuilder().setName('createviolation').setDescription('Create a manual violation for a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o=>o.setName('user').setDescription('User to violate').setRequired(true))
        .addStringOption(o=>o.setName('type').setDescription('Violation Type (e.g., MANUAL_WARN)').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason for the violation').setRequired(true)),
    new SlashCommandBuilder().setName('removeviolation').setDescription('Remove a violation by its serial ID').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o=>o.setName('user').setDescription('User who has the violation').setRequired(true))
        .addStringOption(o=>o.setName('violationid').setDescription('The serial ID of the violation to remove').setRequired(true)),
    new SlashCommandBuilder().setName('checkuser').setDescription('View all violations for a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o=>o.setName('user').setDescription('User to check').setRequired(true))
];

async function registerCommands(){
    const rest = new REST({version:'10'}).setToken(TOKEN);
    try {
        const CLIENT_ID = process.env.CLIENT_ID; 
        if (!CLIENT_ID) return console.error('CLIENT_ID not set, cannot register commands.');

        if(GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c=>c.toJSON()) });
        else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c=>c.toJSON()) });
        console.log('Commands registered');
    } catch(e){ console.error('Failed to register commands',e);}
}

client.on('ready', async ()=>{
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({ activities:[{name:'With My Ban Hammer',type:0}], status:'online' });
    await registerCommands();
});

// --- Interaction Handler (Updated to use i.reply({ ephemeral: true }) and i.channel.send({ embeds }))
client.on('interactionCreate', async i=>{
    if(!i.isChatInputCommand() || !i.guild) return;

    // Command Permissions Check (Always reply ephemeral for denied access)
    if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return i.reply({ content: '❌ **Access Denied:** You must be an Administrator to use this command.', ephemeral: true });
    }

    const c = i.commandName;
    const moderatorTag = i.user.tag; // Used only for logging

    // All successful commands will reply ephemeral first, then send the public embed.

    if(c==='ping'){ 
        // Ping is simple, can just be an ephemeral reply
        return i.reply({ embeds:[new EmbedBuilder().setTitle('🏓 Pong!').setDescription(`Latency: ${client.ws.ping}ms`).setColor('Green').setTimestamp()], ephemeral: true }); 
    }
    
    // --- /ban handler ---
    else if(c==='ban'){
        const targetUser = i.options.getUser('user', true);
        const reason = i.options.getString('reason', true);
        const deleteDays = i.options.getInteger('deletemessages') || 0; 
        const deleteSeconds = deleteDays * 24 * 60 * 60;

        try {
            await sendAppealDM(targetUser, 'Banned', reason, true); 
            
            await i.guild.bans.create(targetUser.id, {
                reason: `Banned by ${moderatorTag}: ${reason}`,
                deleteMessageSeconds: deleteSeconds
            });
            
            // Public Channel Embed (DOES NOT include moderator)
            const publicEmbed = new EmbedBuilder()
                .setTitle('🔨 User Banned')
                .setDescription(`The user **${targetUser.tag}** has been banned from the server.`)
                .addFields(
                    { name: 'User', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Messages Deleted', value: `${deleteDays} days` }
                )
                .setColor(0xCC0000) // Darker Red for severity
                .setTimestamp();

            await i.channel.send({ embeds: [publicEmbed] });
            
            // Ephemeral confirmation to the admin
            await i.reply({ content: `✅ **SUCCESS:** Banned ${targetUser.tag} and sent DM. Action details logged.`, ephemeral: true });
            
            // Log Channel Embed (INCLUDES moderator)
            await logEmbed(i.guild, 'User Banned', `${moderatorTag} banned a user.`, [
                { name:'Target User',value:`<@${targetUser.id}>` },
                { name:'Moderator',value:`<@${i.user.id}>` },
                { name:'Reason',value:reason }
            ], 'DarkRed');

        } catch (error) {
            console.error(`Ban failed for ${targetUser.tag}:`, error);
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ Ban Failed')
                .setDescription(`Could not ban ${targetUser.tag}. Check bot permissions/hierarchy.`)
                .addFields({ name: 'Error Detail', value: error.message.substring(0, 100) + '...' })
                .setColor('Red').setTimestamp();
            await i.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }

    // --- /createviolation handler ---
    else if(c==='createviolation'){
        const targetUser = i.options.getUser('user', true);
        const type = i.options.getString('type', true);
        const reason = i.options.getString('reason', true);

        const violation = addViolation(i.guild.id, targetUser.id, { 
            type, 
            reason, 
            moderatorId: i.user.id, 
            channelId: i.channel.id 
        });

        await sendViolationDM(targetUser, violation.id, type, reason);
        
        // Public Channel Embed (DOES NOT include moderator)
        const publicEmbed = new EmbedBuilder()
            .setTitle('⚠️ Security Violation Logged')
            .setDescription(`A **${type}** violation has been recorded for ${targetUser.tag}.`)
            .addFields(
                { name: 'User', value: `<@${targetUser.id}>`, inline: true },
                { name: 'Reason', value: reason },
                { name: 'Violation ID', value: `\`${violation.id}\`` }
            )
            .setColor(0xFFA500) // Orange
            .setTimestamp();

        await i.channel.send({ embeds: [publicEmbed] });
        
        // Ephemeral confirmation to the admin
        await i.reply({ content: `✅ **SUCCESS:** Created violation for ${targetUser.tag}. ID: \`${violation.id}\`. Action details logged.`, ephemeral: true });

        // Log Channel Embed (INCLUDES moderator)
        await logEmbed(i.guild, 'Manual Violation Created', `${moderatorTag} created a violation.`, [
            { name:'Target User',value:`<@${targetUser.id}>` },
            { name:'Type',value:type },
            { name:'Violation ID', value: `\`${violation.id}\`` },
            { name:'Reason',value:reason }
        ], 'Orange');
    }

    // --- /removeviolation handler ---
    else if(c==='removeviolation'){
        const targetUser = i.options.getUser('user', true);
        const violationId = i.options.getString('violationid', true);

        const success = removeViolation(i.guild.id, targetUser.id, violationId);

        if (success) {
            // Public Channel Embed (DOES NOT include moderator)
            const publicEmbed = new EmbedBuilder()
                .setTitle('✅ Violation Cleared')
                .setDescription(`A violation has been successfully removed from ${targetUser.tag}'s record.`)
                .addFields(
                    { name: 'User', value: `<@${targetUser.id}>` },
                    { name: 'Violation ID', value: `\`${violationId}\`` }
                )
                .setColor(0x32CD32) // Lime Green
                .setTimestamp();

            await i.channel.send({ embeds: [publicEmbed] });
            
            // Ephemeral confirmation to the admin
            await i.reply({ content: `✅ **SUCCESS:** Removed violation \`${violationId}\` for ${targetUser.tag}. Action details logged.`, ephemeral: true });
            
            // Log Channel Embed (INCLUDES moderator)
            await logEmbed(i.guild, 'Violation Removed', `${moderatorTag} removed a violation.`, [
                { name:'Target User',value:`<@${targetUser.id}>` },
                { name:'Violation ID', value: `\`${violationId}\`` }
            ], 'Green');

        } else {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ Removal Failed')
                .setDescription(`Could not find violation with ID \`${violationId}\` for ${targetUser.tag}.`)
                .setColor('Red').setTimestamp();
            await i.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }

    // --- /checkuser handler ---
    else if(c==='checkuser'){
        const targetUser = i.options.getUser('user', true);
        const violations = getViolations(i.guild.id, targetUser.id);

        let description = `Total violations found: **${violations.length}**`;
        const fields = [];

        if (violations.length > 0) {
            const recentViolations = violations.slice(-5).reverse(); 
            for (const v of recentViolations) {
                const date = new Date(v.timestamp).toLocaleDateString('en-US');
                const time = new Date(v.timestamp).toLocaleTimeString('en-US');

                // Note: We include the moderator ID in the checkuser output as it's typically run by a moderator
                // checking records, even if sent publicly, but we'll remove the <@... tag for clean output.
                fields.push({
                    name: `[${v.type}] - \`${v.id}\``,
                    value: `**Reason:** ${v.reason}\n**Date:** ${date} @ ${time}`,
                    inline: false
                });
            }
            if (violations.length > 5) {
                description += `\n*Showing the last 5 violations. There are ${violations.length - 5} older violations not displayed.*`;
            }
        } else {
             fields.push({ name: 'Status', value: 'No violations recorded for this user.', inline: true });
        }

        // Public Channel Embed (DOES NOT include moderator)
        const publicEmbed = new EmbedBuilder()
            .setTitle(`📜 Violation Record for ${targetUser.tag}`)
            .setDescription(description)
            .addFields(fields)
            .setColor(0x00BFFF) // Deep Sky Blue
            .setTimestamp()
            .setFooter({ text: 'Violation records are for security use only.' });

        await i.channel.send({ embeds: [publicEmbed] });
        
        // Ephemeral confirmation to the admin
        await i.reply({ content: `✅ **SUCCESS:** Sent violation record for ${targetUser.tag}. Action details logged.`, ephemeral: true });

        // Log Channel Embed (INCLUDES moderator)
        await logEmbed(i.guild, 'Violation Check Performed', `${moderatorTag} checked user's violations.`, [
            { name:'Target User',value:`<@${targetUser.id}>` }
        ], 'Blue');
    }
});

// --- Login
client.login(TOKEN);

// --- Keep-Alive Server
const app = express();
app.get('/', (req,res)=>res.send('Bot is alive!'));
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));