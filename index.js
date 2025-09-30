require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
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

// --- Appeal DM
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
    if (!member || isIgnored(member) || isWhitelisted(msg.guild.id, member)) return;
    const content = msg.content.toLowerCase();
    for (const w of offensiveWords) {
        if (content.includes(w)) {
            const reason = `Use of banned word: ${w}`;
            const violation = addViolation(msg.guild.id, msg.author.id, { type: 'HATE_SPEECH', reason, moderatorId: client.user.id, channelId: msg.channel.id });
            await sendAppealDM(msg.author, 'Violation', reason);
            const embed = new EmbedBuilder()
                .setTitle('🚨 Security Violation — HATE_SPEECH')
                .setDescription('Unauthorized message detected')
                .addFields(
                    { name: 'User', value: `<@${msg.author.id}>` },
                    { name: 'Channel', value: `${msg.channel}` },
                    { name: 'Violation ID', value: violation.id }
                )
                .setColor('Red').setTimestamp();
            await msg.channel.send({ embeds: [embed] });
            await logEmbed(msg.guild, 'Hate Speech Detected', `Banned word used.`, [{ name:'User',value:`<@${msg.author.id}>` }], 'Red');

            if (getViolations(msg.guild.id, msg.author.id).length >= 3) {
                const m = await msg.guild.members.fetch(msg.author.id);
                await m.timeout(30*60*1000,'3 violations');
            }
            await msg.delete().catch(()=>{});
            return;
        }
    }
});

// --- Audit Log Monitor
async function handleAuditAction(actionType, entity, userAffected) {
    try {
        const guild = entity.guild;
        const logs = await guild.fetchAuditLogs({ limit: 5, type: actionType });
        const entry = logs.entries.first(); if (!entry) return;
        const executor = entry.executor; if (!executor || executor.id===client.user.id) return;
        const member = await guild.members.fetch(executor.id).catch(()=>null); if(!member||isIgnored(member)||isWhitelisted(guild.id,member)) return;

        if(actionType==='MemberBan' && userAffected) await sendAppealDM(userAffected,'Banned','Banned by a moderator',true);
        try { await member.kick(`Unauthorized ${actionType}`); } catch(e){ console.error('Failed to kick',e);}
    } catch(err){ console.error('handleAuditAction error',err);}
}
client.on('channelCreate',ch=>handleAuditAction('ChannelCreate',ch));
client.on('channelDelete',ch=>handleAuditAction('ChannelDelete',ch));
client.on('roleCreate',r=>handleAuditAction('RoleCreate',r));
client.on('roleDelete',r=>handleAuditAction('RoleDelete',r));
client.on('guildBanAdd',ban=>handleAuditAction('MemberBan',ban.user,ban.user));

// --- Slash Commands
const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a user').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a user').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a user').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true))
        .addIntegerOption(o=>o.setName('deletemessages').setDescription('Days of messages to delete').setRequired(false)),
    new SlashCommandBuilder().setName('createviolation').setDescription('Create violation').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o=>o.setName('type').setDescription('Type').setRequired(true))
        .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('removeviolation').setDescription('Remove violation').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o=>o.setName('violationid').setDescription('Violation ID').setRequired(true)),
    new SlashCommandBuilder().setName('checkuser').setDescription('Check violations for user').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
];

async function registerCommands(){
    const rest = new REST({version:'10'}).setToken(TOKEN);
    try {
        if(GUILD_ID) await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID), { body: commands.map(c=>c.toJSON()) });
        else await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c=>c.toJSON()) });
        console.log('Commands registered');
    } catch(e){ console.error('Failed to register commands',e);}
}

client.on('ready', async ()=>{
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({ activities:[{name:'with my ban hammer',type:0}], status:'online' });
    await registerCommands();
});

// --- Interaction Handler
client.on('interactionCreate', async i=>{
    if(!i.isChatInputCommand()) return;
    await i.deferReply({ ephemeral:false });
    const c = i.commandName;
    if(c==='ping'){ return i.editReply({ embeds:[new EmbedBuilder().setTitle('🏓 Pong!').setDescription(`Latency: ${client.ws.ping}ms`).setColor('Green').setTimestamp()] }); }
    else if(c==='warn'){
        const u=i.options.getUser('user',true),r=i.options.getString('reason',true);
        await sendAppealDM(u,'Warned',r);
        const embed=new EmbedBuilder().setTitle('User Warned').setDescription(`<@${u.id}> warned`).addFields({name:'User',value:`<@${u.id}>`},{name:'Moderator',value:`<@${i.user.id}>`},{name:'Reason',value:r}).setColor('Yellow').setTimestamp();
        await i.editReply({embeds:[embed]});
    }
    else if(c==='kick'){
        const u=i.options.getUser('user',true),r=i.options.getString('reason',true),m=await i.guild.members.fetch(u.id).catch(()=>null);
        if(!m) return i.editReply({ embeds:[new EmbedBuilder().setDescription('User not found').setColor('Red')] });
        await sendAppealDM(u,'Kicked',r);
        await m.kick(r);
        await i.editReply({ embeds:[new EmbedBuilder().setTitle('User Kicked').setDescription(`<@${u.id}> kicked`).setColor('Orange').setTimestamp()] });
    }
    else if(c==='ban'){
        const u=i.options.getUser('user',true),r=i.options.getString('reason',true),d=i.options.getInteger('deletemessages')||0;
        await sendAppealDM(u,'Banned',r,true);
        await i.guild.bans.create(u.id,{reason:r,deleteMessageSeconds:d*24*60*60});
        await i.editReply({ embeds:[new EmbedBuilder().setTitle('User Banned').setDescription(`<@${u.id}> banned`).setColor('DarkRed').setTimestamp()] });
    }
});

// --- Login
client.login(TOKEN);

// --- Keep-Alive Server
const app = express();
app.get('/', (req,res)=>res.send('Bot is alive!'));
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
