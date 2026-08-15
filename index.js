const { Client, Events, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const http = require('http');

const DAY_REACTIONS = {
  '4️⃣': 4,
  '5️⃣': 5,
  '6️⃣': 6,
  '0️⃣': 0,
};

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'BotVote';
const DSB_SHEET_NAME = 'DSB';
const RESULT_SHEET_NAME = 'Kết Quả Vote';
const BC_SHEET_NAME = 'Vote Off BC';

// Scrim schedule data
let scrimData = {
  session1Time: 'Đang tìm đối thủ',
  session1Opponent: 'Đang tìm đối thủ',
  session2Time: 'Đang tìm đối thủ',
  session2Opponent: 'Đang tìm đối thủ',
  messageId: null,
  channelId: null,
  updatedAt: null,
};

// Bang chiến offline check-in message data
let bcData = {
  messageId: null,
  channelId: null,
};

const NPC_ROLE_ID = '1472421811055493142';
const SCRIM_PING_ROLE_ID = process.env.SCRIM_PING_ROLE_ID || '1528993894052659331';
const OFFLINE_EMOJI_NAME = 'offline';
const OFFLINE_EMOJI_ID = '1498552256226656297';
const OFFLINE_EMOJI_MENTION = `<:${OFFLINE_EMOJI_NAME}:${OFFLINE_EMOJI_ID}>`;
const OFFLINE_EMOJI_REACT = `${OFFLINE_EMOJI_NAME}:${OFFLINE_EMOJI_ID}`;
const UPDATE_INFO_CHANNEL_ID = '1520705676521771089';
const SCRIM_SIGNUP_CHANNEL_ID = '1508378901498302586';

// Reminder settings — channel is env-overridable since it may change later
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID || '1536936493321551923';

// Bang chiến: every Saturday 20:00 (UTC+7), reminder 30 minutes before -> 19:30
const BC_EVENT_DAY = 6; // Saturday (0 = Sunday ... 6 = Saturday)
const BC_EVENT_HOUR = 20;
const BC_EVENT_MINUTE = 0;
const BC_REMINDER_MINUTES_BEFORE = 30;

// Giải cứu mỹ nhân: every other Tuesday 20:00 (UTC+7), reminder 15 minutes before -> 19:45
// Reference date: 18/08/2026 is a confirmed opening Tuesday
const GCMN_EVENT_DAY = 2; // Tuesday
const GCMN_EVENT_HOUR = 20;
const GCMN_EVENT_MINUTE = 0;
const GCMN_REMINDER_MINUTES_BEFORE = 15;
const GCMN_REFERENCE_DATE_UTC = Date.UTC(2026, 7, 18); // month is 0-indexed: 7 = August

// Tracks the date (yyyy-mm-dd, VN time) each reminder was last sent, to avoid duplicate sends
let lastBcReminderDate = null;
let lastGcmnReminderDate = null;

function getFormattedDateTime() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  const utcPlus7 = new Date(utcTime + (7 * 60 * 60 * 1000));

  const hours = String(utcPlus7.getHours()).padStart(2, '0');
  const minutes = String(utcPlus7.getMinutes()).padStart(2, '0');
  const seconds = String(utcPlus7.getSeconds()).padStart(2, '0');
  const day = String(utcPlus7.getDate()).padStart(2, '0');
  const month = String(utcPlus7.getMonth() + 1).padStart(2, '0');
  const year = utcPlus7.getFullYear();
  return `${hours}:${minutes}:${seconds}, ngày ${day}/${month}/${year}`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

async function getGoogleAuthClient() {
  try {
    let auth;

    // Railway: Try base64 encoded credentials first
    if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
      console.log('Using base64 encoded credentials (Railway mode)');
      try {
        const buffer = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64');
        const decodedString = buffer.toString('utf-8');
        console.log('Decoded length:', decodedString.length);
        const credentials = JSON.parse(decodedString);
        
        auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        return await auth.getClient();
      } catch (decodeError) {
        console.error('Failed to decode base64 credentials:', decodeError.message);
        console.log('Trying JSON string fallback...');
        // Fallback: try parsing as direct JSON
        try {
          const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64);
          auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          });
          return await auth.getClient();
        } catch (jsonError) {
          console.error('Failed to parse as JSON:', jsonError.message);
          throw decodeError;
        }
      }
    }

    // Local: Try file path credentials
    const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_FILE;

    if (!credentialPath) {
      console.warn('Google Sheets credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_BASE64 (Railway) or GOOGLE_APPLICATION_CREDENTIALS (Local).');
      return null;
    }

    console.log('Using file path credentials (Local mode)');
    auth = new google.auth.GoogleAuth({
      keyFile: credentialPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return await auth.getClient();
  } catch (error) {
    console.error('Failed to initialize Google Sheets auth:', error.message);
    return null;
  }
}

