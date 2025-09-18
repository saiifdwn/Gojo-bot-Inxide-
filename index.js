// bot.js
// Run with Node (v16+). Keep appstate.json present and required text files in same folder.
// Uses ES module import syntax (if your project doesn't use ESM, convert imports to require).

import login from "fca-smart-shankar";
import fs from "fs";
import path from "path";

// ---------------- Configuration ----------------
const OWNER_UIDS = ["100028387782094"]; // keep owner IDs here

const PORT = 20782; // optional small express status server port (kept minimal)
import express from "express";
const app = express();
app.get("/", (_, res) => res.send("<h2>Messenger Bot Running</h2>"));
app.listen(PORT, () => console.log(`🌐 Status: http://localhost:${PORT}`));

// ---------------- Utility Helpers ----------------
const readLines = (file) => {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch (e) {
    console.error(`❗ Error reading ${file}:`, e.message);
    return [];
  }
};

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const safeGet = (obj, key, fallback = "") => (obj && obj[key]) ? obj[key] : fallback;

// ---------------- Data caches & watchers ----------------
const FILES = {
  np: path.resolve("np.txt"),
  Sticker: path.resolve("Sticker.txt"),
  Friend: path.resolve("Friend.txt"),
  Target: path.resolve("Target.txt"),
  appstate: path.resolve("appstate.json")
};

let CACHE = {
  np: readLines(FILES.np),
  Sticker: readLines(FILES.Sticker),
  Friend: readLines(FILES.Friend),
  Target: readLines(FILES.Target)
};

const watchFileReload = (key, filePath) => {
  if (!fs.existsSync(filePath)) return;
  try {
    fs.watch(filePath, { persistent: false }, () => {
      console.log(`🔁 File changed -> reloading ${filePath}`);
      CACHE[key] = readLines(filePath);
    });
  } catch (e) {
    // fs.watch may throw on some environments; ignore
  }
};

Object.entries(FILES).forEach(([k, p]) => {
  if (k === "appstate") return;
  watchFileReload(k, p);
});

// ---------------- Interval / queue management (per-thread) ----------------
const threadIntervals = {
  rkb: {},            // threadID -> intervalID
  mediaLoop: {},      // threadID -> intervalID
  sticker: {},        // threadID -> intervalID
  queueRunning: {},   // uid -> boolean
  messageQueues: {}   // uid -> [{ threadID, messageID }]
};

// clear interval safe func
const clearThreadInterval = (map, threadID) => {
  if (map[threadID]) {
    clearInterval(map[threadID]);
    delete map[threadID];
  }
};

// ---------------- Login & Event Handling ----------------
let apiInstance = null;

// Validate appstate exists
if (!fs.existsSync(FILES.appstate)) {
  console.error("❌ appstate.json not found in current folder. Place your appstate.json here.");
  process.exit(1);
}

const appstate = JSON.parse(fs.readFileSync(FILES.appstate, "utf8"));

login({ appState: appstate }, (err, api) => {
  if (err) {
    console.error("❌ Login failed:", err);
    return;
  }
  apiInstance = api;
  api.setOptions({ listenEvents: true, selfListen: false }); // configure if supported
  console.log("✅ Bot logged in and running...");

  // Use mqtt listener if available, else fallback to on('message')
  // Many implementations use api.listenMqtt((err, event) => {...})
  if (typeof api.listenMqtt === "function") {
    api.listenMqtt((err, event) => {
      if (err) return console.error("❗ listenMqtt error:", err);
      handleEventSafe(event, api);
    });
  } else if (typeof api.listen === "function") {
    // older or different libs
    api.listen((err, event) => {
      if (err) return console.error("❗ listen error:", err);
      handleEventSafe(event, api);
    });
  } else {
    // fallback to message event
    api.on && api.on("message", (event) => handleEventSafe(event, api));
  }
});

// Wrap handler to catch exceptions
async function handleEventSafe(event, api) {
  try {
    await handleEvent(event, api);
  } catch (e) {
    console.error("⚠️ Uncaught handler error:", e && e.message ? e.message : e);
  }
}

