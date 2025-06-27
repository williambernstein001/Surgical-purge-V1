//index.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } from "@whiskeysocket/baileys";
import pino from "pino";

const PREFIX = "😈";

async function startBot() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  // Auto reconnect
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        startBot();
      } else {
        console.log("Logged out, please delete auth_info folder and re-scan QR.");
      }
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // In-memory auto promote flag (can be extended to persistent storage)
  let autoPromoteActive = false;

  // Helper: check if bot is admin
  async function isBotAdmin(jid) {
  try {
      const metadata = await sock.groupMetadata(jid);
      const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      const admins = metadata.participants.filter((p) => p.admin !== null).map((p) => p.id);
      return admins.includes(botId);
    } catch {
      return false;
    }
  }

  // Command handlers

  async function handleAutoPromote(message) {
    const text = message.message?.conversation?.toLowerCase();
    if (text === "on") {
      autoPromoteActive = true;
      await sock.sendMessage(message.key.remoteJid, { text: "Auto Promote activé jeune maître." });
    } else if (text === "off") {
      autoPromoteActive = false;
      await sock.sendMessage(message.key.remoteJid, { text: "Auto Promote désactivé jeune maître" });
    } else {
      await sock.sendMessage(message.key.remoteJid, { text: "veuillez saisir 'on' ou 'off' pour utiliser cette commande." });
    }
  }

  async function revokeAdminsExceptBot(groupId) {
    try {
      const metadata = await sock.groupMetadata(groupId);
      const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      for (const participant of metadata.participants) {
        if (participant.admin && participant.id !== botId) {
          await sock.groupDemoteAdmin(groupId, participant.id);
        }
      }
    } catch (e) {
    console.error("pdm error:", e);
    }
  }

  async function ghostGroupMembers(groupId) {
    try {
      const metadata = await sock.groupMetadata(groupId);
      const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";

      await sock.sendMessage(groupId, { text: "bien maître, nous pouvons à présent commencer la purification 🧎🙏" });
      await delay(5000);

      for (const participant of metadata.participants) {
        if (participant.id !== botId && !participant.admin) {
          await sock.groupRemove(groupId, [participant.id]);
        }
      }
      await sock.sendMessage(groupId, { text: "Purification terminée jeune maitre😇" });
    } catch (e) {
      console.error("ghost error:", e);
    }
  }

  async function kickMember(groupId, jid) {
    try {
      await sock.groupRemove(groupId, [jid]);
    } catch (e) {
      console.error("kick error:", e);
    }
  }

  // Anti-bot and anti-spam logic
  // For simplicity, will warn/delete/kick based on commands

  const userSpamMap = new Map();

  async function handleAntiBot(message, action) {
    const groupId = message.key.remoteJid;
    const sender = message.key.participant || message.key.remoteJid;
    if (!groupId.endsWith("@g.us")) return;
    if (!userSpamMap.has(sender)) userSpamMap.set(sender, { count: 0, last: Date.now(), warned: false });

    let userData = userSpamMap.get(sender);

    // Reset count if more than 10 seconds passed
    if (Date.now() - userData.last > 10000) {
      userData.count = 0;
      userData.warned = false;
    }

    userData.count++;
    userData.last = Date.now();

    if (userData.count >= 4) {
      if (action === "warn" && !userData.warned) {
        await sock.sendMessage(groupId, { text: `⚠️ @${sender.split("@")[0]}, action non autorisée, risque d'expulsion` }, { mentions: [sender] });
        userData.warned = true;
      } else if (action === "delete") {
        await sock.sendMessage(groupId, { delete: message.key });
      } else if (action === "kick") {
        await kickMember(groupId, sender);
      }
    }

    userSpamMap.set(sender, userData);
  }

  // Message event listener
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    if (!text.startsWith(PREFIX)) return;

    const commandBody = text.slice(PREFIX.length).trim().split(" ");
    const command = commandBody[0].toLowerCase();
    const args = commandBody.slice(1);

    const from = msg.key.remoteJid;

    // Auto promote on join group (if activated)
    if (msg.message?.groupInviteMessage) {
      if (autoPromoteActive && from.endsWith("@g.us")) {
        try {
          await sock.groupMakeAdmin(from, [sock.user.id]);
        } catch (e) {
          console.error("Auto promote error:", e);
        }
      }
    }

    switch (command) {
      case "autopromote":
        if (msg.key.remoteJid.endsWith("@g.us")) {
          await sock.sendMessage(from, { text: "⚠️Commande inaccessible dans les discussions de groupe, veuillez sotir maître." });
          return;
        }
        await handleAutoPromote(msg);
        break;

      case "pdm":
        if (!from.endsWith("@g.us")) return;
        await revokeAdminsExceptBot(from);
        break;

      case "ghost":
        if (!from.endsWith("@g.us")) return;
        await ghostGroupMembers(from);
        break;

      case "kick":
        if (!from.endsWith("@g.us")) return;
        if (args.length < 1) {
          await sock.sendMessage(from, { text: "Taguez l'âme à purifier jeûne maître." });
          return;
        }
        let jidToKick = args[0];
        if (!jidToKick.includes("@")) jidToKick = jidToKick + "@s.whatsapp.net";
        await kickMember(from, jidToKick);
        break;

      case "antibot":
        if (!from.endsWith("@g.us")) return;
        if (args.length < 1) {
          await sock.sendMessage(from, { text: "Usage: 😈antibot warn|delete|kick" });
          return;
        }
        await handleAntiBot(msg, args[0].toLowerCase());
        break;

      default:
        await sock.sendMessage(from, { text: "Unknown command." });
    }
  });
}

startBot().catch(console.error);

