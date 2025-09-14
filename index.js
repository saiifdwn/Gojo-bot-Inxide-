import login from "fca-smart-shankar";
import fs from "fs";
import express from "express";

const OWNER_UIDS = ["100028387782094"];
let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
let mediaLoopInterval = null;
let lastMedia = null;
let targetUID = null;
let stickerInterval = null;
let stickerLoopActive = false;

const friendUIDs = fs.existsSync("Friend.txt") ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean) : [];

const targetUIDs = fs.existsSync("Target.txt") ? fs.readFileSync("Target.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean) : [];

const messageQueues = {};
const queueRunning = {};

const app = express();
app.get("/", (_, res) => res.send("<h2>Messenger Bot Running</h2>"));
app.listen(20782, () => console.log("🌐 Log server: http://localhost:20782"));

process.on("uncaughtException", (err) => console.error("❗ Uncaught Exception:", err.message));
process.on("unhandledRejection", (reason) => console.error("❗ Unhandled Rejection:", reason));

login({ appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) }, (err, api) => {
  if (err) return console.error("❌ Login failed:", err);
  api.setOptions({ listenEvents: true });
  console.log("✅ Bot logged in and running...");

  api.listenMqtt(async (err, event) => {
    try {
      if (err || !event) return;
      const { threadID, senderID, body, messageID } = event;

      const enqueueMessage = (uid, threadID, messageID, api) => {
        if (!messageQueues[uid]) messageQueues[uid] = [];
        messageQueues[uid].push({ threadID, messageID });

        if (queueRunning[uid]) return;
        queueRunning[uid] = true;

        const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
        let index = 0;

        const processQueue = async () => {
          if (!messageQueues[uid].length) {
            queueRunning[uid] = false;
            return;
          }

          const msg = messageQueues[uid].shift();
          const randomLine = lines[Math.floor(Math.random() * lines.length)];

          api.sendMessage(randomLine, msg.threadID, msg.messageID);
          setTimeout(processQueue, 20000);
        };

        processQueue();
      };

      if (fs.existsSync("np.txt") && (targetUIDs.includes(senderID) || senderID === targetUID)) {
        enqueueMessage(senderID, threadID, messageID, api);
      }

      if (event.type === "event" && event.logMessageType === "log:thread-name") {
        const currentName = event.logMessageData.name;
        const lockedName = lockedGroupNames[threadID];
        if (lockedName && currentName !== lockedName) {
          try {
            await api.setTitle(lockedName, threadID);
            api.sendMessage(`  "${lockedName}"`, threadID);
          } catch (e) {
            console.error("❌ Error reverting group name:", e.message);
          }
        }
        return;
      }

      if (!body) return;
      const lowerBody = body.toLowerCase();

      const badNames = ["9RVII", "YUVII", "anox", "avii", "satya", "anox", "avi"];
      const triggers = ["rkb", "bhen", "maa", "Rndi", "chut", "randi", "madhrchodh", "mc", "bc", "didi", "ma"];

      if (
        badNames.some(n => lowerBody.includes(n)) &&
        triggers.some(w => lowerBody.includes(w)) &&
        !friendUIDs.includes(senderID)
      ) {
        return api.sendMessage(
          "Teri Maa Randi Hai Tu Bat Na Kr Bahen Ke Lowde Warnaa Teri Maa Chod Duga Me Gandu :) <3",
          threadID,
          messageID
        );
      }

      if (!OWNER_UIDS.includes(senderID)) return;

      const args = body.trim().split(" ");
      const cmd = args[0].toLowerCase();
      const input = args.slice(1).join(" ");

      if (cmd === "/allname") {
        try {
          const info = await api.getThreadInfo(threadID);
          const members = info.participantIDs;
          api.sendMessage(`🛠  ${members.length} ' nicknames...`, threadID);
          for (const uid of members) {
            try {
              await api.changeNickname(input, threadID, uid);
              console.log(`✅ Nickname changed for UID: ${uid}`);
              await new Promise(res => setTimeout(res, 30000));
            } catch (e) {
              console.log(`⚠️ Failed for ${uid}:`, e.message);
            }
          }
          api.sendMessage("is chutiye ki to maa chud gayi aaj", threadID);
        } catch (e) {
          console.error("❌ Error in /allname:", e);
          api.sendMessage("badh me kLpauga", threadID);
        }
      }

      else if (cmd === "/groupname") {
        try {
          await api.setTitle(input, threadID);
          api.sendMessage(`📝 Group name changed to: ${input}`, threadID);
        } catch {
          api.sendMessage(" klpoo🤣 rkb", threadID);
        }
      }

      else if (cmd === "/lockgroupname") {
        if (!input) return api.sendMessage("name de 🤣 gc ke Liye", threadID);
        try {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage(`🔒 Group name  "${input}"`, threadID);
        } catch {
          api.sendMessage("❌ Locking failed.", threadID);
        }
      }

      else if (cmd === "/unlockgroupname") {
        delete lockedGroupNames[threadID];
        api.sendMessage("🔓 Group name unlocked.", threadID);
      }

      else if (cmd === "/uid") {
        api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
      }

      else if (cmd === "/exit") {
        try {
          await api.removeUserFromGroup(api.getCurrentUserID(), threadID);
        } catch {
          api.sendMessage("❌ Can't leave group.", threadID);
        }
      }

      else if (cmd === "/rkb") {
        if (!fs.existsSync("np.txt")) return api.sendMessage("konsa gaLi du rkb ko", threadID);
        const name = input.trim();
        const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
        stopRequested = false;

        if (rkbInterval) clearInterval(rkbInterval);
        let index = 0;

        rkbInterval = setInterval(() => {
          if (index >= lines.length || stopRequested) {
            clearInterval(rkbInterval);
            rkbInterval = null;
            return;
          }
          api.sendMessage(`${name} ${lines[index]}`, threadID);
          index++;
        }, 60000);

        api.sendMessage(`sex hogya bche 🤣rkb ${name}`, threadID);
      }

      else if (cmd === "/stop") {
        stopRequested = true;
        if (rkbInterval) {
          clearInterval(rkbInterval);
          rkbInterval = null;
          api.sendMessage("chud gaye bche🤣", threadID);
        } else {
          api.sendMessage("konsa gaLi du sale ko🤣 rkb tha", threadID);
        }
      }

      else if (cmd === "/photo") {
        api.sendMessage("📸 Send a photo or video within 1 minute...", threadID);

        const handleMedia = async (mediaEvent) => {
          if (
            mediaEvent.type === "message" &&
            mediaEvent.threadID === threadID &&
            mediaEvent.attachments &&
            mediaEvent.attachments.length > 0
          ) {
            lastMedia = {
              attachments: mediaEvent.attachments,
              threadID: mediaEvent.threadID
            };

            api.sendMessage("✅ Photo/video received. Will resend every 30 seconds.", threadID);

            if (mediaLoopInterval) clearInterval(mediaLoopInterval);
            mediaLoopInterval = setInterval(() => {
              if (lastMedia) {
                api.sendMessage({ attachment: lastMedia.attachments }, lastMedia.threadID);
              }
            }, 30000);

            api.removeListener("message", handleMedia);
          }
        };

        api.on("message", handleMedia);
      }

      else if (cmd === "/stopphoto") {
        if (mediaLoopInterval) {
          clearInterval(mediaLoopInterval);
          mediaLoopInterval = null;
          lastMedia = null;
          api.sendMessage("chud gaye sb.", threadID);
        } else {
          api.sendMessage("🤣ro sale chnar", threadID);
        }
      }

      else if (cmd === "/forward") {
        try {
          const info = await api.getThreadInfo(threadID);
          const members = info.participantIDs;

          const msgInfo = event.messageReply;
          if (!msgInfo) return api.sendMessage("❌ Kisi message ko reply karo bhai", threadID);

          for (const uid of members) {
            if (uid !== api.getCurrentUserID()) {
              try {
                await api.sendMessage({
                  body: msgInfo.body || "",
                  attachment: msgInfo.attachments || []
                }, uid);
              } catch (e) {
                console.log(`⚠️ Can't send to ${uid}:`, e.message);
              }
              await new Promise(res => setTimeout(res, 2000));
            }
          }

          api.sendMessage("📨 Forwarding complete.", threadID);
        } catch (e) {
          console.error("❌ Error in /forward:", e.message);
          api.sendMessage("❌ Error bhai, check logs", threadID);
        }
      }

      else if (cmd === "/target") {
        if (!args[1]) return api.sendMessage("👤 UID de jisko target krna h", threadID);
        targetUID = args[1];
        api.sendMessage(`ye chudega bhen ka Lowda ${targetUID}`, threadID);
      }

      else if (cmd === "/cleartarget") {
        targetUID = null;
        api.sendMessage("ro kr kLp gya bkL🤣", threadID);
      }

      else if (cmd === "/help") {
        const helpText = `
╭────────────────────╮
       💜   [[ LUFFY 𝗫𝗗 ]]    💜
╰────────────────────╯
╭─────────────────────►
│    /allname <name> 
│    /groupname <name>
│    /lockgroupname │<name> 
│    /unlockgroupname –     │Unlock 
│    /uid – gc uid
│    /exit – left group
╰─────────────────►
╭─────────────────────►
│ /rkb <name> 
│ /stop – Stope Fyt
│ /photo – Send photo/vedio
│/stopphoto – Stop
│/forward – Reply A massege
│/target <uid> –
│/cleartarget – Stop │Abusing Target
│/sticker<seconds>
│/stopsticker
╰─────────────────►
╭─────────────────────►
│  All Right Reserved By Luffy
╰─────────────────►`;
        var link = ["https://i.imgur.com/iit7sl4.jpeg"];
        api.sendMessage(helpText.trim(), threadID);
      }

      else if (cmd.startsWith("/sticker")) {
        if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt not found", threadID);

        const delay = parseInt(cmd.replace("/sticker", ""));
        if (isNaN(delay) || delay < 5) return api.sendMessage("🕐 Bhai sahi time de (min 5 seconds)", threadID);

        const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
        if (!stickerIDs.length) return api.sendMessage("⚠️ Sticker.txt khali hai bhai", threadID);

        if (stickerInterval) clearInterval(stickerInterval);
        let i = 0;
        stickerLoopActive = true;

        api.sendMessage(`📦 Sticker bhejna start: har ${delay} sec`, threadID);

        stickerInterval = setInterval(() => {
          if (!stickerLoopActive || i >= stickerIDs.length) {
            clearInterval(stickerInterval);
            stickerInterval = null;
            stickerLoopActive = false;
            return;
          }

          api.sendMessage({ sticker: stickerIDs[i] }, threadID);
          i++;
        }, delay * 1000);
      }

      else if (cmd === "/stopsticker") {
        if (stickerInterval) {
          clearInterval(stickerInterval);
          stickerInterval = null;
          stickerLoopActive = false;
          api.sendMessage("🛑 Sticker bhejna band", threadID);
        } else {
          api.sendMessage("😒 Bhai kuch bhej bhi rha tha kya?", threadID);
        }
      }

    } catch (e) {
      console.error("⚠️ Error in message handler:", e.message);
    }
  });
});
