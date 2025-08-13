const { Client } = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const MAX_RECONNECT = 10;
const DISCONNECTED_GRACE_MS = 5000;
const READY_TIMEOUT_MS = 15000;

const STICKY_TARGET = true;
const STICKY_DEBOUNCE_MS = 800;
const STICKY_COOLDOWN_MS = 5000;

const client = new Client({ checkUpdate: false });

let connection = null;
let targetGuildId = null;
let targetChannelId = null;

let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnecting = false;
let reconnectGen = 0;              // token generate, vô hiệu timer cũ
let permanentBlockReason = null; 
let lastReadyAt = 0;

let stickyTimer = null;
let lastStickyPullAt = 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const q = (prompt, { mask = false } = {}) =>
  new Promise((res) => {
    rl.question(prompt, (ans) => {
      if (mask) { process.stdout.write('\n'); }
      res(ans);
    });
  });

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err = (...a) => console.error(...a);

function clearReconnect() {
  reconnecting = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function stopReconnectPermanently(reason, note) {
  permanentBlockReason = reason;
  clearReconnect();
  targetGuildId = null;
  targetChannelId = null;
  warn(`[✕] Dừng reconnect vĩnh viễn: ${reason}${note ? ' - ' + note : ''}`);
  log('[ℹ] Dùng lệnh "join" để chọn kênh khác.');
}

function isVoiceLike(ch) {
  return (
    ch?.type === 2 || ch?.type === 13 ||
    ch?.type === 'GUILD_VOICE' || ch?.type === 'GUILD_STAGE_VOICE' ||
    ch?.isVoice?.() === true || (ch?.constructor?.name || '').includes('Voice')
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
    log(`[↻] Bỏ qua reconnect (${source}) vì lỗi vĩnh viễn: ${permanentBlockReason}`);
    return;
  }
  if (!targetGuildId || !targetChannelId) return;
  if (reconnecting) return;

  if (reconnectAttempts >= MAX_RECONNECT) {
    warn(`[!] Dừng thử kết nối sau ${MAX_RECONNECT} lần`);
    return;
  }

  reconnecting = true;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  const myGen = ++reconnectGen;

  log(`[↻] Thử kết nối lại lần ${reconnectAttempts}/${MAX_RECONNECT} sau ${Math.round(delay/1000)}s... (src=${source}, gen=${myGen})`);
  clearReconnect();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    if (myGen !== reconnectGen) return; // đã có gen mới (đã join thành công)
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(guild)');
    const ch = guild.channels.cache.get(targetChannelId);
    if (!ch) return stopReconnectPermanently('CHANNEL_NOT_FOUND', `(channel ${targetChannelId})`);
    if (!isVoiceLike(ch)) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(not voice)');
    if (!canViewAndConnect(ch)) return stopReconnectPermanently('MISSING_PERMISSIONS', ch.name);

    joinVC(targetGuildId, targetChannelId);
  }, delay);
}

async function joinVC(guildId, channelId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Server không tồn tại');
    const ch = guild.channels.cache.get(channelId);
    if (!ch) { stopReconnectPermanently('CHANNEL_NOT_FOUND', `(ID: ${channelId})`); return; }
    if (!isVoiceLike(ch)) throw new Error(`Đây không phải kênh thoại (type: ${ch.type}, ctor: ${ch.constructor?.name})`);
    if (!canViewAndConnect(ch)) { stopReconnectPermanently('MISSING_PERMISSIONS', ch.name); return; }

    targetGuildId = guildId;
    targetChannelId = channelId;

    clearReconnect();
    reconnectGen++;

    // Destroy kết nối cũ nếu có
    if (connection) { try { connection.removeAllListeners(); connection.destroy(); } catch {} connection = null; }

    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    log(`[+] Đã tham gia: ${ch.name} (${channelId})`);
    permanentBlockReason = null;
    reconnectAttempts = 0;
    clearReconnect();
    lastReadyAt = Date.now();

    connection.on('stateChange', async (oldS, newS) => {
      /**
       * @description debug
       * log(`[voice] ${oldS.status} -> ${newS.status}`);
       */

      if (newS.status === VoiceConnectionStatus.Disconnected) {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, DISCONNECTED_GRACE_MS),
            entersState(connection, VoiceConnectionStatus.Connecting, DISCONNECTED_GRACE_MS),
          ]);
          return;
        } catch {
          warn('[!] Mất kết nối voice. Đang thử kết nối lại...');
          attemptReconnect('stateChange');
        }
      } else if (newS.status === VoiceConnectionStatus.Destroyed) {
        if (targetGuildId && targetChannelId && !permanentBlockReason) {
          attemptReconnect('destroyed');
        }
      } else if (newS.status === VoiceConnectionStatus.Ready) {
        reconnectAttempts = 0;
        clearReconnect();
        lastReadyAt = Date.now();
      }
    });

    connection.on('error', (e) => {
      err('[!] Voice connection error:', e.message);
      attemptReconnect('conn-error');
    });

  } catch (e) {
    err(`[!] Lỗi tham gia voice: ${e.message}`);
    if (
      /Server không tồn tại|Kênh không tồn tại|không phải là kênh thoại/i.test(e.message)
    ) {
      stopReconnectPermanently('CHANNEL_NOT_FOUND', '(join error)');
      return;
    }
    attemptReconnect('join-error');
  }
}

