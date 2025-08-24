// =======================================================================
// ===                    HORIMEKI - STAY VOICE BOT                    ===
// ===                  PHIÊN BẢN 36 (Stability Patch)                 ===
// =======================================================================

const Discord = require('discord.js-selfbot-v13');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');


process.on('unhandledRejection', (reason, promise) => {
  console.log(chalk.red.bold('\n[!!!] LỖI CHƯA XỬ LÝ (Unhandled Rejection):'), reason);
  
});

process.on('uncaughtException', (err, origin) => {
  console.log(chalk.red.bold(`\n[!!!] LỖI NGHIÊM TRỌNG (Uncaught Exception): ${err}\n` + `Nguồn gốc lỗi: ${origin}`));
  // cleanExit(1);
});


const DISCONNECTED_GRACE_MS = 20000;
const READY_TIMEOUT_MS = 15000;

const STICKY_TARGET = true;
const STICKY_DEBOUNCE_MS = 800;
const STICKY_COOLDOWN_MS = 5000;


// =======================================================================
// ===                         COLORS                                  ===
// =======================================================================
const log = {
    info: (...args) => console.log(chalk.cyan.bold('[ℹ]'), ...args.map(a => chalk.cyan(a))),
    success: (...args) => console.log(chalk.green.bold('[✓]'), ...args.map(a => chalk.green(a))),
    warn: (...args) => console.log(chalk.yellow.bold('[!]'), ...args.map(a => chalk.yellow(a))),
    error: (...args) => console.log(chalk.red.bold('[✕]'), ...args.map(a => chalk.red(a))),
    event: (...args) => console.log(chalk.magenta.bold('[ᴇ]'), ...args.map(a => chalk.magenta(a))),
    reconnect: (...args) => console.log(chalk.blue.bold('[↻]'), ...args.map(a => chalk.blue(a))),
    sticky: (...args) => console.log(chalk.hex('#FF9900').bold('[📌]'), ...args.map(a => chalk.hex('#FF9900')(a))),
    system: (...args) => console.log(chalk.gray(...args)),
};


class LimitedCollection extends Discord.Collection {
    constructor(options = {}) {
        super();
        this.maxSize = options.maxSize === undefined ? Infinity : options.maxSize;
    }

    set(key, value) {
        if (this.maxSize === 0) return this;
        if (this.size >= this.maxSize && !this.has(key)) {
            this.delete(this.keys().next().value);
        }
        return super.set(key, value);
    }
}

const client = new Discord.Client({
    checkUpdate: false,
    
    makeCache: (manager) => {
        switch (manager.name) {
            case 'GuildManager':
            case 'ChannelManager':
            case 'GuildChannelManager':
            case 'RoleManager':
            case 'PermissionOverwriteManager':
            case 'GuildMemberManager':
            case 'UserManager':
                return new Discord.Collection();
            case 'MessageManager':
            case 'PresenceManager':
            case 'GuildStickerManager':
            case 'GuildEmojiManager':
            case 'GuildScheduledEventManager':
            case 'StageInstanceManager':
            case 'ThreadManager':
                return new LimitedCollection({ maxSize: 0 });
            default:
                return new LimitedCollection({ maxSize: 0 });
        }
    },

    sweepers: {
        threads: { interval: 3600, lifetime: 1800 },
        messages: { interval: 3600, lifetime: 1800 }
    }
});

let connection = null;
let targetGuildId = null;
let targetChannelId = null;

let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnecting = false;
let reconnectGen = 0;
let permanentBlockReason = null;
let lastReadyAt = 0;

let stickyTimer = null;
let lastStickyPullAt = 0;

let isJoining = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });


const q = (prompt) => new Promise((res) => {
    rl.question(chalk.greenBright(`   └── ${prompt}`), res);
});


function clearReconnect() {
  reconnecting = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}


function stopReconnectPermanently(reason, note) {
  permanentBlockReason = reason;
  clearReconnect();
  targetGuildId = null;
  targetChannelId = null;
  log.warn(`Dừng reconnect vĩnh viễn: ${reason}${note ? ' - ' + note : ''}`);
  log.info('Dùng lệnh "join" để chọn kênh khác');
}