async function ensureSheetHeaders(authClient) {
  if (!SPREADSHEET_ID) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:H1`,
    });

    if (response.data.values && response.data.values.length > 0) {
      return;
    }
  } catch (error) {
    // Ignore "range not found" errors and create the header row.
  }

  const headers = [['timestamp', 'guildId', 'channelId', 'messageId', 'userId', 'username', 'day', 'reaction']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:H1`,
    valueInputOption: 'RAW',
    resource: {
      values: headers,
    },
  });
}

async function resetVoteSheet() {
  if (!SPREADSHEET_ID) {
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:Z`,
    });

    const headers = [['timestamp', 'guildId', 'channelId', 'messageId', 'userId', 'username', 'day', 'reaction']];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:H1`,
      valueInputOption: 'RAW',
      resource: {
        values: headers,
      },
    });

    await refreshResultSheet();
    console.log(`Reset vote sheet ${SHEET_NAME} in spreadsheet ${SPREADSHEET_ID}.`);
  } catch (error) {
    console.error('Failed to reset vote sheet:', error.message);
  }
}

async function saveVoteToSheet({ guildId, channelId, messageId, userId, username, day, reaction }) {
  if (!SPREADSHEET_ID) {
    console.warn('GOOGLE_SHEET_ID is not set. Vote not saved to Google Sheets.');
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    await ensureSheetHeaders(authClient);

    const row = [
      new Date().toISOString(),
      guildId,
      channelId,
      messageId,
      userId,
      username,
      day,
      reaction,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:H`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [row],
      },
    });

    console.log(`Saved vote for user ${userId} -> day ${day} in Google Sheets.`);
    await refreshResultSheet();
  } catch (error) {
    console.error('Failed to save vote to Google Sheets:', error.message);
  }
}

async function ensureResultSheet(authClient) {
  if (!SPREADSHEET_ID) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const response = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = response.data.sheets || [];
  const exists = existingSheets.some((sheet) => sheet.properties.title === RESULT_SHEET_NAME);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [
          {
            addSheet: {
              properties: {
                title: RESULT_SHEET_NAME,
              },
            },
          },
        ],
      },
    });
  }
}

async function refreshResultSheet() {
  if (!SPREADSHEET_ID) {
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    await ensureResultSheet(authClient);

    const dsbResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${DSB_SHEET_NAME}!A:D`,
    });

    const dsbRows = dsbResponse.data.values || [];

    if (!dsbRows.length) {
      console.warn(`No rows found in ${DSB_SHEET_NAME}. Cannot build result sheet.`);
      return;
    }

    const voteResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:H`,
    });

    const voteRows = voteResponse.data.values || [];
    const votesByUser = {};

    if (voteRows.length > 1) {
      for (let i = 1; i < voteRows.length; i += 1) {
        const row = voteRows[i];
        const userId = row[4] !== undefined && row[4] !== null ? String(row[4]).trim() : '';
        const day = row[6] !== undefined && row[6] !== null ? String(row[6]).trim() : '';

        if (!userId || !day) continue;

        if (!votesByUser[userId]) {
          votesByUser[userId] = new Set();
        }

        votesByUser[userId].add(day);
      }
    }

    const header = ['ID', 'Ingame', 'Class', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Không Đánh'];
    const resultRows = [header];

    const headerRow = dsbRows[0].map((cell) => String(cell).trim().toLowerCase());
    const idIndex = headerRow.indexOf('id');
    const ingameIndex = headerRow.indexOf('ingame');
    const classIndex = headerRow.indexOf('class');

    for (let i = 1; i < dsbRows.length; i += 1) {
      const row = dsbRows[i];
      const id = (idIndex >= 0 && row[idIndex]) ? String(row[idIndex]).trim() : (row[0] ? String(row[0]).trim() : '');
      const ingame = (ingameIndex >= 0 && row[ingameIndex]) ? String(row[ingameIndex]).trim() : (row[1] ? String(row[1]).trim() : '');
      const className = (classIndex >= 0 && row[classIndex])
        ? String(row[classIndex]).trim()
        : ((row[3] !== undefined && row[3] !== null) ? String(row[3]).trim() : (row[2] ? String(row[2]).trim() : ''));

      if (!id) continue;

      const trimmedId = String(id).trim();
      const hasDay4 = Object.keys(votesByUser).some((votedId) => String(votedId).trim() === trimmedId && votesByUser[votedId].has('4'));
      const hasDay5 = Object.keys(votesByUser).some((votedId) => String(votedId).trim() === trimmedId && votesByUser[votedId].has('5'));
      const hasDay6 = Object.keys(votesByUser).some((votedId) => String(votedId).trim() === trimmedId && votesByUser[votedId].has('6'));
      const hasDay0 = Object.keys(votesByUser).some((votedId) => String(votedId).trim() === trimmedId && votesByUser[votedId].has('0'));

      const dayValues = [
        hasDay4 ? 'X' : '',
        hasDay5 ? 'X' : '',
        hasDay6 ? 'X' : '',
        hasDay0 ? 'X' : '',
      ];

      resultRows.push([id, ingame, className, dayValues[0], dayValues[1], dayValues[2], dayValues[3]]);
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RESULT_SHEET_NAME}!A1:Z`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RESULT_SHEET_NAME}!A1:G${resultRows.length}`,
      valueInputOption: 'RAW',
      resource: {
        values: resultRows,
      },
    });

    console.log(`Updated result sheet ${RESULT_SHEET_NAME}.`);
  } catch (error) {
    console.error('Failed to refresh result sheet:', error.message);
  }
}

function formatScrimMessage() {
  const updateInfo = scrimData.updatedAt ? `Đã Cập Nhật Lúc: ${scrimData.updatedAt}` : '';
  const rolePing = SCRIM_PING_ROLE_ID ? `<@&${SCRIM_PING_ROLE_ID}>\n\n` : '';
  return `${rolePing}# Thông báo Scrim Tuần Này

