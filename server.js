import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import fs from "fs";
import QRCode from "qrcode";
import generatePayload from "promptpay-qr";
import multer from "multer";
import http from "http";
import path from "path";
import axios from "axios";

const app = express();
const server = http.createServer(app);

// =========================
// 🔥 BASIC SETUP
// =========================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.static(process.cwd()));
app.use(express.json());
console.log("🟡 SERVER BOOTING...");
console.log("🔧 Initializing donation system...");
console.log("📡 Waiting for Tasker / Bankhook connection...");
console.log("⚡ WebSocket server preparing...");

// =========================
// 🧠 FILE STORAGE
// =========================
const donateFile = path.join(process.cwd(), "public", "donates.json");

if (!fs.existsSync(donateFile)) {
  fs.writeFileSync(donateFile, "[]");
}

// =========================
// 📁 UPLOAD SYSTEM
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

app.post("/upload-popup", upload.single("popupImage"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false });

  res.json({
    path: "/uploads/" + req.file.filename
  });
});

app.post("/test-alert", (req, res) => {
  const data = req.body;

  push({
    type: "test_alert",
    name: data.name,
    amount: data.amount,
    comment: data.comment || ""
  });

  res.json({ ok: true });
});


// =========================
// 🌐 WEBSOCKET
// =========================
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  console.log("🟢 OBS CONNECTED");
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);