function isVoiceLike(ch) {
  return (
    ch?.type === 2 || ch?.type === 13 ||
    ch?.type === 'GUILD_VOICE' || ch?.type === 'GUILD_STAGE_VOICE' || 
    ch?.isVoice?.() === true
  );
}


function canViewAndConnect(ch) {
  try {
    const me = ch.guild?.members?.cache?.get(client.user.id);
    if (!me) return false;
    const perms = ch.permissionsFor(me);
    return perms?.has?.(['ViewChannel', 'Connect']) ?? false;
  } catch {
    return true;
  }
}

function attemptReconnect(source = 'unknown') {
  if (permanentBlockReason) {
    log.info(`Bỏ qua reconnect (${source}) vì lỗi vĩnh viễn: ${permanentBlockReason}`);
    return;
  }
  if (!targetGuildId || !targetChannelId) return;
  if (reconnecting || isJoining) return;

  reconnecting = true;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  const myGen = ++reconnectGen;

  log.reconnect(`Thử kết nối lại lần ${reconnectAttempts} sau ${Math.round(delay/1000)}s... (src=${source}, gen=${myGen})`);
  
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    if (myGen !== reconnectGen) return;

    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(guild)');
    const ch = guild.channels.cache.get(targetChannelId);
    if (!ch) return stopReconnectPermanently('CHANNEL_NOT_FOUND', `(channel ${targetChannelId})`);
    if (!isVoiceLike(ch)) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(not voice)');
    if (!canViewAndConnect(ch)) return stopReconnectPermanently('MISSING_PERMISSIONS', ch.name);

    joinVC(targetGuildId, targetChannelId, false);
  }, delay);
}

async function delayedLeave(delayMs = 2000) {
    if (!connection) return;
    log.info(`Sẽ ngắt kết nối voice sau ${delayMs / 1000} giây...`);
    const connToDestroy = connection;
    connection = null;

    return new Promise(resolve => {
        setTimeout(() => {
            try {
                connToDestroy.removeAllListeners();
                connToDestroy.destroy();
                log.success('Đã ngắt kết nối voice.');
            } catch (e) {
                log.error('Lỗi khi phá hủy kết nối:', e.message);
            }
            resolve();
        }, delayMs);
    });
}