// Main event handler
async function handleEvent(event, api) {
  if (!event) return;
  // Useful debugging - uncomment if you need verbose logs:
  // console.log("EVENT:", JSON.stringify(event).slice(0,400));

  // Normalize fields that vary by lib versions:
  const threadID = safeGet(event, "threadID") || safeGet(event, "thread_id") || safeGet(event, "thread", {}).id;
  const senderID = safeGet(event, "senderID") || safeGet(event, "sender_id") || safeGet(event, "sender", {}).id;
  const messageID = safeGet(event, "messageID") || safeGet(event, "message_id");
  let body = safeGet(event, "body", "");

  // Some events like message_reaction or other types don't have body
  if (!body && event.message && event.message.body) body = event.message.body;
  if (!threadID || !senderID) return; // can't proceed

  // Normalize & sanitize
  body = String(body || "").trim();
  if (!body) {
    // handle events that are not text messages (e.g., thread-name change)
    if (event.type === "event" && event.logMessageType === "log:thread-name") {
      await handleThreadNameChange(event, api);
    }
    return;
  }
  const lowerBody = body.replace(/\s+/g, " ").trim();
  const args = lowerBody.split(" ").filter(Boolean);
  const cmdRaw = args[0] || "";
  const cmd = cmdRaw.toLowerCase();
  const input = args.slice(1).join(" ").trim();

  // quick friend check from cache
  const isFriend = CACHE.Friend.includes(senderID);

  // Auto-responder queue: if message from target(s) or targetUID variable, enqueue reply
  if (CACHE.np.length && (CACHE.Target.includes(senderID) || (globalThis.targetUID && globalThis.targetUID === senderID))) {
    enqueueMessageForUid(senderID, threadID, messageID, api);
  }

  // handle group name lock events
  if (event.type === "event" && event.logMessageType === "log:thread-name") {
    await handleThreadNameChange(event, api);
    return;
  }

  // Basic abusive filter (keeps the original behavior). If friend, skip.
  const lower = lowerBody.toLowerCase();
  const badNames = ["9rvii","yuvii","anox","avii","satya","anox","avi"];
  const triggers = ["rkb","bhen","maa","rndi","chut","randi","madhrchodh","mc","bc","didi","ma"];
  if (!isFriend && badNames.some(n => lower.includes(n)) && triggers.some(t => lower.includes(t))) {
    try {
      await api.sendMessage("Teri Maa Randi Hai Tu Bat Na Kr Bahen Ke Lowde Warnaa Teri Maa Chod Duga Me Gandu :) <3", threadID, messageID);
    } catch (e) { /* ignore send errors */ }
    return;
  }

  // owner-only commands
  const isOwner = OWNER_UIDS.includes(senderID);
  if (!isOwner) {
    // Not owner: allow only basic commands maybe /help? But original code checked owner early.
    // We'll process only help-like commands from non-owners if needed:
    if (cmd === "/help") {
      const helpText = `╭────────────────────╮
       💜   [[ LUFFY 𝗫𝗗 ]]    💜
╰────────────────────╯
Commands are owner-only.`;
      await safeSend(api, helpText, threadID);
    }
    return;
  }

  // ---------- OWNER Commands ----------
  switch (true) {
    case cmd === "/allname":
      await cmdAllName(input, threadID, api);
      break;

    case cmd === "/groupname":
      await cmdGroupName(input, threadID, api);
      break;

    case cmd === "/lockgroupname":
      await cmdLockGroupName(input, threadID, api);
      break;

    case cmd === "/unlockgroupname":
      await cmdUnlockGroupName(threadID, api);
      break;

    case cmd === "/uid":
      await safeSend(api, `🆔 Group ID: ${threadID}`, threadID);
      break;

    case cmd === "/exit":
      await cmdExit(threadID, api);
      break;

    case cmd === "/rkb":
      await cmdRkb(input, threadID, api);
      break;

    case cmd === "/stop":
      await cmdStop(threadID, api);
      break;

    case cmd === "/photo":
      await cmdPhotoListen(threadID, api);
      break;

    case cmd === "/stopphoto":
      await cmdStopPhoto(threadID, api);
      break;

    case cmd === "/forward":
      await cmdForward(event, threadID, api);
      break;

    case cmd === "/target":
      await cmdSetTarget(args, threadID, api);
      break;

    case cmd === "/cleartarget":
      globalThis.targetUID = null;
      await safeSend(api, "Target cleared.", threadID);
      break;

    case cmd === "/help":
      await cmdHelp(threadID, api);
      break;

    case cmd.startsWith("/sticker"):
      await cmdSticker(cmd, threadID, api);
      break;

    case cmd === "/stopsticker":
      await cmdStopSticker(threadID, api);
      break;

    default:
      // unknown owner command -> ignore or respond
      // console.log("Unknown command:", cmd);
      break;
  }
}