## Buổi 1:
Thời Gian: ${scrimData.session1Time}
Đối Thủ: ${scrimData.session1Opponent}
Số Trận: 2 Trận

## Buổi 2:
Thời Gian: ${scrimData.session2Time}
Đối Thủ: ${scrimData.session2Opponent}
Số Trận: 2 Trận

---
${updateInfo}
Chọn ngày phù hợp bằng các emoji bên dưới:
4️⃣ = Thứ 4
5️⃣ = Thứ 5
6️⃣ = Thứ 6
0️⃣ = Không đánh`;
}

function formatBcMessage(offlineList) {
  const rolePing = SCRIM_PING_ROLE_ID ? `<@&${SCRIM_PING_ROLE_ID}>\n\n` : '';
  const listSection = (offlineList && offlineList.length)
    ? `\n\nDanh sách đánh dấu Offline:\n${offlineList.map((item) => `${item.ingame} - ${item.class}`).join('\n')}`
    : '';

  return `${rolePing}# Điểm Danh Bang Chiến Tuần Này.
React ${OFFLINE_EMOJI_MENTION} nếu không đánh bang chiến.${listSection}`;
}

async function ensureBcSheetExists(authClient) {
  if (!SPREADSHEET_ID) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const response = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = response.data.sheets || [];
  const exists = existingSheets.some((sheet) => sheet.properties.title === BC_SHEET_NAME);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [
          {
            addSheet: {
              properties: {
                title: BC_SHEET_NAME,
              },
            },
          },
        ],
      },
    });
  }
}

async function ensureBcSheetHeaders(authClient) {
  if (!SPREADSHEET_ID) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A1:A1`,
    });

    if (response.data.values && response.data.values.length > 0) {
      return;
    }
  } catch (error) {
    // Ignore "range not found" errors and create the header row.
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BC_SHEET_NAME}!A1:A1`,
    valueInputOption: 'RAW',
    resource: {
      values: [['userId']],
    },
  });
}

async function resetOffVoteSheet() {
  if (!SPREADSHEET_ID) {
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    await ensureBcSheetExists(authClient);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A2:Z`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A1:A1`,
      valueInputOption: 'RAW',
      resource: {
        values: [['userId']],
      },
    });

    console.log(`Reset off-vote sheet ${BC_SHEET_NAME}.`);
  } catch (error) {
    console.error('Failed to reset off-vote sheet:', error.message);
  }
}

async function addOffVote(userId) {
  if (!SPREADSHEET_ID) {
    console.warn('GOOGLE_SHEET_ID is not set. Off-vote not saved to Google Sheets.');
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    await ensureBcSheetExists(authClient);
    await ensureBcSheetHeaders(authClient);

    const existingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A:A`,
    });

    const existingRows = existingResponse.data.values || [];
    const alreadyVoted = existingRows.slice(1).some(
      (row) => row[0] !== undefined && String(row[0]).trim() === String(userId).trim()
    );

    if (alreadyVoted) {
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [[userId]],
      },
    });

    console.log(`Saved off-vote for user ${userId} in Google Sheets.`);
    await refreshBcMessage();
  } catch (error) {
    console.error('Failed to save off-vote to Google Sheets:', error.message);
  }
}