async function joinVC(guildId, channelId, isManualJoin = false) {
    if (isJoining) {
        log.warn('Đang trong quá trình kết nối, bỏ qua yêu cầu tham gia mới.');
        return;
    }
    isJoining = true;

    if (isManualJoin) {
        log.info('Lệnh join thủ công được thực thi, hủy các lịch reconnect và reset bộ đếm.');
        clearReconnect();
        reconnectAttempts = 0;
    }

 
    const oldConnection = connection;
    let newConnection = null;

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('Server không tồn tại');
        const ch = guild.channels.cache.get(channelId);
        if (!ch) {
            stopReconnectPermanently('CHANNEL_NOT_FOUND', `(ID: ${channelId})`);
            throw new Error(`Kênh ${channelId} không tìm thấy.`);
        }
        if (!isVoiceLike(ch)) throw new Error('Đây không phải kênh thoại');
        if (!canViewAndConnect(ch)) {
            stopReconnectPermanently('MISSING_PERMISSIONS', ch.name);
            throw new Error(`Không có quyền để xem hoặc kết nối tới kênh ${ch.name}.`);
        }

        targetGuildId = guildId;
        targetChannelId = channelId;
        permanentBlockReason = null;
        reconnectGen++;

        log.reconnect(`Đang thử tham gia kênh: ${chalk.bold(ch.name)}...`);
        
        newConnection = joinVoiceChannel({
            channelId,
            guildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: true,
        });


        await entersState(newConnection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        
        log.success(`Kết nối thành công: ${chalk.bold(ch.name)}`, `(${channelId})`);
        log.info('Kết nối mới đã sẵn sàng. Bắt đầu giai đoạn ổn định (30s) trước khi dọn dẹp kết nối cũ.');

  
        connection = newConnection;
        
  
        reconnectAttempts = 0;
        clearReconnect();
        lastReadyAt = Date.now();
      

        if (oldConnection) {
            setTimeout(() => {
      
                if (oldConnection !== connection) {
                    log.info('Giai đoạn ổn định hoàn tất. Dọn dẹp kết nối cũ...');
                    try {
                        oldConnection.removeAllListeners();
                        oldConnection.destroy();
                        log.success('Đã dọn dẹp kết nối cũ.');
                    } catch (e) {
                        log.error('Lỗi khi dọn dẹp kết nối cũ:', e.message);
                    }
                }
            }, 30000); // 30 giây
        }

  
        newConnection.on('stateChange', async (oldS, newS) => {

            if (connection !== newConnection) return;

            if (newS.status === VoiceConnectionStatus.Disconnected) {
                try {
                    await Promise.race([
                        entersState(newConnection, VoiceConnectionStatus.Signalling, DISCONNECTED_GRACE_MS),
                        entersState(newConnection, VoiceConnectionStatus.Connecting, DISCONNECTED_GRACE_MS),
                    ]);
                } catch {
                    if (connection === newConnection && !isJoining) {
                        log.warn('Mất kết nối voice. Đang thử kết nối lại...');
                        attemptReconnect('stateChange');
                    }
                }
            } else if (newS.status === VoiceConnectionStatus.Destroyed) {
                if (targetGuildId && targetChannelId && !permanentBlockReason && connection === newConnection) {
                    attemptReconnect('destroyed');
                }
            } else if (newS.status === VoiceConnectionStatus.Ready) {
                reconnectAttempts = 0;
                clearReconnect();
                lastReadyAt = Date.now();
            }
        });

        newConnection.on('error', (e) => {
            if (connection === newConnection) {
                log.error('Lỗi kết nối voice:', e.message);
                attemptReconnect('conn-error');
            }
        });

    } catch (e) {
        log.error(`Lỗi khi tham gia voice: ${e.message}`);
     
        if (newConnection) {
            try { newConnection.destroy(); } catch {}
        }
        
     
        if (connection !== oldConnection) {
            connection = oldConnection;
        }


        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
             setTimeout(() => attemptReconnect('join-error'), 1000);
        }

    } finally {
        isJoining = false;
    }
}


async function leaveVC() {
  stopReconnectPermanently('USER_COMMAND', 'Lệnh leave được gọi');
  await delayedLeave(5000);
  log.success('Hoàn tất lệnh rời voice channel');
}


async function cleanExit(code = 0) {
  log.info('Thực hiện dọn dẹp trước khi thoát...');
  try { rl.close(); } catch {}
  clearReconnect();
  if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null; }
  
  if (connection) {
      await delayedLeave(2000);
  }

  if (client) { try { client.destroy?.(); } catch {} }
  log.info('Đã thoát.');
  process.exit(code);
}

client.on('ready', () => {
    log.success(`Đăng nhập thành công với tài khoản:`, chalk.bold(client.user.tag));
    log.success(`ID:`, chalk.bold(client.user.id));
    log.system('----------------------------------------------------');
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (client.user?.id !== newState.id) return;
  if (Date.now() - lastReadyAt < 2000) return;

  if (
    STICKY_TARGET &&
    targetGuildId && targetChannelId &&
    newState.guild.id === targetGuildId &&
    newState.channelId && newState.channelId !== targetChannelId
  ) {
    if (Date.now() - lastStickyPullAt < STICKY_COOLDOWN_MS) {
      log.sticky('Đang trong thời gian cooldown, bỏ qua lần move này');
      return;
    }
    if (stickyTimer) clearTimeout(stickyTimer);

    stickyTimer = setTimeout(() => {
      stickyTimer = null;
      if (!targetGuildId || !targetChannelId) return;

      const currentChannel = newState.guild?.members?.me?.voice?.channelId;
      if (currentChannel === targetChannelId) return;

      log.sticky(`Bị di chuyển sang kênh "${chalk.bold(newState.channel?.name || newState.channelId)}". Đang kéo về...`);
      lastStickyPullAt = Date.now();
      joinVC(targetGuildId, targetChannelId, false);
    }, STICKY_DEBOUNCE_MS);
  }
});