// ---------- Helper: safe send with retries ----------
async function safeSend(api, message, toThread, messageID = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      if (messageID) await api.sendMessage(message, toThread, messageID);
      else await api.sendMessage(message, toThread);
      return true;
    } catch (e) {
      console.warn(`⚠️ sendMessage failed (attempt ${i+1}):`, e.message || e);
      await sleep(1000 * (i + 1));
    }
  }
  console.error("❌ sendMessage final failure:", message);
  return false;
}

// ---------- Thread name lock handler ----------
const lockedGroupNames = {}; // threadID -> name

async function handleThreadNameChange(event, api) {
  try {
    const threadID = safeGet(event, "threadID");
    if (!threadID) return;
    const lockedName = lockedGroupNames[threadID];
    const currentName = safeGet(event, "logMessageData", {}).name || safeGet(event, "logMessageData", {}).title;
    if (lockedName && currentName && currentName !== lockedName) {
      try {
        await api.setTitle(lockedName, threadID);
        await safeSend(api, `🔒 Reverted group name to "${lockedName}"`, threadID);
      } catch (e) {
        console.error("❌ Error reverting group name:", e.message);
      }
    }
  } catch (e) {
    console.error("⚠️ handleThreadNameChange error:", e.message);
  }
}

// ---------- Command implementations ----------
async function cmdAllName(input, threadID, api) {
  if (!input) return safeSend(api, "Usage: /allname <name>", threadID);
  try {
    const info = await api.getThreadInfo(threadID);
    const members = info && info.participantIDs ? info.participantIDs : [];
    await safeSend(api, `🛠 Changing nicknames for ${members.length} members...`, threadID);

    for (const uid of members) {
      try {
        // set nickname with retries
        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
          try {
            await api.changeNickname(input, threadID, uid);
            ok = true;
          } catch (e) {
            console.warn(`⚠️ changeNickname attempt ${attempt} for ${uid} failed:`, e.message || e);
            await sleep(2000 * attempt);
          }
        }
        await sleep(1500); // shorter delay to be faster but safer
      } catch (e) {
        console.warn(`⚠️ Failed to change nickname for ${uid}:`, e.message || e);
      }
    }
    await safeSend(api, `✅ All nicknames processed.`, threadID);
  } catch (e) {
    console.error("❌ /allname error:", e.message || e);
    await safeSend(api, "❌ Error processing /allname", threadID);
  }
}

async function cmdGroupName(input, threadID, api) {
  if (!input) return safeSend(api, "Usage: /groupname <name>", threadID);
  try {
    await api.setTitle(input, threadID);
    await safeSend(api, `📝 Group name changed to: ${input}`, threadID);
  } catch (e) {
    console.error("/groupname error:", e.message || e);
    await safeSend(api, "❌ Failed to change group name.", threadID);
  }
}

async function cmdLockGroupName(input, threadID, api) {
  if (!input) return safeSend(api, "Usage: /lockgroupname <name>", threadID);
  try {
    await api.setTitle(input, threadID);
    lockedGroupNames[threadID] = input;
    await safeSend(api, `🔒 Locked group name to: ${input}`, threadID);
  } catch (e) {
    console.error("/lockgroupname error:", e.message || e);
    await safeSend(api, "❌ Locking failed.", threadID);
  }
}

async function cmdUnlockGroupName(threadID, api) {
  delete lockedGroupNames[threadID];
  await safeSend(api, "🔓 Group name unlocked.", threadID);
}

async function cmdExit(threadID, api) {
  try {
    const myId = await api.getCurrentUserID();
    await api.removeUserFromGroup(myId, threadID);
  } catch (e) {
    console.error("/exit error:", e.message || e);
    await safeSend(api, "❌ Can't leave group.", threadID);
  }
}