wss.on("connection", (ws) => {
  console.log("🟢 CLIENT CONNECTED");

  ws.on("close", () => {
    console.log("🔴 CLIENT DISCONNECTED");
  });

  ws.on("error", (err) => {
    console.log("⚠️ WS ERROR:", err);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// =========================
// 🔥 QUEUE SYSTEM
// =========================
let queue = [];
let running = false;

function next() {
  if (!queue.length) {
    running = false;
    return;
  }

  running = true;
  const item = queue.shift();
console.log("📤 Sending alert to OBS queue...");
console.log("📦 Payload:", item);
  broadcast(item);

  setTimeout(next, 5000);
}

function push(item) {
  queue.push(item);
  if (!running) next();
}

// =========================
// 🧠 PENDING QR
// =========================
let pending = [];

// =========================
// 🔥 ANTI DUPLICATE
// =========================
let lastTrigger = "";
let processing = false;

// =========================
// 🧼 CLEAN TEXT (สำคัญ)
// =========================
function cleanText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s\u0E00-\u0E7F]/gu, "")
    .trim();
}

// =========================
// 🔥 FIX NAME READING
// =========================
function improveTTS(text) {
  return text
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

// =========================
// 🌐 DETECT LANGUAGE
// =========================
function detectLang(text) {
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);

  if (hasThai && hasEnglish) return "mixed";
  if (hasEnglish) return "en";
  return "th";
}

// =========================
// 📌 GENERATE QR
// =========================
app.post("/generateQR", (req, res) => {
  const { amount, name, comment } = req.body;

  if (!amount) return res.status(400).json({ ok: false });

  const id = "QR_" + Date.now();

  console.log("🧾 QR GENERATED");
console.log("🆔 QR ID:", id);
console.log("💳 Amount:", amount);
console.log("👤 Name:", name);
console.log("⏳ Waiting for bank match...");

  const payload = generatePayload("0815404297", {
    amount: Number(amount)
  });

  QRCode.toDataURL(payload, (err, url) => {
    if (err) return res.status(500).json({ ok: false });

    pending.push({
      id,
      name: name || "unknown",
      amount: Number(amount),
      comment: comment || "",
      time: Date.now()
    });

    res.json({ id, result: url });
  });
});

// =========================
// 🔁 REPLAY SPECIFIC DONATION
// =========================
app.post("/replay", (req, res) => {
  const data = req.body;

  if (!data) return res.json({ ok: false });

  const payload = {
    type: "replay_alert",
    name: data.name,
    amount: data.amount,
    comment: data.comment || ""
  };

  // ส่งเข้า OBS / alert ใหม่
  push(payload);

  res.json({ ok: true });
});

// =========================
// 🔥 BANKHOOK
// =========================
app.post("/bankhook", (req, res) => {
  const text = req.body.text || "";

  console.log("💰 BANKHOOK RECEIVED");
  console.log("📨 Raw text:", text);

  const match = text.match(/([\d,]+(?:\.\d+)?)\s*บาท/);
  const amount = match ? Number(match[1].replace(/,/g, "")) : 0;

  console.log("🔍 Extracted amount:", amount);

  if (!amount) return res.json({ ok: false });

  const now = Date.now();

  const found = pending.find(p =>
    Math.abs(p.amount - amount) < 0.2 &&
    now - p.time < 300000
  );

console.log("🎯 QR MATCH FOUND!");
console.log("🆔 Matched ID:", found.id);
console.log("💵 Amount:", amount);

  if (!found) return res.json({ ok: true });



  const key = found.id + amount;

  if (lastTrigger === key) return res.json({ ok: true });
  lastTrigger = key;

  if (processing) return res.json({ ok: true });
  processing = true;

  import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://donateamr-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

  push({
    type: "donate",
    name: found.name,
    amount,
    comment: found.comment || ""
  });

  pending = pending.filter(p => p.id !== found.id);

  setTimeout(() => {
    processing = false;
  }, 1500);

  res.json({ ok: true });
});

// =========================
// 🧪 TEST
// =========================
app.get("/test", (req, res) => {
  broadcast({
   type: "test_alert",
    name: "TEST USER",
    amount: 99,
    comment: "test system"
  });

  res.send("OK TEST SENT");
});

// =========================
// 🌐 ROUTES
// =========================
app.get("/", (_, res) =>
  res.sendFile("index.html", { root: "public" })
);

app.get("/alert", (_, res) =>
  res.sendFile("alert.html", { root: "public" })
);

// =========================
// 🔊 GOOGLE TTS (FIXED FULL)
// =========================
app.get("/tts", async (req, res) => {
  const raw = req.query.text || "";
  if (!raw) return res.status(400).send("no text");

  const text = improveTTS(cleanText(raw));
  const lang = detectLang(text);

  let voice = lang === "en"
    ? { languageCode: "en-US", name: "en-US-Standard-C" }
    : { languageCode: "th-TH", name: "th-TH-Standard-A" };

  try {
    const response = await axios.post(
      "https://texttospeech.googleapis.com/v1/text:synthesize?key=AIzaSyAmNqC1tQpmAZAlmIQPFHv6h8-_CT__p0o",
      {
        input: { text },
        voice,
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 0.95,
          pitch: 0
        }
      }
    );

    const audio = Buffer.from(response.data.audioContent, "base64");

    res.set({ "Content-Type": "audio/mpeg" });
    res.send(audio);

  } catch (err) {
    console.log(err.response?.data || err);
    res.status(500).send("tts error");
  }
});


app.post("/sendMessage", (req, res) => {
  const { name, msg, userId } = req.body;
  const file = "messages.json";

  let data = [];

  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file));
  }

  data.push({
    id: Date.now(), // 🔥 สำคัญ (ใช้ตอบกลับ)
    name,
    msg,
    userId,
    reply: ""
  });

  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  res.json({ success: true });
});

app.post("/reply", (req, res) => {
  const { id, reply } = req.body;
  const file = "messages.json";

  let data = JSON.parse(fs.readFileSync(file));

data = data.map(m => {
  if (m.id === Number(id)) {
    m.reply = reply;
  }
  return m;
});

  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  res.json({ success: true });
});

app.get("/messages", (req, res) => {
  const file = "messages.json";
  if (!fs.existsSync(file)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(file));
  res.json(data);
});

app.get("/ping", (req, res) => {
  res.send("ok");
});



// =========================
// 🚀 START SERVER
// =========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING ON PORT:", PORT);
});