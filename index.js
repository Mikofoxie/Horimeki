const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require("@discordjs/voice");
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const client = new Client({ checkUpdate: false });

let connection = null;
let targetGuildId = null;
let targetChannelId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


async function joinVC(guildId, channelId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Server không tồn tại');

    const voiceChannel = guild.channels.cache.get(channelId);
    if (!voiceChannel) throw new Error('Kênh không tồn tại');
    if (voiceChannel.type !== 'GUILD_VOICE') throw new Error('Đây không phải là kênh thoại');

    // Lưu lại target để reconnect
    targetGuildId = guildId;
    targetChannelId = channelId;
    
    // Nếu đang có kết nối thì hủy trước
    if (connection) {
      connection.destroy();
      connection = null;
    }
    
    // Tạo kết nối mới
    connection = joinVoiceChannel({
      channelId: channelId,
      guildId: guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true
    });
    
    console.log(`[+] Đã tham gia: ${voiceChannel.name} (${channelId})`);
    reconnectAttempts = 0;

    // Xử lý sự kiện ngắt kết nối
    connection.on('stateChange', (oldState, newState) => {
      if (newState.status === 'disconnected') {
        console.log('[!] Mất kết nối voice. Đang thử kết nối lại...');
        attemptReconnect();
      }
    });

  } catch (error) {
    console.error(`[!] Lỗi tham gia voice: ${error.message}`);
    attemptReconnect();
  }
}


function leaveVC() {
  if (connection) {
    connection.destroy();
    connection = null;
    targetGuildId = null;
    targetChannelId = null;
    console.log('[✓] Đã rời voice channel');
  } else {
    console.log('[!] Không có kết nối voice nào');
  }
}


function attemptReconnect() {
  if (!targetGuildId || !targetChannelId) return;

  if (reconnectAttempts >= MAX_RECONNECT) {
    console.log(`[!] Đã ngừng thử kết nối sau ${MAX_RECONNECT} lần`);
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`[↻] Thử kết nối lại lần ${reconnectAttempts} sau ${delay/1000}s...`);
  
  setTimeout(() => {
    joinVC(targetGuildId, targetChannelId);
  }, delay);
}

// Xử lý sự kiện voice state update
client.on('voiceStateUpdate', (oldState, newState) => {
  // Chỉ xử lý khi state của bot thay đổi
  if (oldState.member.id !== client.user.id) return;

  // Nếu rời khỏi kênh (channelID chuyển thành null)
  if (newState.channelId === null && oldState.channelId !== null) {
    console.log('[!] Bị đẩy khỏi voice channel');
    attemptReconnect();
  }
});


function promptUser() {
  rl.question('\nNhập lệnh (join/leave/exit): ', async (command) => {
    switch(command.toLowerCase()) {
      case 'join':
        rl.question('Nhập GUILD ID: ', guildId => {
          rl.question('Nhập VOICE CHANNEL ID: ', channelId => {
            joinVC(guildId.trim(), channelId.trim());
            promptUser();
          });
        });
        break;
        
      case 'leave':
        leaveVC();
        promptUser();
        break;
        
      case 'exit':
        console.log('[×] Đang thoát...');
        process.exit();
        break;
        
      default:
        console.log('[!] Lệnh không hợp lệ. Chọn: join/leave/exit');
        promptUser();
    }
  });
}

// Đăng nhập bằng token nhập từ terminal
function loginWithToken() {
  rl.question('Nhập token Discord của bạn: ', (token) => {
    if (!token) {
      console.log('Token không được để trống!');
      return loginWithToken();
    }
    
    client.login(token).catch(e => {
      console.error('[!] Lỗi đăng nhập:', e.message);
      loginWithToken(); // Yêu cầu nhập lại
    });
  });
}

// Lưu token vào file 
function saveTokenToFile(token) {
  const configPath = path.join(process.cwd(), 'config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify({ Token: token }, null, 2));
    console.log(`[✓] Đã lưu token vào ${configPath}`);
  } catch (error) {
    console.error('[!] Không thể lưu token:', error.message);
  }
}

// Đọc token từ file 
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

// Maincord
console.log('Horimeki - Version 3.6');
console.log('-----------------------------------------');

// Kiểm tra xem có token trong file config không
const savedToken = loadTokenFromFile();

if (savedToken) {
  rl.question('Phát hiện token đã lưu. Bạn có muốn sử dụng? (y/n): ', (answer) => {
    if (answer.toLowerCase() === 'y') {
      console.log('[↻] Đang đăng nhập bằng token đã lưu...');
      client.login(savedToken).catch(e => {
        console.error('[!] Lỗi đăng nhập:', e.message);
        loginWithToken();
      });
    } else {
      loginWithToken();
    }
  });
} else {
  loginWithToken();
}

// Xử lý sự kiện đăng nhập thành công
client.on('ready', () => {
  console.log(`[✓] Đăng nhập thành công với tài khoản: ${client.user.tag}`);
  console.log(`[✓] ID: ${client.user.id}`);
  console.log('-----------------------------------------');
  
  // Hỏi người dùng có muốn lưu token không
  rl.question('Bạn có muốn lưu token để sử dụng lần sau? (y/n): ', (answer) => {
    if (answer.toLowerCase() === 'y') {
      saveTokenToFile(client.token);
    }
    promptUser();
  });
});