// ---------- rkb spam (per-thread, safe) ----------
async function cmdRkb(input, threadID, api) {
  if (!CACHE.np.length) return safeSend(api, "np.txt is missing or empty.", threadID);
  if (!input) return safeSend(api, "Usage: /rkb <name>", threadID);

  // ensure we clear any existing interval in this thread
  clearThreadInterval(threadIntervals.rkb, threadID);

  const lines = CACHE.np.slice(); // copy
  let index = 0;
  const name = input.trim();
  threadIntervals.rkb[threadID] = setInterval(async () => {
    try {
      if (index >= lines.length) {
        clearThreadInterval(threadIntervals.rkb, threadID);
        await safeSend(api, "✅ rkb cycle finished.", threadID);
        return;
      }
      await safeSend(api, `${name} ${lines[index]}`, threadID);
      index++;
    } catch (e) {
      console.error("❌ rkb send error:", e.message || e);
    }
  }, 60 * 1000); // 60s
  await safeSend(api, `🚀 rkb started for ${name}`, threadID);
}

async function cmdStop(threadID, api) {
  // stop rkb in this thread
  if (threadIntervals.rkb[threadID]) {
    clearThreadInterval(threadIntervals.rkb, threadID);
    await safeSend(api, "🛑 rkb stopped.", threadID);
  } else {
    await safeSend(api, "ℹ️ No rkb running in this chat.", threadID);
  }
}

// ---------- photo loop (listen for next media; resend periodically) ----------
async function cmdPhotoListen(threadID, api) {
  await safeSend(api, "📸 Send a photo or video within 60 seconds to capture and loop it.", threadID);

  // temporary listener - will auto-remove after capturing
  const timeout = 60 * 1000;
  let captured = false;

  const handler = async (mediaEvent) => {
    try {
      if (!mediaEvent || !mediaEvent.threadID) return;
      if (mediaEvent.threadID !== threadID) return;
      // attachments array might be in different path depending on lib
      const attachments = safeGet(mediaEvent, "attachments") || safeGet(mediaEvent, "message", {}).attachments || [];
      if (!attachments || attachments.length === 0) return;

      captured = true;
      // store last media per-thread
      threadIntervals.lastMedia = threadIntervals.lastMedia || {};
      threadIntervals.lastMedia[threadID] = { attachments, threadID };

      // clear old interval if exists
      clearThreadInterval(threadIntervals.mediaLoop, threadID);
      // start new interval: every 30s resend attachments
      threadIntervals.mediaLoop[threadID] = setInterval(async () => {
        try {
          const saved = threadIntervals.lastMedia && threadIntervals.lastMedia[threadID];
          if (saved && saved.attachments) {
            await api.sendMessage({ attachment: saved.attachments }, saved.threadID);
          }
        } catch (e) {
          console.error("❌ media resend error:", e.message || e);
        }
      }, 30 * 1000);

      await safeSend(api, "✅ Photo/video captured — will resend every 30 seconds.", threadID);
      // remove listener once captured
      api.removeListener && api.removeListener("message", handler);
    } catch (e) {
      console.error("⚠️ photo handler error:", e.message || e);
    }
  };

  // attach listener
  api.on && api.on("message", handler);

  // fallback timeout that removes listener
  setTimeout(() => {
    if (!captured) {
      try { api.removeListener && api.removeListener("message", handler); } catch(e) {}
      safeSend(api, "⏳ No media received — photo capture canceled.", threadID);
    }
  }, timeout);
}

async function cmdStopPhoto(threadID, api) {
  clearThreadInterval(threadIntervals.mediaLoop, threadID);
  if (threadIntervals.lastMedia && threadIntervals.lastMedia[threadID]) {
    delete threadIntervals.lastMedia[threadID];
  }
  await safeSend(api, "🛑 Photo loop stopped.", threadID);
}

// ---------- forward message to group members ----------
async function cmdForward(event, threadID, api) {
  try {
    const info = await api.getThreadInfo(threadID);
    const members = info && info.participantIDs ? info.participantIDs : [];
    const msgInfo = event.messageReply || event.message || {};
    if (!msgInfo || (!msgInfo.body && (!msgInfo.attachments || !msgInfo.attachments.length))) {
      return safeSend(api, "❗ Reply to a message to forward it to all group members.", threadID);
    }

    await safeSend(api, `📨 Forwarding to ${members.length} members...`, threadID);

    for (const uid of members) {
      if (uid === (await api.getCurrentUserID())) continue;
      try {
        await api.sendMessage({
          body: msgInfo.body || "",
          attachment: msgInfo.attachments || []
        }, uid);
      } catch (e) {
        console.warn(`⚠️ Can't forward to ${uid}:`, e.message || e);
      }
      await sleep(1200);
    }
    await safeSend(api, "✅ Forwarding complete.", threadID);
  } catch (e) {
    console.error("/forward error:", e.message || e);
    await safeSend(api, "❌ Error forwarding message.", threadID);
  }
}