async function removeOffVote(userId) {
  if (!SPREADSHEET_ID) {
    console.warn('GOOGLE_SHEET_ID is not set. Off-vote not removed from Google Sheets.');
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const spreadsheetResponse = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetsData = spreadsheetResponse.data.sheets || [];
    const bcSheetData = sheetsData.find((sheet) => sheet.properties.title === BC_SHEET_NAME);

    if (!bcSheetData) {
      console.warn(`Sheet ${BC_SHEET_NAME} not found in spreadsheet.`);
      return;
    }

    const sheetId = bcSheetData.properties.sheetId;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A:A`,
    });

    const rows = response.data.values || [];
    const rowsToDelete = [];

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const rowUserId = row[0] !== undefined && row[0] !== null ? String(row[0]).trim() : '';

      if (rowUserId === String(userId).trim()) {
        rowsToDelete.push(i + 1);
      }
    }

    if (rowsToDelete.length === 0) {
      console.log(`No off-vote found for user ${userId}.`);
      return;
    }

    const requests = rowsToDelete.reverse().map((rowIndex) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIndex - 1,
          endIndex: rowIndex,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests,
      },
    });

    console.log(`Removed off-vote for user ${userId} from Google Sheets.`);
    await refreshBcMessage();
  } catch (error) {
    console.error('Failed to remove off-vote from Google Sheets:', error.message);
  }
}

async function refreshBcMessage() {
  if (!SPREADSHEET_ID || !bcData.messageId || !bcData.channelId) {
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    const voteResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${BC_SHEET_NAME}!A:A`,
    });

    const voteRows = voteResponse.data.values || [];
    const userIds = voteRows.slice(1)
      .map((row) => (row[0] !== undefined && row[0] !== null ? String(row[0]).trim() : ''))
      .filter(Boolean);

    let offlineList = [];

    if (userIds.length > 0) {
      const dsbResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${DSB_SHEET_NAME}!A:D`,
      });

      const dsbRows = dsbResponse.data.values || [];

      if (dsbRows.length > 0) {
        const headerRow = dsbRows[0].map((cell) => String(cell).trim().toLowerCase());
        const idIndex = headerRow.indexOf('id');
        const ingameIndex = headerRow.indexOf('ingame');
        const classIndex = headerRow.indexOf('class');

        const dsbMap = {};

        for (let i = 1; i < dsbRows.length; i += 1) {
          const row = dsbRows[i];
          const id = (idIndex >= 0 && row[idIndex]) ? String(row[idIndex]).trim() : (row[0] ? String(row[0]).trim() : '');

          if (!id) continue;

          const ingame = (ingameIndex >= 0 && row[ingameIndex]) ? String(row[ingameIndex]).trim() : (row[1] ? String(row[1]).trim() : '');
          const className = (classIndex >= 0 && row[classIndex])
            ? String(row[classIndex]).trim()
            : ((row[3] !== undefined && row[3] !== null) ? String(row[3]).trim() : (row[2] ? String(row[2]).trim() : ''));

          dsbMap[id] = { ingame, class: className };
        }

        offlineList = userIds.map((id) => dsbMap[id] || { ingame: id, class: '' });
      } else {
        offlineList = userIds.map((id) => ({ ingame: id, class: '' }));
      }
    }

    const channel = await client.channels.fetch(bcData.channelId);
    const bcMessage = await channel.messages.fetch(bcData.messageId);

    await bcMessage.edit({
      content: formatBcMessage(offlineList),
      allowedMentions: { roles: [] },
    });

    console.log('Updated bang chien message with offline list.');
  } catch (error) {
    console.error('Failed to refresh bang chien message:', error.message);
  }
}

function getVnNow() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcTime + (7 * 60 * 60 * 1000));
}

function getDateKey(vnDate) {
  const y = vnDate.getFullYear();
  const m = String(vnDate.getMonth() + 1).padStart(2, '0');
  const d = String(vnDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isGcmnOpeningWeek(vnDate) {
  const dateOnlyUtc = Date.UTC(vnDate.getFullYear(), vnDate.getMonth(), vnDate.getDate());
  const diffDays = Math.round((dateOnlyUtc - GCMN_REFERENCE_DATE_UTC) / (24 * 60 * 60 * 1000));
  const diffWeeks = diffDays / 7;
  const mod = ((diffWeeks % 2) + 2) % 2;
  return mod === 0;
}

async function sendReminderMessage(text) {
  if (!REMINDER_CHANNEL_ID) {
    return;
  }

  try {
    const channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
    await channel.send({
      content: text,
      allowedMentions: { roles: SCRIM_PING_ROLE_ID ? [SCRIM_PING_ROLE_ID] : [] },
    });
  } catch (error) {
    console.error('Failed to send reminder message:', error.message);
  }
}

function formatBcReminderMessage() {
  return `<@&${SCRIM_PING_ROLE_ID}>\n# Đến giờ tập hợp bang chiến, mọi người online game để các lead pt dần nhé!:`;
}