async function commandLoop() {
  try {
    const cmd = (await new Promise(res => rl.question(chalk.bold.white('\nNhập lệnh (join/leave/exit) > '), res))).trim().toLowerCase();
    switch (cmd) {
      case 'join': {
        log.info('Nhập thông tin kênh để tham gia:');
        const guildId = (await q('GUILD ID: ')).trim();
        const channelId = (await q('VOICE CHANNEL ID: ')).trim();
        if (guildId && channelId) {
          await joinVC(guildId, channelId, true);
        } else {
          log.warn('GUILD ID và VOICE CHANNEL ID không được để trống');
        }
        break;
      }
      case 'leave':
        await leaveVC();
        break;
      case 'exit':
        log.info('Đang thoát...');
        await cleanExit(0);
        return;
      default:
        log.warn('Lệnh không hợp lệ. Các lệnh có sẵn:', chalk.bold('join, leave, exit'));
        break;
    }
  } catch (error) {
    if (error.message.includes('closed')) {
      return;
    }
    log.error('Lỗi trong vòng lặp lệnh:', error.message);
  }
}

process.on('SIGINT', async () => {
  console.log();
  log.warn('Nhận tín hiệu SIGINT (Ctrl+C), đang thoát...');
  await cleanExit(0);
});

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

function loadTokenFromFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return config.Token || null;
    }
  } catch (error) {
    log.error('Lỗi đọc file cấu hình:', error.message);
  }
  return null;
}

function saveTokenToFile(token) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ Token: token }, null, 2));
    log.success(`Đã lưu token vào ${chalk.bold(CONFIG_PATH)}`);
  } catch (error) {
    log.error('Không thể lưu token:', error.message);
  }
}


async function main() {
  console.log(chalk.cyan('╭───────────────────────────────────────────────────╮'));
  console.log(chalk.cyan('│') + chalk.bold.magenta('         Horimeki - Stay Voice Bot v3.6            ') + chalk.cyan('│'));
  console.log(chalk.cyan('│') + chalk.white('                (Stability Patch)                  ') + chalk.cyan('│'));
  console.log(chalk.cyan('╰───────────────────────────────────────────────────╯'));

  let tokenToLogin = null;
  const savedToken = loadTokenFromFile();

  if (savedToken) {
    const answer = await new Promise(res => rl.question(chalk.yellow.bold('[?] ') + chalk.yellow('Phát hiện token đã lưu. Bạn có muốn sử dụng? (y/n): '), res));
    if (answer.toLowerCase() === 'y') {
      tokenToLogin = savedToken;
    }
  }
  
  while (!client.token) {
    try {
      if (!tokenToLogin) {
        tokenToLogin = await new Promise(res => rl.question(chalk.yellow.bold('\n[?] ') + chalk.yellow('Nhập token Discord của bạn: '), res));
        if (!tokenToLogin) {
          log.warn('Token không được để trống!');
          continue;
        }
      }
      log.reconnect('Đang đăng nhập...');
      await client.login(tokenToLogin);
    } catch (e) {
      log.error(`Lỗi đăng nhập: ${e.message}`);
      log.warn('Vui lòng kiểm tra lại token');
      tokenToLogin = null;
    }
  }

  if (!savedToken || savedToken !== client.token) {
      const saveAnswer = await new Promise(res => rl.question(chalk.yellow.bold('[?] ') + chalk.yellow('Bạn có muốn lưu token này để sử dụng lần sau? (y/n): '), res));
      if (saveAnswer.toLowerCase() === 'y') {
          saveTokenToFile(client.token);
      }
  }
  
  while (true) {
    await commandLoop();
    if (client.token === null) break;
  }
}

main();