function leaveVC() {
  clearReconnect();
  if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null; }
  if (connection) { try { connection.removeAllListeners(); connection.destroy(); } catch {} connection = null; }
  targetGuildId = null;
  targetChannelId = null;
  log('[✓] Đã rời voice channel');
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const me = client.user?.id;
  if (!me) return;
  if (oldState.id !== me && newState.id !== me) return;

  if (Date.now() - lastReadyAt < 2000) return; // tránh nhiễu ngay sau Ready

  // rời hẳn voice
  if (newState.channelId === null && oldState.channelId !== null) {
    warn('[!] Bị đẩy khỏi voice channel (voiceStateUpdate)');
    return;
  }

  // move sang kênh khác (không có Disconnected)
  if (
    STICKY_TARGET &&
    targetGuildId && targetChannelId &&
    newState.guild.id === targetGuildId &&
    newState.channelId && newState.channelId !== targetChannelId
  ) {
    if (Date.now() - lastStickyPullAt < STICKY_COOLDOWN_MS) {
      log('[sticky] cooldown, bỏ qua lần move này');
      return;
    }
    if (stickyTimer) clearTimeout(stickyTimer);
    stickyTimer = setTimeout(() => {
      stickyTimer = null;
      if (!targetGuildId || !targetChannelId) return;
      // nếu đã về lại target trong lúc chờ thì thôi
      const nowCh = newState.guild?.members?.me?.voice?.channelId || newState.channelId;
      if (nowCh === targetChannelId) return;

      warn(`[sticky] phát hiện bị move sang ${newState.channel?.name || newState.channelId} → kéo về channel cũ`);
      lastStickyPullAt = Date.now();
      joinVC(targetGuildId, targetChannelId);
    }, STICKY_DEBOUNCE_MS);
  }
});


async function commandLoop() {
  const cmd = (await q('\nNhập lệnh (join/leave/exit): ')).trim().toLowerCase();
  switch (cmd) {
    case 'join': {
      const g = (await q('Nhập GUILD ID: ')).trim();
      const c = (await q('Nhập VOICE CHANNEL ID: ')).trim();
      if (g && c) {
        await joinVC(g, c);
      } else {
        warn('[!] GUILD ID và VOICE CHANNEL ID không được để trống.');
      }
      break;
    }
    case 'leave':
      leaveVC();
      break;
    case 'exit':
      log('[×] Đang thoát...');
      cleanExit(0);
      break; // cleanExit sẽ thoát tiến trình, nên có break
    default:
      warn('[!] Lệnh không hợp lệ. Chọn: join/leave/exit');
      break;
  }
}

function cleanExit(code = 0) {
  try { rl.close(); } catch {}
  clearReconnect();
  if (stickyTimer) { try { clearTimeout(stickyTimer); } catch {} stickyTimer = null; }
  try { connection?.removeAllListeners(); connection?.destroy(); } catch {}
  try { client.destroy?.(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => { console.log(); warn('[×] Nhận SIGINT, thoát…'); cleanExit(0); });

function loadTokenFromFile() {
  const configPath = path.join(process.cwd(), 'config.json');
  
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath));
      if (config.Token) return config.Token;
    }
  } catch (error) {
    console.error('[!] Lỗi đọc file cấu hình:', error.message);
  }
  return null;
}

function saveTokenToFile(token) {
  const configPath = path.join(process.cwd(), 'config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify({ Token: token }, null, 2));
    console.log(`[✓] Đã lưu token vào ${configPath}`);
  } catch (error) {
    console.error('[!] Không thể lưu token:', error.message);
  }
}

client.on('ready', () => {
  console.log(`[✓] Đăng nhập thành công với tài khoản: ${client.user.tag}`);
  console.log(`[✓] ID: ${client.user.id}`);
  console.log('-----------------------------------------');
});

// Maincord
async function main() {
  console.log('Horimeki - Version 3.6');
  console.log('-----------------------------------------');

  let tokenToLogin = null;
  const savedToken = loadTokenFromFile();

  if (savedToken) {
    const answer = await q('Phát hiện token đã lưu. Bạn có muốn sử dụng? (y/n): ');
    if (answer.toLowerCase() === 'y') {
      tokenToLogin = savedToken;
    }
  }

  
  while (!client.token) {
    try {
      if (!tokenToLogin) {
        tokenToLogin = await q('\nNhập token Discord của bạn: ');
        if (!tokenToLogin) {
          warn('Token không được để trống!');
          continue;
        }
      }
      log('[↻] Đang đăng nhập...');
      await client.login(tokenToLogin);
    } catch (e) {
      err(`[!] Lỗi đăng nhập: ${e.message}`);
      warn('[!] Vui lòng thử lại với token khác.');
      tokenToLogin = null;
    }
  }


  if (!savedToken || savedToken !== client.token) {
      const saveAnswer = await q('Bạn có muốn lưu token này để sử dụng lần sau? (y/n): ');
      if (saveAnswer.toLowerCase() === 'y') {
          saveTokenToFile(client.token);
      }
  }
  
  while (true) {
    await commandLoop();
  }
}

main();