function formatGcmnReminderMessage() {
  return `<@&${SCRIM_PING_ROLE_ID}>\n# Hoạt động **Giải Cứu Mỹ Nhân** diễn ra sau 15phút nữa!!`;
}

function checkReminders() {
  const vnNow = getVnNow();
  const dayOfWeek = vnNow.getDay();
  const hours = vnNow.getHours();
  const minutes = vnNow.getMinutes();
  const todayKey = getDateKey(vnNow);

  // Bang chiến reminder — every Saturday, 30 minutes before 20:00
  let bcReminderMinuteMark = BC_EVENT_MINUTE - BC_REMINDER_MINUTES_BEFORE;
  let bcReminderHour = BC_EVENT_HOUR;
  if (bcReminderMinuteMark < 0) {
    bcReminderMinuteMark += 60;
    bcReminderHour -= 1;
  }

  if (
    dayOfWeek === BC_EVENT_DAY &&
    hours === bcReminderHour &&
    minutes === bcReminderMinuteMark &&
    lastBcReminderDate !== todayKey
  ) {
    lastBcReminderDate = todayKey;
    sendReminderMessage(formatBcReminderMessage());
  }

  // Giải cứu mỹ nhân reminder — every other Tuesday, 15 minutes before 20:00
  let gcmnReminderMinuteMark = GCMN_EVENT_MINUTE - GCMN_REMINDER_MINUTES_BEFORE;
  let gcmnReminderHour = GCMN_EVENT_HOUR;
  if (gcmnReminderMinuteMark < 0) {
    gcmnReminderMinuteMark += 60;
    gcmnReminderHour -= 1;
  }

  if (
    dayOfWeek === GCMN_EVENT_DAY &&
    hours === gcmnReminderHour &&
    minutes === gcmnReminderMinuteMark &&
    lastGcmnReminderDate !== todayKey &&
    isGcmnOpeningWeek(vnNow)
  ) {
    lastGcmnReminderDate = todayKey;
    sendReminderMessage(formatGcmnReminderMessage());
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const authClient = await getGoogleAuthClient();
  if (authClient && SPREADSHEET_ID) {
    await ensureResultSheet(authClient);
    console.log(`Ensured ${RESULT_SHEET_NAME} sheet exists.`);
  }

  setInterval(checkReminders, 60 * 1000);
  console.log('Started reminder scheduler (checks every minute).');
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content.toLowerCase() === 'nm!vote') {
    await resetVoteSheet();

    const voteMessage = await message.channel.send({
      content: formatScrimMessage(),
      allowedMentions: { roles: SCRIM_PING_ROLE_ID ? [SCRIM_PING_ROLE_ID] : [] }, // ping on creation
    });
    
    // Lưu messageId để có thể edit sau
    scrimData.messageId = voteMessage.id;
    scrimData.channelId = message.channelId;

    for (const emoji of Object.keys(DAY_REACTIONS)) {
      await voteMessage.react(emoji);
    }

    return;
  }

  if (content.toLowerCase().startsWith('nm!us1')) {
    // Kiểm tra role NPC
    if (!message.member.roles.cache.has(NPC_ROLE_ID)) {
      message.reply('❌ Bạn không có quyền sử dụng lệnh này. Cần role NPC.');
      return;
    }

    const rawArgs = content.substring('nm!us1'.length).trim();

    if (!rawArgs) {
      message.reply('Format: `nm!us1 [thời gian] ; [đối thủ]`\nVí dụ:\n`nm!us1 19:00 ; Server X`\n`nm!us1 19:00`\n`nm!us1 ; Server X`');
      return;
    }

    const args = rawArgs.split(';').map(arg => arg.trim());

    if (args[0]) {
      scrimData.session1Time = args[0];
    }

    if (args.length >= 2 && args[1]) {
      scrimData.session1Opponent = args[1];
    }

    scrimData.updatedAt = getFormattedDateTime();

    try {
      if (scrimData.messageId && scrimData.channelId) {
        const channel = await client.channels.fetch(scrimData.channelId);
        const scrimMessage = await channel.messages.fetch(scrimData.messageId);
        await scrimMessage.edit({
          content: formatScrimMessage(),
          allowedMentions: { roles: [] }, // don't re-ping on edit
        });
      } else {
        const scrimMessage = await message.channel.send({
          content: formatScrimMessage(),
          allowedMentions: { roles: [] }, // no ping (only nm!vote pings)
        });
        scrimData.messageId = scrimMessage.id;
        scrimData.channelId = message.channelId;

        for (const emoji of Object.keys(DAY_REACTIONS)) {
          await scrimMessage.react(emoji);
        }
      }

      await message.delete().catch(err => console.error('Failed to delete command message:', err.message));
    } catch (error) {
      console.error('Failed to update scrim message:', error.message);
      message.reply('❌ Lỗi khi cập nhật tin nhắn scrim.');
    }
    return;
  }

  if (content.toLowerCase().startsWith('nm!us2')) {
    // Kiểm tra role NPC
    if (!message.member.roles.cache.has(NPC_ROLE_ID)) {
      message.reply('❌ Bạn không có quyền sử dụng lệnh này. Cần role NPC.');
      return;
    }

    const rawArgs = content.substring('nm!us2'.length).trim();

    if (!rawArgs) {
      message.reply('Format: `nm!us2 [thời gian] ; [đối thủ]`\nVí dụ:\n`nm!us2 21:00 ; Server Y`\n`nm!us2 21:00`\n`nm!us2 ; Server Y`');
      return;
    }

    const args = rawArgs.split(';').map(arg => arg.trim());

    if (args[0]) {
      scrimData.session2Time = args[0];
    }

    if (args.length >= 2 && args[1]) {
      scrimData.session2Opponent = args[1];
    }

    scrimData.updatedAt = getFormattedDateTime();

    try {
      if (scrimData.messageId && scrimData.channelId) {
        const channel = await client.channels.fetch(scrimData.channelId);
        const scrimMessage = await channel.messages.fetch(scrimData.messageId);
        await scrimMessage.edit({
          content: formatScrimMessage(),
          allowedMentions: { roles: [] }, // don't re-ping on edit
        });
      } else {
        const scrimMessage = await message.channel.send({
          content: formatScrimMessage(),
          allowedMentions: { roles: [] }, // no ping (only nm!vote pings)
        });
        scrimData.messageId = scrimMessage.id;
        scrimData.channelId = message.channelId;

        for (const emoji of Object.keys(DAY_REACTIONS)) {
          await scrimMessage.react(emoji);
        }
      }

      await message.delete().catch(err => console.error('Failed to delete command message:', err.message));
    } catch (error) {
      console.error('Failed to update scrim message:', error.message);
      message.reply('❌ Lỗi khi cập nhật tin nhắn scrim.');
    }
    return;
  }

  if (content.toLowerCase() === 'nm!reset') {
    // Kiểm tra role NPC
    if (!message.member.roles.cache.has(NPC_ROLE_ID)) {
      message.reply('❌ Bạn không có quyền sử dụng lệnh này. Cần role NPC.');
      return;
    }

    try {
      // Reset all scrim data
      scrimData.session1Time = 'Đang tìm đối thủ';
      scrimData.session1Opponent = 'Đang tìm đối thủ';
      scrimData.session2Time = 'Đang tìm đối thủ';
      scrimData.session2Opponent = 'Đang tìm đối thủ';
      scrimData.updatedAt = getFormattedDateTime();

      // Update the scrim message
      if (scrimData.messageId && scrimData.channelId) {
        const channel = await client.channels.fetch(scrimData.channelId);
        const scrimMessage = await channel.messages.fetch(scrimData.messageId);
        await scrimMessage.edit({
          content: formatScrimMessage(),
          allowedMentions: { roles: [] }, // don't re-ping on edit
        });
      }

      // Xóa lệnh của người dùng
      await message.delete().catch(err => console.error('Failed to delete command message:', err.message));
    } catch (error) {
      console.error('Failed to reset scrim data:', error.message);
      message.reply('❌ Lỗi khi reset thông tin scrim.');
    }
    return;
  }

  if (content.toLowerCase() === 'nm!bc') {
    try {
      await resetOffVoteSheet();

      const bcMessage = await message.channel.send({
        content: formatBcMessage([]),
        allowedMentions: { roles: SCRIM_PING_ROLE_ID ? [SCRIM_PING_ROLE_ID] : [] },
      });

      bcData.messageId = bcMessage.id;
      bcData.channelId = message.channelId;

      await bcMessage.react(OFFLINE_EMOJI_REACT);
    } catch (error) {
      console.error('Failed to send bang chien message:', error.message);
      message.reply('❌ Lỗi khi gửi tin nhắn điểm danh bang chiến.');
    }
    return;
  }

  if (content.toLowerCase().startsWith('nm!hi')) {
    const taggedUser = message.mentions.users.first();

    if (!taggedUser) {
      message.reply('Format: `nm!hi @user`');
      return;
    }

    message.channel.send(
      `Xin chào bạn <@${taggedUser.id}> đến với Nhất Mộng:\n` +
      `Bạn vui lòng update thông tin tại: <#${UPDATE_INFO_CHANNEL_ID}>\n` +
      `Theo dõi thông tin đăng ký scrim bang tại: <#${SCRIM_SIGNUP_CHANNEL_ID}> .`
    );

    await message.delete().catch(err => console.error('Failed to delete command message:', err.message));
    return;
  }

  if (content.toLowerCase() === 'nm!testbc') {
    if (!message.member.roles.cache.has(NPC_ROLE_ID)) {
      message.reply('❌ Bạn không có quyền sử dụng lệnh này. Cần role NPC.');
      return;
    }

    await sendReminderMessage(formatBcReminderMessage());
    return;
  }

  if (content.toLowerCase() === 'nm!testgcmn') {
    if (!message.member.roles.cache.has(NPC_ROLE_ID)) {
      message.reply('❌ Bạn không có quyền sử dụng lệnh này. Cần role NPC.');
      return;
    }

    await sendReminderMessage(formatGcmnReminderMessage());
    return;
  }

  if (content.toLowerCase().startsWith('nm!moe')) {
    const taggedUser = message.mentions.users.first();
    const tagText = taggedUser ? `<@${taggedUser.id}> ` : '';

    await message.channel.send(`${tagText}Doki doki fuwa fuwa oshikunare moe moe kyun\nhttps://tenor.com/bYtCT.gif`);

    await message.delete().catch(err => console.error('Failed to delete command message:', err.message));
    return;
  }

  if (content.toLowerCase() === 'nm!ping') {
    message.reply('Pong!');
  }
});