// ---------- target / cleartarget ----------
async function cmdSetTarget(args, threadID, api) {
  if (!args[1]) return safeSend(api, "Usage: /target <uid>", threadID);
  globalThis.targetUID = args[1].trim();
  await safeSend(api, `✅ Target set to ${globalThis.targetUID}`, threadID);
}

// ---------- help ----------
async function cmdHelp(threadID, api) {
  const helpText = `
╭────────────────────╮
       💜   [[ LUFFY 𝗫𝗗 ]]    💜
╰────────────────────╯
/allname <name>
/groupname <name>
/lockgroupname <name>
/unlockgroupname
/uid
/exit
/rkb <name>
/stop
/photo
/stopphoto
/forward
/target <uid>
/cleartarget
/sticker<seconds>
/stopsticker
`;
  await safeSend(api, helpText, threadID);
}

// ---------- sticker loop ----------
async function cmdSticker(cmdRaw, threadID, api) {
  if (!CACHE.Sticker.length) return safeSend(api, "Sticker.txt missing or empty.", threadID);
  const delayStr = cmdRaw.replace("/sticker", "").trim();
  const delay = parseInt(delayStr, 10);
  if (isNaN(delay) || delay < 5) return safeSend(api, "Provide a delay in seconds (min 5). Example: /sticker10");

  // clear any existing interval for this thread
  clearThreadInterval(threadIntervals.sticker, threadID);
  let i = 0;
  const stickerIDs = CACHE.Sticker.slice();

  threadIntervals.sticker[threadID] = setInterval(async () => {
    try {
      if (i >= stickerIDs.length) {
        clearThreadInterval(threadIntervals.sticker, threadID);
        return;
      }
      await api.sendMessage({ sticker: stickerIDs[i] }, threadID);
      i++;
    } catch (e) {
      console.error("❌ sticker send error:", e.message || e);
    }
  }, delay * 1000);

  await safeSend(api, `📦 Sticker loop started (every ${delay}s)`, threadID);
}

async function cmdStopSticker(threadID, api) {
  if (threadIntervals.sticker[threadID]) {
    clearThreadInterval(threadIntervals.sticker, threadID);
    await safeSend(api, "🛑 Sticker loop stopped.", threadID);
  } else {
    await safeSend(api, "ℹ️ No sticker loop running.", threadID);
  }
}

// ---------- Queue / Autoreply for target UIDs ----------
function enqueueMessageForUid(uid, threadID, messageID, api) {
  if (!threadIntervals.messageQueues[uid]) threadIntervals.messageQueues[uid] = [];
  threadIntervals.messageQueues[uid].push({ threadID, messageID });

  if (threadIntervals.queueRunning[uid]) return;
  threadIntervals.queueRunning[uid] = true;

  const lines = CACHE.np.length ? CACHE.np.slice() : [];
  let index = 0;

  const processQueue = async () => {
    if (!threadIntervals.messageQueues[uid] || !threadIntervals.messageQueues[uid].length) {
      threadIntervals.queueRunning[uid] = false;
      return;
    }
    const msg = threadIntervals.messageQueues[uid].shift();
    try {
      const randomLine = lines.length ? lines[Math.floor(Math.random() * lines.length)] : "hello";
      await safeSend(api, randomLine, msg.threadID, msg.messageID);
    } catch (e) {
      console.error("❌ enqueue send error:", e.message || e);
    }
    // schedule next
    setTimeout(processQueue, 20000);
  };

  processQueue();
}

// ---------------- Graceful shutdown ----------------
process.on("SIGINT", () => {
  console.log("🔌 Shutting down... clearing intervals.");
  Object.values(threadIntervals.rkb).forEach(i => clearInterval(i));
  Object.values(threadIntervals.mediaLoop).forEach(i => clearInterval(i));
  Object.values(threadIntervals.sticker).forEach(i => clearInterval(i));
  process.exit(0);
});