async function removeVoteFromSheet(userId, day) {
  if (!SPREADSHEET_ID) {
    console.warn('GOOGLE_SHEET_ID is not set. Vote not removed from Google Sheets.');
    return;
  }

  const authClient = await getGoogleAuthClient();

  if (!authClient) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const spreadsheetResponse = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetsData = spreadsheetResponse.data.sheets || [];
    const botVoteSheetData = sheetsData.find((sheet) => sheet.properties.title === SHEET_NAME);

    if (!botVoteSheetData) {
      console.warn(`Sheet ${SHEET_NAME} not found in spreadsheet.`);
      return;
    }

    const sheetId = botVoteSheetData.properties.sheetId;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:H`,
    });

    const rows = response.data.values || [];
    const rowsToDelete = [];

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const rowUserId = row[4] !== undefined && row[4] !== null ? String(row[4]).trim() : '';
      const rowDay = row[6] !== undefined && row[6] !== null ? String(row[6]).trim() : '';

      if (rowUserId === String(userId).trim() && rowDay === String(day).trim()) {
        rowsToDelete.push(i + 1);
      }
    }

    if (rowsToDelete.length === 0) {
      console.log(`No vote found for user ${userId} on day ${day}.`);
      return;
    }

    const requests = rowsToDelete.reverse().map((rowIndex) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIndex - 1,
          endIndex: rowIndex,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests,
      },
    });

    console.log(`Removed vote for user ${userId} -> day ${day} from Google Sheets.`);
    await refreshResultSheet();
  } catch (error) {
    console.error('Failed to remove vote from Google Sheets:', error.message);
  }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  const message = reaction.message;

  // Bang chiến offline check-in
  if (
    reaction.emoji.id === OFFLINE_EMOJI_ID &&
    bcData.messageId &&
    message.id === bcData.messageId
  ) {
    await addOffVote(user.id);
    return;
  }

  const day = DAY_REACTIONS[reaction.emoji.name];

  if (day === undefined) {
    return;
  }

  await saveVoteToSheet({
    guildId: message.guildId || 'dm',
    channelId: message.channelId,
    messageId: message.id,
    userId: user.id,
    username: user.username || user.tag || user.id,
    day,
    reaction: reaction.emoji.name,
  });
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;

  const message = reaction.message;

  // Bang chiến offline check-in
  if (
    reaction.emoji.id === OFFLINE_EMOJI_ID &&
    bcData.messageId &&
    message.id === bcData.messageId
  ) {
    await removeOffVote(user.id);
    return;
  }

  const day = DAY_REACTIONS[reaction.emoji.name];

  if (day === undefined) {
    return;
  }

  await removeVoteFromSheet(user.id, day);
});

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ ERROR: DISCORD_TOKEN is not set. Please set the DISCORD_TOKEN environment variable.');
  process.exit(1);
}

// Start HTTP server for Render health checks
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'VoteBot is running!' }));
}).listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});

client.login(token);