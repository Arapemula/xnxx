// src/server.js
require("dotenv").config();

// --- HACK: Hide annoying logs from dependencies ---
const originalConsoleLog = console.log;
console.log = (...args) => {
  if (args.length > 0 && typeof args[0] === "string") {
    if (args[0].includes("Closing session: SessionEntry")) return;
    if (args[0] === "Closing session:" && args.length > 1) return;
  }
  originalConsoleLog.apply(console, args);
};
// --------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const axios = require("axios");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const cors = require("cors");
const { jidNormalizedUser } = require("@whiskeysockets/baileys");

// --- IMPORT ROUTER AUTH (LOGIN/REGISTER) ---
const authRoutes = require("./auth");

// IMPORT DARI ENGINE
const {
  sessions,
  sessionAIStore,
  productStore,
  crmStore,
  createSession,
  initActiveSessions,
  getSessionStats,
  formatPhone,
  formatPrettyId,
  prisma,
  mediaPath,
  recordSale,
  saveCRM,
  globalContactStore,
  lidToPhoneMap,
  processedMessages,
  autoReplyStore,
  loadAutoReplies,
} = require("./wa_engine");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// --- MULTER CONFIG (Preserve Extension) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});
const upload = multer({ storage: storage });

// --- INVOICE STORE ---
const invoicesPath = path.join(__dirname, "../invoices.json");
let invoicesStore = {};
if (fs.existsSync(invoicesPath)) {
  try {
    invoicesStore = JSON.parse(fs.readFileSync(invoicesPath, "utf8"));
  } catch (e) {
    console.error("Failed to load invoices.json", e);
  }
}
function saveInvoices() {
  fs.writeFileSync(invoicesPath, JSON.stringify(invoicesStore, null, 2));
}

// --- MIDDLEWARES ---
app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Uploads (for Invoice Logos etc)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Serve file statis (HTML, JS Frontend)
app.use(
  express.static(path.join(__dirname, "../public"), {
    setHeaders: (res, path, stat) => {
      // Disable cache for development
      res.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );
    },
  })
);

// --- MOUNTING ROUTE AUTH ---
// Semua request ke /auth/... akan ditangani oleh auth.js
app.use("/auth", authRoutes);

// --- SOCKET IO ---
io.on("connection", (socket) => {
  socket.on("join_session", (sessionId) => {
    socket.join(sessionId);
    if (!sessionAIStore[sessionId]) {
      sessionAIStore[sessionId] = {
        isActive: false,
        hasFile: false,
        systemPrompt: "",
        inventoryFile: null,
        knowledgeFiles: [], // Array of { filename, content }
        knowledgeContext: "",
      };
    }
    socket.emit("ai_status", sessionAIStore[sessionId]);
  });
});

// --- API SESSION ---
app.get("/session/status/:sessionId", (req, res) => {
  const s = sessions.get(req.params.sessionId);
  res.json({ status: s ? s.status : "not_found", qr: s ? s.qr : null });
});

app.post("/session/start", async (req, res) => {
  await createSession(req.body.sessionId, io, req.body.webhookUrl, res);
});

app.delete("/session/stop", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  try {
    await session.sock.logout();
    sessions.delete(sessionId);
    await prisma.session.deleteMany({ where: { sessionId } });
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/top-customers/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { month } = req.query; // Get month from query

  try {
    const cleanSessionId = sessionId.trim();

    let dateFilter = {};
    if (month) {
      const [year, monthNum] = month.split("-").map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);
      dateFilter = {
        date: {
          gte: startDate,
          lte: endDate,
        },
      };
    }

    const topCustomers = await prisma.sale.groupBy({
      by: ["customerJid", "customerName"],
      where: {
        sessionId: cleanSessionId,
        customerJid: { not: null },
        ...dateFilter,
      },
      _sum: {
        qty: true,
      },
    });

    // --- FIX: Try to find phone number for LID users ---

    // Helper to check if JID is likely a LID (or at least not a phone)
    const isLidOrRaw = (jid) => !jid.includes("@s.whatsapp.net");

    // 1. Self-learn from topCustomers (if same name exists with phone)
    let nameToPhoneMap = {};
    topCustomers.forEach((c) => {
      if (c.customerName && !isLidOrRaw(c.customerJid)) {
        nameToPhoneMap[c.customerName] = c.customerJid;
      }
    });

    // 2. Identify names that need lookup (LID only)
    const names = topCustomers
      .filter(
        (c) =>
          isLidOrRaw(c.customerJid) &&
          c.customerName &&
          !nameToPhoneMap[c.customerName]
      )
      .map((c) => c.customerName);

    // Helper to find phone in globalContactStore
    const findPhoneInStore = (name) => {
      for (const [jid, contactName] of Object.entries(globalContactStore)) {
        if (jid.endsWith("@s.whatsapp.net") && contactName === name) {
          return jid;
        }
      }
      return null;
    };

    if (names.length > 0) {
      // A. Check DB
      const phoneChats = await prisma.chat.findMany({
        where: {
          sessionId: cleanSessionId,
          name: { in: names },
          remoteJid: { endsWith: "@s.whatsapp.net" },
        },
        select: { name: true, remoteJid: true },
      });
      phoneChats.forEach((c) => {
        if (c.name) nameToPhoneMap[c.name] = c.remoteJid;
      });

      // B. Check Global Store (Memory) if not found in DB
      names.forEach((name) => {
        if (!nameToPhoneMap[name]) {
          const found = findPhoneInStore(name);
          if (found) nameToPhoneMap[name] = found;
        }
      });
    }

    // --- C. Check Baileys Store for LID mapping ---
    const getPhoneFromLID = (lid) => {
      if (lidToPhoneMap[lid]) return lidToPhoneMap[lid];
      // Try appending @lid if missing
      if (!lid.includes("@") && lidToPhoneMap[lid + "@lid"])
        return lidToPhoneMap[lid + "@lid"];
      return null;
    };

    // --- MERGE DUPLICATES (LID & PHONE) ---
    const mergedCustomers = {};

    topCustomers.forEach((c) => {
      let displayJid = c.customerJid;

      // 1. Try Name Map
      if (
        isLidOrRaw(c.customerJid) &&
        c.customerName &&
        nameToPhoneMap[c.customerName]
      ) {
        displayJid = nameToPhoneMap[c.customerName];
      }

      // 2. Try LID Map
      if (isLidOrRaw(displayJid)) {
        const phoneJid = getPhoneFromLID(displayJid);
        if (phoneJid) displayJid = phoneJid;
      }

      // Normalize JID (Remove suffix)
      const cleanJid = displayJid
        .replace("@s.whatsapp.net", "")
        .replace("@lid", "");

      if (!mergedCustomers[cleanJid]) {
        mergedCustomers[cleanJid] = {
          customerJid: cleanJid,
          customerName: c.customerName || cleanJid,
          totalQty: 0,
        };
      }

      mergedCustomers[cleanJid].totalQty += c._sum.qty || 0;

      // Update name if we have a better one (e.g. if previous was ID)
      if (
        mergedCustomers[cleanJid].customerName === cleanJid &&
        c.customerName
      ) {
        mergedCustomers[cleanJid].customerName = c.customerName;
      }
    });

    const result = Object.values(mergedCustomers)
      .sort((a, b) => b.totalQty - a.totalQty)
      .slice(0, 10);

    res.json(result);
  } catch (e) {
    console.error("Error fetching top customers:", e);
    res.status(500).json({ error: "Failed to fetch top customers" });
  }
});

// --- API CHAT ---
app.post("/chat/send", async (req, res) => {
  const { sessionId, to, text } = req.body;
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected")
    return res.status(400).json({ error: "Session not ready" });
  try {
    const stats = getSessionStats(sessionId);
    stats.outgoing++;
    stats.logs.unshift({
      time: new Date(),
      type: "OUT",
      msg: "Manual Send",
      user: formatPrettyId(to),
    });
    const jid = formatPhone(to);
    const sentMsg = await session.sock.sendMessage(jid, { text });

    // Mark as processed to avoid duplicate from upsert
    if (sentMsg?.key?.id) processedMessages.add(sentMsg.key.id);

    // --- SAVE OUTGOING MESSAGE ---
    try {
      const chatId = jidNormalizedUser(jid);
      let chat = await prisma.chat.findUnique({
        where: { sessionId_remoteJid: { sessionId, remoteJid: chatId } },
      });
      if (!chat) {
        chat = await prisma.chat.create({
          data: { sessionId, remoteJid: chatId, name: "Unknown" },
        });
      }
      const dbMsg = await prisma.message.create({
        data: {
          chatId: chat.id,
          keyId: sentMsg.key.id,
          fromMe: true,
          text: text,
          createdAt: new Date(),
        },
      });

      // Emit Message Event (Manual)
      const payload = {
        id: dbMsg.id,
        keyId: sentMsg.key.id,
        from: chatId,
        participant: chatId,
        chatName: chat.name || "Unknown",
        senderName: "Me",
        chatProfilePicUrl: chat.profilePicUrl,
        senderProfilePicUrl: null,
        text: text,
        mediaUrl: null,
        mediaType: null,
        fromMe: true,
        isGroup: chatId.endsWith("@g.us"),
        timestamp: new Date(),
      };
      io.to(sessionId).emit("message", payload);
    } catch (e) {
      console.error("Error saving outgoing message:", e);
    }
    // ----------------------------

    // Emit Realtime Update
    io.to(sessionId).emit("stats_update", stats);

    res.json({ status: "success", data: { to: jid } });
  } catch (e) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/chat/send-media", upload.single("file"), async (req, res) => {
  const { sessionId, to, caption } = req.body;
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected")
    return res.status(400).json({ error: "Session not ready" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const jid = formatPhone(to);
    const fileName = `${Date.now()}_${req.file.originalname.replace(
      /\s+/g,
      "_"
    )}`;
    const savePath = path.join(mediaPath, fileName);
    fs.copyFileSync(req.file.path, savePath);
    const buffer = fs.readFileSync(savePath);
    const mime = req.file.mimetype;

    let sentMsg;
    if (mime.startsWith("image/"))
      sentMsg = await session.sock.sendMessage(jid, {
        image: buffer,
        caption: caption || "",
      });
    else if (mime.startsWith("video/"))
      sentMsg = await session.sock.sendMessage(jid, {
        video: buffer,
        caption: caption || "",
      });
    else
      sentMsg = await session.sock.sendMessage(jid, {
        document: buffer,
        mimetype: mime,
        fileName: req.file.originalname,
        caption: caption || "",
      });

    // Mark as processed to avoid duplicate from upsert
    if (sentMsg?.key?.id) processedMessages.add(sentMsg.key.id);

    // --- SAVE OUTGOING MEDIA MESSAGE ---
    try {
      const chatId = jidNormalizedUser(jid);
      let chat = await prisma.chat.findUnique({
        where: { sessionId_remoteJid: { sessionId, remoteJid: chatId } },
      });
      if (!chat) {
        chat = await prisma.chat.create({
          data: { sessionId, remoteJid: chatId, name: "Unknown" },
        });
      }
      const dbMsg = await prisma.message.create({
        data: {
          chatId: chat.id,
          keyId: sentMsg.key.id,
          fromMe: true,
          text: caption || "",
          mediaUrl: `/media/${fileName}`,
          createdAt: new Date(),
        },
      });

      // Emit Message Event (Manual)
      const payload = {
        id: dbMsg.id,
        keyId: sentMsg.key.id,
        from: chatId,
        participant: chatId,
        chatName: chat.name || "Unknown",
        senderName: "Me",
        chatProfilePicUrl: chat.profilePicUrl,
        senderProfilePicUrl: null,
        text: caption || "",
        mediaUrl: `/media/${fileName}`,
        mediaType: mime.split("/")[0],
        fromMe: true,
        isGroup: chatId.endsWith("@g.us"),
        timestamp: new Date(),
      };
      io.to(sessionId).emit("message", payload);
    } catch (e) {
      console.error("Error saving outgoing media message:", e);
    }

    const stats = getSessionStats(sessionId);
    stats.outgoing++;
    stats.mediaCount++;
    stats.logs.unshift({
      time: new Date(),
      type: "OUT",
      msg: `Media Sent`,
      user: formatPrettyId(to),
    });

    fs.unlinkSync(req.file.path);

    // Emit Realtime Update
    io.to(sessionId).emit("stats_update", stats);

    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ error: "Failed" });
  }
});

// --- API INVOICE REMINDER ---
app.post("/chat/send-invoice-reminder", async (req, res) => {
  const { sessionId, invoiceId } = req.body;
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected")
    return res.status(400).json({ error: "Session not ready" });

  const list = invoicesStore[sessionId] || [];
  const inv = list.find((i) => i.id === invoiceId);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });

  try {
    const jid = formatPhone(inv.to);
    const total = Number(inv.total).toLocaleString("id-ID");
    const msg = `Halo Kak ${inv.customerName}, sekedar mengingatkan invoice *${
      inv.invoiceNote || inv.id
    }* sebesar *Rp ${total}* belum lunas ya. Mohon segera diproses. Terima kasih 🙏`;

    await session.sock.sendMessage(jid, { text: msg });
    res.json({ status: "success" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to send reminder" });
  }
});

// --- API TEMPLATES ---
app.post("/templates/save", (req, res) => {
  const { sessionId, templates } = req.body;
  if (!sessionAIStore[sessionId]) sessionAIStore[sessionId] = {};
  sessionAIStore[sessionId].templates = templates;
  res.json({ status: "success" });
});

app.get("/templates/list/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const templates = sessionAIStore[sessionId]?.templates || [];
  res.json({ status: "success", data: templates });
  res.json({ status: "success", data: templates });
});

// --- API AUTO REPLIES ---
app.get("/auto-replies/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const replies = await prisma.autoReply.findMany({ where: { sessionId } });
    res.json({ status: "success", data: replies });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch" });
  }
});

app.post("/auto-replies", async (req, res) => {
  const { sessionId, keyword, response } = req.body;
  if (!sessionId || !keyword || !response)
    return res.status(400).json({ error: "Missing fields" });
  try {
    await prisma.autoReply.upsert({
      where: {
        sessionId_keyword: { sessionId, keyword },
      },
      update: { response },
      create: { sessionId, keyword, response },
    });
    // Refresh Cache
    await loadAutoReplies(sessionId);
    res.json({ status: "success" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save" });
  }
});

app.delete("/auto-replies/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await prisma.autoReply.delete({
      where: { id: parseInt(id) },
    });
    // Refresh Cache
    await loadAutoReplies(deleted.sessionId);
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

// --- API INVOICE ---
app.get("/invoice/list/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const list = invoicesStore[sessionId] || [];
  // Return UNPAID invoices
  const unpaid = list.filter((inv) => inv.status === "UNPAID");
  res.json({ status: "success", data: unpaid });
});

app.post("/chat/send-invoice-pdf", async (req, res) => {
  const { sessionId, to, invoiceData, invoiceId, action } = req.body;
  const session = sessions.get(sessionId);
  if (!session || session.status !== "connected")
    return res.status(400).json({ error: "Session not ready" });

  try {
    // Handle Invoice Storage
    if (!invoicesStore[sessionId]) invoicesStore[sessionId] = [];

    let finalInvoiceData = invoiceData;

    if (invoiceId) {
      // Existing Invoice
      const found = invoicesStore[sessionId].find(
        (inv) => inv.id === invoiceId
      );
      if (found) {
        finalInvoiceData = found;
        // If action is pay, update status
        if (action === "pay") {
          finalInvoiceData.status = "PAID";
          finalInvoiceData.isPaid = true;
          saveInvoices();
        }
      }
    } else {
      // New Invoice - Save it
      finalInvoiceData.id = "INV-" + Date.now();
      finalInvoiceData.status = "UNPAID";
      finalInvoiceData.to = to;
      finalInvoiceData.date = new Date().toISOString();
      // Ensure isPaid is false for new invoices
      finalInvoiceData.isPaid = false;
      invoicesStore[sessionId].push(finalInvoiceData);
      saveInvoices();
    }

    // Get Invoice Settings
    const aiSession = sessionAIStore[sessionId];
    const invSettings = aiSession?.invoiceSettings || {
      title: "INVOICE",
      address: "",
      footer: "",
      logo: null,
    };

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    let buffers = [];
    doc.on("data", buffers.push.bind(buffers));

    // --- HEADER ---
    // Logo
    if (invSettings.logo) {
      const logoPath = path.join(__dirname, "../uploads", invSettings.logo);
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 60 });
      }
    }

    // Title (Right Aligned)
    doc.fontSize(20).text(invSettings.title || "INVOICE", { align: "right" });

    // Status (Paid/Unpaid)
    doc
      .fontSize(10)
      .fillColor(finalInvoiceData.isPaid ? "green" : "red")
      .text(finalInvoiceData.isPaid ? "PAID" : "UNPAID", { align: "right" });

    // Address (Left Aligned, below logo)
    doc.fillColor("black");
    if (invSettings.address) {
      doc.fontSize(10).text(invSettings.address, 50, 110, { width: 250 });
    }

    // Invoice Details (Right Aligned)
    doc.text(
      `No: ${finalInvoiceData.invoiceNote || finalInvoiceData.id}`,
      300,
      110,
      { align: "right" }
    );
    doc.text(
      `Date: ${new Date(finalInvoiceData.date).toLocaleDateString("id-ID")}`,
      300,
      125,
      {
        align: "right",
      }
    );

    // Customer Info
    doc.text(`Bill To:`, 50, 180);
    doc.font("Helvetica-Bold").text(finalInvoiceData.customerName, 50, 195);

    // Table
    let y = 240;
    doc.font("Helvetica-Bold");
    doc.text("Item", 50, y);
    doc.text("Qty", 300, y, { align: "right", width: 40 });
    doc.text("Price", 350, y, { align: "right", width: 90 });
    doc.text("Total", 450, y, { align: "right", width: 100 });

    doc
      .moveTo(50, y + 15)
      .lineTo(550, y + 15)
      .stroke();

    doc.font("Helvetica");
    y += 25;

    finalInvoiceData.cart.forEach((item) => {
      const price = Number(item.price) || 0;
      const qty = Number(item.qty) || 1;
      const subtotal = Number(item.subtotal) || 0;

      doc.text(item.name, 50, y, { width: 240 });
      doc.text(qty.toString(), 300, y, { align: "right", width: 40 });
      doc.text(price.toLocaleString("id-ID"), 350, y, {
        align: "right",
        width: 90,
      });
      doc.text(subtotal.toLocaleString("id-ID"), 450, y, {
        align: "right",
        width: 100,
      });
      y += 20;
    });

    doc
      .moveTo(50, y + 10)
      .lineTo(550, y + 10)
      .stroke();

    let finalTotal = Number(finalInvoiceData.total) || 0;
    let summaryY = y + 20;

    // Shipping Cost
    if (finalInvoiceData.shipping && finalInvoiceData.shipping.cost > 0) {
      doc
        .font("Helvetica")
        .text(`Subtotal:`, 350, summaryY, { align: "right", width: 90 });
      doc.text(finalTotal.toLocaleString("id-ID"), 450, summaryY, {
        align: "right",
        width: 100,
      });
      summaryY += 15;

      doc.text(`Ongkir (${finalInvoiceData.shipping.label}):`, 300, summaryY, {
        align: "right",
        width: 140,
      });
      doc.text(
        Number(finalInvoiceData.shipping.cost).toLocaleString("id-ID"),
        450,
        summaryY,
        { align: "right", width: 100 }
      );
      summaryY += 15;

      // Note: finalTotal in invoiceData usually already includes shipping if calculated on frontend?
      // Let's check frontend logic.
      // Frontend: total: this.cartTotal. cartTotal includes shipping.
      // So finalInvoiceData.total ALREADY includes shipping.
      // But the PDF logic I wrote previously:
      // finalTotal += Number(invoiceData.shipping.cost);
      // This might be double counting if I'm not careful.

      // Let's check the previous code I replaced.
      // Previous code:
      // let finalTotal = Number(invoiceData.total) || 0;
      // ...
      // finalTotal += Number(invoiceData.shipping.cost);

      // Wait, if frontend sends total WITH shipping, then I shouldn't add it again.
      // Frontend: total: this.cartTotal
      // cartTotal: subtotal + shipping.

      // So `invoiceData.total` IS the Grand Total.
      // The PDF logic should be:
      // Subtotal = Total - Shipping
      // Ongkir = Shipping
      // Total = Total

      // BUT, the previous code I wrote (or saw) was adding it.
      // "finalTotal += Number(invoiceData.shipping.cost);"
      // This implies `invoiceData.total` was treated as Subtotal?

      // Let's check frontend `cartTotal` again.
      // get cartTotal() { return subtotal + shipping }
      // So `invoiceData.total` is Grand Total.

      // So in PDF:
      // Subtotal should be `finalTotal - shipping.cost`.

      // I will fix this logic in the new code.

      const shippingCost = Number(finalInvoiceData.shipping.cost);
      const subtotalVal = finalTotal - shippingCost;

      // Overwrite the previous logic to be correct
      doc
        .font("Helvetica")
        .text(`Subtotal:`, 350, summaryY, { align: "right", width: 90 });
      doc.text(subtotalVal.toLocaleString("id-ID"), 450, summaryY, {
        align: "right",
        width: 100,
      });
      summaryY += 15;

      doc.text(`Ongkir (${finalInvoiceData.shipping.label}):`, 300, summaryY, {
        align: "right",
        width: 140,
      });
      doc.text(shippingCost.toLocaleString("id-ID"), 450, summaryY, {
        align: "right",
        width: 100,
      });
      summaryY += 15;

      // finalTotal is already correct
    }

    doc
      .font("Helvetica-Bold")
      .text(`Total: Rp ${finalTotal.toLocaleString("id-ID")}`, 350, summaryY, {
        align: "right",
        width: 200,
      });

    // Stamp LUNAS
    if (finalInvoiceData.isPaid) {
      const stampY = summaryY - 10;
      doc.save();
      doc.rotate(-15, { origin: [450, stampY] });
      doc
        .rect(400, stampY, 120, 40)
        .lineWidth(2)
        .strokeColor("#22c55e")
        .stroke();
      doc
        .fontSize(25)
        .fillColor("#22c55e")
        .text("LUNAS", 400, stampY + 8, { width: 120, align: "center" });
      doc.restore();
    }

    // Footer
    if (invSettings.footer) {
      doc.fontSize(9).text(invSettings.footer, 50, 700, {
        align: "center",
        width: 500,
        color: "gray",
      });
    }

    doc.end();

    doc.on("end", async () => {
      try {
        const pdfBuffer = Buffer.concat(buffers);
        const jid = formatPhone(to);
        const fileName = `INV-${Date.now()}.pdf`;
        await session.sock.sendMessage(jid, {
          document: pdfBuffer,
          mimetype: "application/pdf",
          fileName,
          caption: `Invoice untuk ${finalInvoiceData.customerName}`,
        });

        // --- SAVE INVOICE MESSAGE TO DB ---
        try {
          const chatId = jidNormalizedUser(jid);
          let chat = await prisma.chat.findUnique({
            where: { sessionId_remoteJid: { sessionId, remoteJid: chatId } },
          });
          if (!chat) {
            chat = await prisma.chat.create({
              data: {
                sessionId,
                remoteJid: chatId,
                name: finalInvoiceData.customerName || "Unknown",
              },
            });
          }
          // ... (rest of saving logic) ...

          await prisma.message.create({
            data: {
              chatId: chat.id,
              fromMe: true,
              text: `[INVOICE] Invoice untuk ${invoiceData.customerName}`, // Marker for query
              createdAt: new Date(),
            },
          });
        } catch (e) {
          console.error("Error saving invoice message:", e);
        }
        // ----------------------------------

        const stats = getSessionStats(sessionId);
        stats.outgoing++;
        stats.invoiceIssued++;
        if (invoiceData.isPaid) stats.invoicePaid++;
        stats.logs.unshift({
          time: new Date(),
          type: "INV",
          msg: invoiceData.isPaid ? "Lunas" : "Tagihan",
          user: formatPrettyId(to),
        });

        // Emit Realtime Update
        io.to(sessionId).emit("stats_update", stats);

        // Record Sale (Hanya jika status LUNAS)
        console.log(
          `[INVOICE] isPaid status: ${
            invoiceData.isPaid
          } (${typeof invoiceData.isPaid})`
        );
        if (invoiceData.isPaid === true || invoiceData.isPaid === "true") {
          console.log(`[SALE] Recording sale for session ${sessionId}`);
          const customerJid = jidNormalizedUser(jid);
          await recordSale(
            sessionId,
            invoiceData.cart,
            customerJid,
            invoiceData.customerName
          );
        } else {
          console.log(`[SALE] Skipped recording (Not Paid)`);
        }

        console.log("Invoice processing complete. Sending response.");
        if (!res.headersSent) res.json({ status: "success" });
      } catch (err) {
        console.error("Error in PDF generation/sending:", err);
        if (!res.headersSent)
          res.status(500).json({ error: "Failed to process invoice" });
      }
    });
  } catch (e) {
    console.error("Error generating invoice:", e);
    res.status(500).json({ error: "Error PDF" });
  }
});

// --- API LAINNYA ---
app.get("/api/crm/:sessionId", async (req, res) => {
  try {
    const chats = await prisma.chat.findMany({
      where: { sessionId: req.params.sessionId },
    });
    const data = {};
    chats.forEach((c) => {
      data[c.remoteJid] = { label: c.label || "General", note: c.note || "" };
    });
    res.json({ status: "success", data });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch CRM" });
  }
});

app.post("/api/crm/update", async (req, res) => {
  const { sessionId, jid, label, note } = req.body;
  try {
    // Update DB
    await prisma.chat.upsert({
      where: { sessionId_remoteJid: { sessionId, remoteJid: jid } },
      update: { label, note },
      create: {
        sessionId,
        remoteJid: jid,
        label: label || "General",
        note: note || "",
        name: "Unknown",
      },
    });

    // Update Memory (Optional, but good for consistency if used elsewhere)
    if (!crmStore[sessionId]) crmStore[sessionId] = {};
    crmStore[sessionId][jid] = { label: label || "General", note: note || "" };

    res.json({ status: "success" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update CRM" });
  }
});

app.post("/chat/broadcast", async (req, res) => {
  const { sessionId, targetLabel, message, manualNumbers } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Session not ready" });

  try {
    let targets = [];

    if (targetLabel === "manual") {
      const numbers = manualNumbers
        .split(/[\n,]+/)
        .map((n) => n.trim())
        .filter((n) => n);
      targets = numbers.map((n) => ({ remoteJid: formatPhone(n) }));
    } else {
      const whereClause = {
        sessionId,
        OR: [
          { remoteJid: { endsWith: "@s.whatsapp.net" } },
          { remoteJid: { endsWith: "@lid" } },
        ],
      };
      if (targetLabel !== "all") {
        whereClause.label = targetLabel;
      }

      targets = await prisma.chat.findMany({
        where: whereClause,
        select: { remoteJid: true },
      });
    }

    (async () => {
      for (const t of targets) {
        await new Promise((r) => setTimeout(r, 3000)); // Delay 3s
        try {
          await session.sock.sendMessage(t.remoteJid, { text: message });

          // --- SAVE OUTGOING MESSAGE ---
          try {
            const chatId = jidNormalizedUser(t.remoteJid);
            let chat = await prisma.chat.findUnique({
              where: { sessionId_remoteJid: { sessionId, remoteJid: chatId } },
            });
            if (!chat) {
              chat = await prisma.chat.create({
                data: { sessionId, remoteJid: chatId, name: "Unknown" },
              });
            }
            await prisma.message.create({
              data: {
                chatId: chat.id,
                fromMe: true,
                text: message,
                createdAt: new Date(),
              },
            });
          } catch (saveErr) {
            console.error("Error saving broadcast message:", saveErr);
          }
          // ----------------------------
        } catch (e) {
          console.error(`Failed to send to ${t.remoteJid}`);
        }
      }
    })();

    res.json({
      status: "success",
      count: targets.length,
      message: `Broadcast dimulai ke ${targets.length} kontak!`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Broadcast failed" });
  }
});
app.get("/api/analytics/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { month } = req.query;

  if (month) {
    try {
      const [year, monthNum] = month.split("-").map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

      const incoming = await prisma.message.count({
        where: {
          chat: { sessionId },
          fromMe: false,
          createdAt: { gte: startDate, lte: endDate },
        },
      });

      const outgoing = await prisma.message.count({
        where: {
          chat: { sessionId },
          fromMe: true,
          createdAt: { gte: startDate, lte: endDate },
        },
      });

      // Count sales (items)
      const salesCount = await prisma.sale.count({
        where: {
          sessionId,
          date: { gte: startDate, lte: endDate },
        },
      });

      // Count Issued Invoices (based on marker)
      const invoiceIssuedCount = await prisma.message.count({
        where: {
          chat: { sessionId },
          fromMe: true,
          text: { contains: "[INVOICE]" },
          createdAt: { gte: startDate, lte: endDate },
        },
      });

      // Count New Customers (Chats created in this period)
      const newCustomers = await prisma.chat.count({
        where: {
          sessionId,
          createdAt: { gte: startDate, lte: endDate },
        },
      });

      // --- FETCH LOGS FROM DB (Reconstruct History) ---
      const dbMessages = await prisma.message.findMany({
        where: {
          chat: { sessionId },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: { chat: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      const dbSales = await prisma.sale.findMany({
        where: {
          sessionId,
          date: { gte: startDate, lte: endDate },
        },
        orderBy: { date: "desc" },
        take: 20,
      });

      const historicalLogs = [];

      // Map Messages to Logs
      dbMessages.forEach((m) => {
        let type = m.fromMe ? "OUT" : "IN";
        if (m.text && m.text.includes("[INVOICE]")) type = "INV";

        historicalLogs.push({
          time: m.createdAt,
          type: type,
          msg: m.text
            ? m.text.length > 30
              ? m.text.substring(0, 30) + "..."
              : m.text
            : "Media/Other",
          user: m.chat.name || formatPrettyId(m.chat.remoteJid),
        });
      });

      // Map Sales to Logs
      dbSales.forEach((s) => {
        historicalLogs.push({
          time: s.date,
          type: "INV",
          msg: `Lunas: ${s.itemName} (${s.qty})`,
          user: "System",
        });
      });

      // Sort & Slice
      historicalLogs.sort((a, b) => new Date(b.time) - new Date(a.time));
      const finalLogs = historicalLogs.slice(0, 50);

      // --- NEW: Hourly Activity & Top Questions ---
      // 1. Hourly Activity (Incoming Messages)
      const hourlyMessages = await prisma.message.findMany({
        where: {
          chat: { sessionId },
          fromMe: false,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { createdAt: true },
      });

      const hourlyCounts = new Array(24).fill(0);
      hourlyMessages.forEach((msg) => {
        const hour = new Date(msg.createdAt).getHours();
        hourlyCounts[hour]++;
      });

      // 2. Top Questions (Incoming Messages)
      // Note: GroupBy on LongText might fail or be slow. We fetch recent messages and process in JS.
      const recentIncoming = await prisma.message.findMany({
        where: {
          chat: { sessionId },
          fromMe: false,
          text: { not: null },
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { text: true },
        take: 1000, // Limit sample size for performance
      });

      const questionMap = {};
      recentIncoming.forEach((msg) => {
        if (!msg.text) return;
        const text = msg.text.trim();
        if (text.length < 4) return; // Ignore short texts
        if (questionMap[text]) questionMap[text]++;
        else questionMap[text] = 1;
      });

      const topQuestions = Object.keys(questionMap)
        .map((key) => ({ question: key, count: questionMap[key] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      res.json({
        status: "success",
        data: {
          incoming,
          outgoing,
          newCustomers,
          aiCount: 0,
          mediaCount: 0,
          invoiceIssued: invoiceIssuedCount,
          invoicePaid: salesCount,
          logs: finalLogs,
          hourlyActivity: hourlyCounts,
          topQuestions: topQuestions,
        },
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  } else {
    // Realtime / All Time View
    // We need to fetch total chats count for "newCustomers" (Total Customers)
    try {
      const totalChats = await prisma.chat.count({
        where: { sessionId },
      });

      // --- NEW: Hourly Activity & Top Questions (All Time / Last 30 Days) ---
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const hourlyMessages = await prisma.message.findMany({
        where: {
          chat: { sessionId },
          fromMe: false,
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { createdAt: true },
      });

      const hourlyCounts = new Array(24).fill(0);
      hourlyMessages.forEach((msg) => {
        const hour = new Date(msg.createdAt).getHours();
        hourlyCounts[hour]++;
      });

      const recentIncoming = await prisma.message.findMany({
        where: {
          chat: { sessionId },
          fromMe: false,
          text: { not: null },
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { text: true },
        take: 2000,
      });

      const questionMap = {};
      recentIncoming.forEach((msg) => {
        if (!msg.text) return;
        const text = msg.text.trim();
        if (text.length < 4) return;
        if (questionMap[text]) questionMap[text]++;
        else questionMap[text] = 1;
      });

      const topQuestions = Object.keys(questionMap)
        .map((key) => ({ question: key, count: questionMap[key] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const stats = getSessionStats(sessionId);
      res.json({
        status: "success",
        data: {
          ...stats,
          newCustomers: totalChats,
          hourlyActivity: hourlyCounts,
          topQuestions: topQuestions,
        },
      });
    } catch (e) {
      res.json({ status: "success", data: getSessionStats(sessionId) });
    }
  }
});

// --- EXPORT DASHBOARD ---
app.get("/api/export-dashboard/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Fetch all relevant data
    const stats = getSessionStats(sessionId);
    const totalChats = await prisma.chat.count({ where: { sessionId } });

    // Top Products
    const sales = await prisma.sale.findMany({ where: { sessionId } });
    const productMap = {};
    sales.forEach((sale) => {
      if (!productMap[sale.itemName]) productMap[sale.itemName] = 0;
      productMap[sale.itemName] += sale.qty;
    });
    const topProducts = Object.keys(productMap)
      .map((key) => ({ Product: key, Qty: productMap[key] }))
      .sort((a, b) => b.Qty - a.Qty);

    // Logs (Last 1000) - REMOVED FROM EXPORT
    /*
    const messages = await prisma.message.findMany({
      where: { chat: { sessionId } },
      orderBy: { createdAt: "desc" },
      take: 1000,
      include: { chat: true },
    });
    const logs = messages.map((m) => ({
      Date: m.createdAt,
      From: m.fromMe ? "System" : m.chat.name || m.chat.remoteJid,
      Message: m.text || "Media",
      Type: m.fromMe ? "Outgoing" : "Incoming",
    }));
    */

    // --- NEW: Hourly Activity & Top Questions for Export ---
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Hourly Activity
    const hourlyMessages = await prisma.message.findMany({
      where: {
        chat: { sessionId },
        fromMe: false,
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true },
    });
    const hourlyCounts = new Array(24).fill(0);
    hourlyMessages.forEach((msg) => {
      const hour = new Date(msg.createdAt).getHours();
      hourlyCounts[hour]++;
    });
    const hourlyData = hourlyCounts.map((count, hour) => ({
      Hour: `${hour}:00`,
      Chats: count,
    }));

    // Top Questions
    const recentIncoming = await prisma.message.findMany({
      where: {
        chat: { sessionId },
        fromMe: false,
        text: { not: null },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { text: true },
      take: 2000,
    });
    const questionMap = {};
    recentIncoming.forEach((msg) => {
      if (!msg.text) return;
      const text = msg.text.trim();
      if (text.length < 4) return;
      if (questionMap[text]) questionMap[text]++;
      else questionMap[text] = 1;
    });
    const topQuestions = Object.keys(questionMap)
      .map((key) => ({ Question: key, Count: questionMap[key] }))
      .sort((a, b) => b.Count - a.Count)
      .slice(0, 20); // Top 20 for export

    // Create Workbook
    const wb = xlsx.utils.book_new();

    // Sheet 1: Summary
    const summaryData = [
      { Metric: "Total Incoming", Value: stats.incoming },
      { Metric: "Total Outgoing", Value: stats.outgoing },
      { Metric: "Total Customers", Value: totalChats },
      { Metric: "Invoices Issued", Value: stats.invoiceIssued },
      { Metric: "Invoices Paid", Value: stats.invoicePaid },
    ];
    const wsSummary = xlsx.utils.json_to_sheet(summaryData);
    xlsx.utils.book_append_sheet(wb, wsSummary, "Summary");

    // Sheet 2: Top Products
    const wsProducts = xlsx.utils.json_to_sheet(topProducts);
    xlsx.utils.book_append_sheet(wb, wsProducts, "Top Products");

    // Sheet 3: Hourly Activity
    const wsHourly = xlsx.utils.json_to_sheet(hourlyData);
    xlsx.utils.book_append_sheet(wb, wsHourly, "Hourly Activity");

    // Sheet 4: Top Questions
    const wsQuestions = xlsx.utils.json_to_sheet(topQuestions);
    xlsx.utils.book_append_sheet(wb, wsQuestions, "Top Questions");

    // Write to buffer
    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Dashboard_Export_${sessionId}.xlsx"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  } catch (e) {
    console.error("Export failed:", e);
    res.status(500).json({ error: "Export failed" });
  }
});

app.get("/api/debug/sales/:sessionId", async (req, res) => {
  try {
    console.log(`[DEBUG API] Checking sales for: ${req.params.sessionId}`);
    const sales = await prisma.sale.findMany({
      where: { sessionId: req.params.sessionId },
    });
    console.log(`[DEBUG API] Found ${sales.length} sales`);
    res.json({ status: "success", count: sales.length, data: sales });
  } catch (e) {
    console.error("[DEBUG API] Error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/products/:sessionId", (req, res) =>
  res.json({
    status: "success",
    data: productStore[req.params.sessionId] || [],
  })
);

// --- AI SETTINGS API ---
app.get("/ai/settings/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessionAIStore[sessionId];

  // If session doesn't exist, return default empty settings instead of error
  // This allows the UI to load even if no AI session has been started yet
  if (!session) {
    return res.json({
      status: "success",
      data: {
        systemPrompt: "",
        inventoryFile: null,
        inventoryUrl: "",
        inventorySource: "excel", // Default
        knowledgeFiles: [],
        invoiceSettings: {
          title: "INVOICE",
          address: "",
          footer: "",
          logo: null,
        },
      },
    });
  }

  res.json({
    status: "success",
    data: {
      systemPrompt: session.systemPrompt || "",
      inventoryFile: session.inventoryFile || null,
      inventoryUrl: session.inventoryUrl || "",
      inventorySource: session.inventorySource || "excel",
      knowledgeFiles: (session.knowledgeFiles || []).map((f) => f.filename),
      invoiceSettings: session.invoiceSettings || {
        title: "INVOICE",
        address: "",
        footer: "",
        logo: null,
      },
    },
  });
});

// --- SET INVENTORY SOURCE API ---
app.post("/ai/set-inventory-source", (req, res) => {
  const { sessionId, source } = req.body; // source: 'excel' | 'sheet'
  if (!sessionId || !source)
    return res.status(400).json({ error: "Missing params" });

  if (!sessionAIStore[sessionId]) {
    sessionAIStore[sessionId] = {
      isActive: false,
      hasFile: false,
      systemPrompt: "",
      inventoryFile: null,
      inventoryUrl: "",
      inventorySource: "excel",
      excelData: [],
      sheetData: [],
      knowledgeFiles: [],
      knowledgeContext: "",
      invoiceSettings: {},
    };
  }

  const session = sessionAIStore[sessionId];
  session.inventorySource = source;

  // Switch Context & Product Store
  let activeData = [];
  if (source === "excel") {
    activeData = session.excelData || [];
  } else if (source === "sheet") {
    activeData = session.sheetData || [];
  }

  productStore[sessionId] = activeData;
  session.productContext = JSON.stringify(activeData);
  session.hasFile = activeData.length > 0;

  io.to(sessionId).emit("ai_status", session);
  res.json({ status: "success", source: source, count: activeData.length });
});

// --- INVOICE SETTINGS API ---
app.post("/invoice/settings", upload.single("logo"), (req, res) => {
  const { sessionId, title, address, footer, shippingOptions } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  if (!sessionAIStore[sessionId]) {
    sessionAIStore[sessionId] = {
      isActive: false,
      hasFile: false,
      systemPrompt: "",
      inventoryFile: null,
      knowledgeFiles: [],
      knowledgeContext: "",
      inventoryUrl: "",
      invoiceSettings: {},
    };
  }

  if (!sessionAIStore[sessionId].invoiceSettings) {
    sessionAIStore[sessionId].invoiceSettings = {};
  }

  const settings = sessionAIStore[sessionId].invoiceSettings;
  settings.title = title || "INVOICE";
  settings.address = address || "";
  settings.footer = footer || "";

  if (shippingOptions) {
    try {
      settings.shippingOptions = JSON.parse(shippingOptions);
    } catch (e) {
      settings.shippingOptions = [];
    }
  }

  if (req.file) {
    // Remove old logo if exists
    if (settings.logo) {
      const oldPath = path.join(__dirname, "../uploads", settings.logo);
      if (fs.existsSync(oldPath))
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {}
    }
    settings.logo = req.file.filename;
  }

  io.to(sessionId).emit("ai_status", sessionAIStore[sessionId]);
  res.json({ status: "success", data: settings });
});

// 1. Upload Inventory (Master Data)
app.post("/ai/upload-inventory", upload.single("file"), async (req, res) => {
  const { sessionId } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  if (!sessionAIStore[sessionId]) {
    sessionAIStore[sessionId] = {
      isActive: false,
      hasFile: false,
      systemPrompt: "",
      inventoryFile: null,
      knowledgeFiles: [],
      knowledgeContext: "",
      inventoryUrl: "",
    };
  }
  // Ensure structure is complete even if session exists
  if (!sessionAIStore[sessionId].knowledgeFiles)
    sessionAIStore[sessionId].knowledgeFiles = [];

  try {
    const workbook = xlsx.readFile(req.file.path);
    const data = xlsx.utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]]
    );

    // Update Excel Data Cache
    sessionAIStore[sessionId].excelData = data;
    sessionAIStore[sessionId].inventoryFile = req.file.originalname;

    // Only update active context if source is 'excel' (or not set yet)
    if (
      !sessionAIStore[sessionId].inventorySource ||
      sessionAIStore[sessionId].inventorySource === "excel"
    ) {
      sessionAIStore[sessionId].inventorySource = "excel";
      productStore[sessionId] = data;
      sessionAIStore[sessionId].productContext = JSON.stringify(data);
      sessionAIStore[sessionId].hasFile = true;
    }

    fs.unlinkSync(req.file.path);
    io.to(sessionId).emit("ai_status", sessionAIStore[sessionId]);

    res.json({
      status: "success",
      count: data.length,
      filename: req.file.originalname,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to process inventory file" });
  }
});

// 2. Upload Knowledge Base (Additional Context)
app.post("/ai/upload-knowledge", upload.single("file"), async (req, res) => {
  const { sessionId } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  if (!sessionAIStore[sessionId]) {
    sessionAIStore[sessionId] = {
      isActive: false,
      hasFile: false,
      systemPrompt: "",
      inventoryFile: null,
      knowledgeFiles: [],
      knowledgeContext: "",
      inventoryUrl: "",
    };
  }
  // Ensure structure is complete
  if (!sessionAIStore[sessionId].knowledgeFiles)
    sessionAIStore[sessionId].knowledgeFiles = [];

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const textContent = JSON.stringify(data); // Convert to string for AI context

    // Add to Knowledge Files
    sessionAIStore[sessionId].knowledgeFiles.push({
      filename: req.file.originalname,
      content: textContent,
    });

    // Rebuild Knowledge Context
    sessionAIStore[sessionId].knowledgeContext = sessionAIStore[
      sessionId
    ].knowledgeFiles
      .map((f) => `[File: ${f.filename}]\n${f.content}`)
      .join("\n\n");

    fs.unlinkSync(req.file.path);
    io.to(sessionId).emit("ai_status", sessionAIStore[sessionId]);

    res.json({ status: "success", filename: req.file.originalname });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to process knowledge file" });
  }
});

// 3. Delete Knowledge File
app.delete("/ai/knowledge/:sessionId/:filename", (req, res) => {
  const { sessionId, filename } = req.params;
  const session = sessionAIStore[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.knowledgeFiles = session.knowledgeFiles.filter(
    (f) => f.filename !== filename
  );

  // Rebuild Context
  session.knowledgeContext = session.knowledgeFiles
    .map((f) => `[File: ${f.filename}]\n${f.content}`)
    .join("\n\n");

  io.to(sessionId).emit("ai_status", session);
  res.json({ status: "success" });
});

// --- GOOGLE SHEET INTEGRATION ---
app.post("/ai/save-inventory-url", (req, res) => {
  const { sessionId, inventoryUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  if (!sessionAIStore[sessionId]) {
    sessionAIStore[sessionId] = {
      isActive: false,
      hasFile: false,
      systemPrompt: "",
      inventoryFile: null,
      knowledgeFiles: [],
      knowledgeContext: "",
      inventoryUrl: "",
    };
  }

  sessionAIStore[sessionId].inventoryUrl = inventoryUrl;
  io.to(sessionId).emit("ai_status", sessionAIStore[sessionId]);
  res.json({ success: true, message: "Inventory URL saved" });
});

app.post("/ai/sync-inventory", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  const sessionData = sessionAIStore[sessionId];
  if (!sessionData || !sessionData.inventoryUrl) {
    return res.status(400).json({ error: "No inventory URL configured" });
  }

  try {
    let url = sessionData.inventoryUrl;

    // FIX: Auto-convert Google Sheet View/Edit links to Export XLSX links
    if (url.includes("docs.google.com/spreadsheets")) {
      // Extract Spreadsheet ID
      const idMatch = url.match(/\/d\/(.*?)\//);
      if (idMatch) {
        const spreadsheetId = idMatch[1];
        url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
        console.log(`[SYNC] Converted Google Sheet URL to: ${url}`);
      }
    }

    const response = await axios.get(url, {
      responseType: "arraybuffer",
    });

    const workbook = xlsx.read(response.data, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(sheet);

    if (jsonData.length > 0) {
      console.log("[DEBUG] Sync Inventory Data (First Item):", jsonData[0]);
      console.log("[DEBUG] Keys:", Object.keys(jsonData[0]));
    } else {
      console.log("[DEBUG] Sync Inventory: No data found in sheet");
    }

    // Update Sheet Data Cache
    sessionData.sheetData = jsonData;

    // Only update active context if source is 'sheet'
    if (sessionData.inventorySource === "sheet") {
      productStore[sessionId] = jsonData;
      sessionData.productContext = JSON.stringify(jsonData);
      sessionData.hasFile = true;
    }

    io.to(sessionId).emit("ai_status", sessionData);

    res.json({ success: true, count: jsonData.length });
  } catch (error) {
    console.error("Sync error:", error);
    res
      .status(500)
      .json({ error: "Failed to sync inventory: " + error.message });
  }
});

app.post("/ai/toggle", (req, res) => {
  if (!sessionAIStore[req.body.sessionId])
    return res.status(400).json({ error: "Session not found" });
  sessionAIStore[req.body.sessionId].isActive = req.body.isActive;
  io.to(req.body.sessionId).emit(
    "ai_status",
    sessionAIStore[req.body.sessionId]
  );
  res.json({ status: "success" });
});

app.post("/ai/save-prompt", (req, res) => {
  if (!sessionAIStore[req.body.sessionId])
    return res.status(400).json({ error: "Session not found" });
  sessionAIStore[req.body.sessionId].systemPrompt = req.body.prompt;
  io.to(req.body.sessionId).emit(
    "ai_status",
    sessionAIStore[req.body.sessionId]
  );
  res.json({ status: "success" });
});

// --- API CHAT HISTORY & DELETE ---
app.get("/chat/history/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const chats = await prisma.chat.findMany({
      where: { sessionId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          take: 50,
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ status: "success", data: chats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.delete("/chat/delete/:sessionId/:remoteJid", async (req, res) => {
  const { sessionId, remoteJid } = req.params;
  try {
    // Karena on delete cascade, pesan otomatis terhapus
    await prisma.chat.deleteMany({
      where: {
        sessionId: sessionId,
        remoteJid: remoteJid,
      },
    });

    // Hapus juga dari CRM store memory agar sinkron
    if (crmStore[sessionId] && crmStore[sessionId][remoteJid]) {
      delete crmStore[sessionId][remoteJid];
    }

    res.json({ status: "success" });
  } catch (e) {
    console.error("Error deleting chat:", e);
    res.status(500).json({ error: "Failed to delete chat" });
  }
});

app.delete("/chat/message/:messageId", async (req, res) => {
  const { messageId } = req.params;
  const id = parseInt(messageId);

  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid message ID" });
  }

  try {
    // 1. Cari pesan dulu untuk dapat info keyId & remoteJid
    const message = await prisma.message.findUnique({
      where: { id },
      include: { chat: true },
    });

    if (message) {
      // 2. Hapus dari WhatsApp (jika sesi aktif)
      const { sessionId, remoteJid } = message.chat;
      const session = sessions.get(sessionId);

      if (session && session.status === "connected" && message.keyId) {
        try {
          const key = {
            remoteJid: remoteJid,
            fromMe: message.fromMe,
            id: message.keyId,
          };
          await session.sock.sendMessage(remoteJid, { delete: key });
        } catch (err) {
          console.error("Gagal menghapus pesan di WA:", err);
        }
      }

      // 3. Hapus dari Database
      await prisma.message.delete({
        where: { id: parseInt(messageId) },
      });
    }

    res.json({ status: "success" });
  } catch (e) {
    console.error("Error deleting message:", e);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// --- API SCHEDULE ---
app.get("/schedule/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const schedules = await prisma.schedule.findMany({
      where: { sessionId },
      orderBy: { date: "asc" },
    });
    res.json({ status: "success", data: schedules });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch schedules" });
  }
});

app.post("/schedule/create", async (req, res) => {
  const { sessionId, title, description, date, customerJid } = req.body;
  try {
    const newSchedule = await prisma.schedule.create({
      data: {
        sessionId,
        title,
        description,
        date: new Date(date),
        customerJid,
      },
    });
    res.json({ status: "success", data: newSchedule });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create schedule" });
  }
});

app.put("/schedule/update/:id", async (req, res) => {
  const { id } = req.params;
  const { title, description, date } = req.body;
  try {
    const updated = await prisma.schedule.update({
      where: { id: parseInt(id) },
      data: {
        title,
        description,
        date: new Date(date),
      },
    });
    res.json({ status: "success", data: updated });
  } catch (e) {
    res.status(500).json({ error: "Failed to update schedule" });
  }
});

app.delete("/schedule/delete/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.schedule.delete({
      where: { id: parseInt(id) },
    });
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete schedule" });
  }
});

// --- API TOP PRODUCT (YANG DIPERBAIKI) ---
// Menggunakan logic manual agar lebih stabil dan anti-typo
app.get("/api/top-products/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { month } = req.query;

    // 1. Bersihkan ID dari spasi yang tidak sengaja (TRIM)
    const cleanSessionId = sessionId.trim();

    let whereClause = { sessionId: cleanSessionId };
    if (month) {
      const [year, monthNum] = month.split("-").map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);
      whereClause.date = { gte: startDate, lte: endDate };
    }

    // 2. Ambil SEMUA data penjualan untuk sesi ini
    const sales = await prisma.sale.findMany({
      where: whereClause,
    });

    if (sales.length === 0 && !month) {
      // Jika masih kosong, coba cari tanpa trim sebagai fallback (hanya jika tidak ada filter bulan)
      const fallbackSales = await prisma.sale.findMany({
        where: { sessionId: sessionId },
      });
      if (fallbackSales.length > 0) {
        console.log("[API] Data ditemukan dengan ID original (untrimmed).");
        // Lanjutkan logic dengan data fallback jika ada
      } else {
        console.log("[API] Data benar-benar kosong untuk session ini.");
        return res.json({ status: "success", data: [] });
      }
    }

    // 3. Hitung manual (Lebih aman dari GroupBy)
    const productMap = {};

    sales.forEach((sale) => {
      const name = sale.itemName;
      // Jika belum ada di list, set 0
      if (!productMap[name]) {
        productMap[name] = 0;
      }
      // Tambahkan qty
      productMap[name] += sale.qty;
    });

    // 4. Ubah format objek ke array untuk grafik dashboard
    const formatted = Object.keys(productMap)
      .map((key) => ({
        name: key,
        totalQty: productMap[key],
      }))
      .sort((a, b) => b.totalQty - a.totalQty) // Urutkan dari yang terbesar
      .slice(0, 5); // Ambil 5 besar saja

    res.json({ status: "success", data: formatted });
  } catch (e) {
    console.error("[API ERROR] Gagal load top products:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// =====================================================
// --- DEVELOPER DASHBOARD APIS ---
// =====================================================

// Middleware to verify developer role
const verifyDeveloperRole = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const sessionId =
    authHeader?.replace("Bearer ", "") ||
    req.query.sessionId ||
    req.body?.sessionId;

  if (!sessionId) {
    return res
      .status(401)
      .json({ error: "Authorization required", code: "NO_AUTH" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { waSessionId: sessionId },
    });

    if (!user) {
      return res
        .status(401)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    if (user.role !== "DEVELOPER") {
      return res.status(403).json({
        error: "Access denied. Developer role required.",
        code: "FORBIDDEN",
      });
    }

    req.user = user;
    next();
  } catch (e) {
    console.error("Developer auth error:", e);
    return res.status(500).json({ error: "Authentication failed" });
  }
};

// GET all users with subscription info (for Developer only)
app.get("/api/developer/users", verifyDeveloperRole, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        waSessionId: true,
        role: true,
        expiryDate: true,
        hideCountdown: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Calculate remaining days for each user
    const usersWithInfo = users.map((user) => {
      let remainingDays = null;
      let status = "ACTIVE";

      if (user.role === "DEVELOPER") {
        status = "UNLIMITED";
      } else if (user.expiryDate) {
        const now = new Date();
        const expiry = new Date(user.expiryDate);
        const diffTime = expiry - now;
        remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (remainingDays <= 0) {
          status = "EXPIRED";
          remainingDays = 0;
        } else if (remainingDays <= 3) {
          status = "EXPIRING_SOON";
        }
      }

      return {
        ...user,
        remainingDays,
        status,
      };
    });

    res.json({ status: "success", data: usersWithInfo });
  } catch (e) {
    console.error("Error fetching users:", e);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// UPDATE user subscription (add/remove days)
app.post(
  "/api/developer/update-subscription",
  verifyDeveloperRole,
  async (req, res) => {
    const { userId, action, days } = req.body;

    if (!userId || !action || days === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      let newExpiryDate;

      if (action === "set_unlimited") {
        // Set to unlimited (null expiryDate)
        newExpiryDate = null;
      } else {
        // Calculate from current expiry or now if expired
        const baseDate =
          user.expiryDate && new Date(user.expiryDate) > new Date()
            ? new Date(user.expiryDate)
            : new Date();

        if (action === "add") {
          baseDate.setDate(baseDate.getDate() + Number(days));
        } else if (action === "subtract") {
          baseDate.setDate(baseDate.getDate() - Number(days));
        } else if (action === "set") {
          // Set specific expiry date
          baseDate.setDate(new Date().getDate() + Number(days));
        }

        newExpiryDate = baseDate;
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { expiryDate: newExpiryDate },
      });

      res.json({
        status: "success",
        message: `Subscription updated for ${user.email}`,
        expiryDate: updatedUser.expiryDate,
      });
    } catch (e) {
      console.error("Error updating subscription:", e);
      res.status(500).json({ error: "Failed to update subscription" });
    }
  }
);

// UPDATE user role (promote to developer or demote to user)
app.post(
  "/api/developer/update-role",
  verifyDeveloperRole,
  async (req, res) => {
    const { userId, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!["USER", "DEVELOPER"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    try {
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          role: role,
          // If promoting to DEVELOPER, set unlimited subscription
          expiryDate: role === "DEVELOPER" ? null : undefined,
        },
      });

      res.json({
        status: "success",
        message: `User role updated to ${role}`,
        user: updatedUser,
      });
    } catch (e) {
      console.error("Error updating role:", e);
      res.status(500).json({ error: "Failed to update role" });
    }
  }
);

// GET user subscription info (for logged-in user)
app.get("/api/user/subscription/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { waSessionId: sessionId },
      select: {
        id: true,
        email: true,
        role: true,
        expiryDate: true,
        hideCountdown: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    let remainingDays = null;
    let status = "ACTIVE";
    let isExpired = false;

    if (user.role === "DEVELOPER") {
      status = "UNLIMITED";
    } else if (user.expiryDate) {
      const now = new Date();
      const expiry = new Date(user.expiryDate);
      const diffTime = expiry - now;
      remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (remainingDays <= 0) {
        status = "EXPIRED";
        remainingDays = 0;
        isExpired = true;
      } else if (remainingDays <= 3) {
        status = "EXPIRING_SOON";
      }
    }

    res.json({
      status: "success",
      data: {
        ...user,
        remainingDays,
        subscriptionStatus: status,
        isExpired,
      },
    });
  } catch (e) {
    console.error("Error fetching subscription:", e);
    res.status(500).json({ error: "Failed to fetch subscription info" });
  }
});

// UPDATE user hideCountdown preference
app.post("/api/user/toggle-countdown", async (req, res) => {
  const { sessionId, hideCountdown } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { waSessionId: sessionId },
      data: { hideCountdown: hideCountdown },
    });

    res.json({
      status: "success",
      hideCountdown: updatedUser.hideCountdown,
    });
  } catch (e) {
    console.error("Error updating countdown preference:", e);
    res.status(500).json({ error: "Failed to update preference" });
  }
});

// DELETE user account (for Developer only)
app.delete(
  "/api/developer/delete-user/:userId",
  verifyDeveloperRole,
  async (req, res) => {
    const { userId } = req.params;

    try {
      // First check if user exists
      const user = await prisma.user.findUnique({
        where: { id: Number(userId) },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Delete related data first (cascading)
      await prisma.chat.deleteMany({ where: { sessionId: user.waSessionId } });
      await prisma.sale.deleteMany({ where: { sessionId: user.waSessionId } });
      await prisma.schedule.deleteMany({
        where: { sessionId: user.waSessionId },
      });
      await prisma.session.deleteMany({
        where: { sessionId: user.waSessionId },
      });

      // Delete user
      await prisma.user.delete({ where: { id: Number(userId) } });

      res.json({ status: "success", message: "User deleted successfully" });
    } catch (e) {
      console.error("Error deleting user:", e);
      res.status(500).json({ error: "Failed to delete user" });
    }
  }
);

// =============================================
// SCHEDULED BROADCAST API
// =============================================

// Get all scheduled broadcasts for a session
app.get("/api/broadcasts/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const broadcasts = await prisma.scheduledBroadcast.findMany({
      where: { sessionId },
      orderBy: { scheduledAt: "asc" },
    });
    res.json({ status: "success", data: broadcasts });
  } catch (e) {
    console.error("Error fetching broadcasts:", e);
    res.status(500).json({ error: "Failed to fetch broadcasts" });
  }
});

// Create a new scheduled broadcast
app.post("/api/broadcasts", async (req, res) => {
  const { sessionId, title, message, targetLabel, manualNumbers, scheduledAt } =
    req.body;

  try {
    // Validate scheduledAt is in the future
    const scheduleDate = new Date(scheduledAt);
    if (scheduleDate <= new Date()) {
      return res
        .status(400)
        .json({ error: "Waktu broadcast harus di masa depan" });
    }

    const broadcast = await prisma.scheduledBroadcast.create({
      data: {
        sessionId,
        title,
        message,
        targetLabel: targetLabel || "all",
        manualNumbers: manualNumbers || null,
        scheduledAt: scheduleDate,
        status: "PENDING",
      },
    });

    res.json({ status: "success", data: broadcast });
  } catch (e) {
    console.error("Error creating broadcast:", e);
    res.status(500).json({ error: "Failed to create broadcast" });
  }
});

// Update a scheduled broadcast
app.put("/api/broadcasts/:id", async (req, res) => {
  const { id } = req.params;
  const { title, message, targetLabel, manualNumbers, scheduledAt } = req.body;

  try {
    const existing = await prisma.scheduledBroadcast.findUnique({
      where: { id: Number(id) },
    });

    if (!existing) {
      return res.status(404).json({ error: "Broadcast not found" });
    }

    if (existing.status !== "PENDING") {
      return res
        .status(400)
        .json({ error: "Hanya broadcast PENDING yang bisa diedit" });
    }

    const broadcast = await prisma.scheduledBroadcast.update({
      where: { id: Number(id) },
      data: {
        title,
        message,
        targetLabel,
        manualNumbers,
        scheduledAt: new Date(scheduledAt),
      },
    });

    res.json({ status: "success", data: broadcast });
  } catch (e) {
    console.error("Error updating broadcast:", e);
    res.status(500).json({ error: "Failed to update broadcast" });
  }
});

// Cancel a scheduled broadcast
app.post("/api/broadcasts/:id/cancel", async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.scheduledBroadcast.findUnique({
      where: { id: Number(id) },
    });

    if (!existing) {
      return res.status(404).json({ error: "Broadcast not found" });
    }

    if (existing.status !== "PENDING") {
      return res
        .status(400)
        .json({ error: "Hanya broadcast PENDING yang bisa dibatalkan" });
    }

    await prisma.scheduledBroadcast.update({
      where: { id: Number(id) },
      data: { status: "CANCELLED" },
    });

    res.json({ status: "success", message: "Broadcast cancelled" });
  } catch (e) {
    console.error("Error cancelling broadcast:", e);
    res.status(500).json({ error: "Failed to cancel broadcast" });
  }
});

// Delete a scheduled broadcast
app.delete("/api/broadcasts/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.scheduledBroadcast.delete({
      where: { id: Number(id) },
    });

    res.json({ status: "success", message: "Broadcast deleted" });
  } catch (e) {
    console.error("Error deleting broadcast:", e);
    res.status(500).json({ error: "Failed to delete broadcast" });
  }
});

// Clear Broadcast History (Delete all NON-PENDING)
app.delete("/api/broadcasts/history/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const deleted = await prisma.scheduledBroadcast.deleteMany({
      where: {
        sessionId,
        status: { not: "PENDING" },
      },
    });
    res.json({
      status: "success",
      message: `${deleted.count} riwayat broadcast dihapus`,
    });
  } catch (e) {
    console.error("Error clearing broadcast history:", e);
    res.status(500).json({ error: "Failed to clear history" });
  }
});

// Broadcast Processing Function
async function processPendingBroadcasts() {
  try {
    const now = new Date();

    // Find broadcasts that should be sent now
    const pendingBroadcasts = await prisma.scheduledBroadcast.findMany({
      where: {
        status: "PENDING",
        scheduledAt: { lte: now },
      },
    });

    for (const broadcast of pendingBroadcasts) {
      console.log(`[BROADCAST] Processing: ${broadcast.title}`);

      try {
        const session = sessions.get(broadcast.sessionId);
        if (!session || !session.sock) {
          await prisma.scheduledBroadcast.update({
            where: { id: broadcast.id },
            data: {
              status: "FAILED",
              errorMessage: "Session WhatsApp tidak aktif",
            },
          });
          continue;
        }

        const sock = session.sock;

        let targets = [];

        // Determine targets
        if (broadcast.manualNumbers) {
          // Manual numbers (comma separated)
          targets = broadcast.manualNumbers
            .split(/[\n,]+/)
            .map((n) => n.trim())
            .filter((n) => n)
            .map((n) => formatPhone(n));
        } else if (broadcast.targetLabel === "all") {
          // All chats
          const chats = await prisma.chat.findMany({
            where: { sessionId: broadcast.sessionId },
            select: { remoteJid: true },
          });
          targets = chats.map((c) => c.remoteJid);
        } else {
          // Specific label
          const chats = await prisma.chat.findMany({
            where: {
              sessionId: broadcast.sessionId,
              label: broadcast.targetLabel,
            },
            select: { remoteJid: true },
          });
          targets = chats.map((c) => c.remoteJid);
        }

        // Filter only @s.whatsapp.net (individual chats)
        targets = targets.filter((jid) => jid.endsWith("@s.whatsapp.net"));

        let sentCount = 0;
        const errors = [];

        // Send messages with delay to avoid spam detection
        for (const jid of targets) {
          try {
            await sock.sendMessage(jid, { text: broadcast.message });
            sentCount++;
            // Add delay between messages (1-2 seconds)
            await new Promise((r) =>
              setTimeout(r, 1000 + Math.random() * 1000)
            );
          } catch (sendErr) {
            errors.push(`${jid}: ${sendErr.message}`);
          }
        }

        // Update broadcast status
        await prisma.scheduledBroadcast.update({
          where: { id: broadcast.id },
          data: {
            status: sentCount > 0 ? "SENT" : "FAILED",
            sentAt: new Date(),
            sentCount,
            errorMessage: errors.length > 0 ? errors.join("; ") : null,
          },
        });

        console.log(
          `[BROADCAST] Completed: ${broadcast.title} - Sent to ${sentCount}/${targets.length}`
        );
      } catch (broadcastErr) {
        console.error(`[BROADCAST ERROR] ${broadcast.title}:`, broadcastErr);
        await prisma.scheduledBroadcast.update({
          where: { id: broadcast.id },
          data: {
            status: "FAILED",
            errorMessage: broadcastErr.message,
          },
        });
      }
    }
  } catch (error) {
    console.error("[BROADCAST PROCESSOR ERROR]", error);
  }
}

// --- CLEANUP JOB ---
async function cleanupOldMessages() {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const deleted = await prisma.message.deleteMany({
      where: {
        createdAt: {
          lt: sevenDaysAgo,
        },
      },
    });

    if (deleted.count > 0) {
      console.log(
        `[CLEANUP] Deleted ${deleted.count} messages older than 7 days.`
      );
    }
  } catch (error) {
    console.error("[CLEANUP ERROR]", error);
  }
}

const PORT = 3000;
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initActiveSessions(io);

  // Run cleanup on start
  await cleanupOldMessages();

  // Schedule cleanup every 24 hours
  setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000);

  // Run broadcast processor every 30 seconds
  setInterval(processPendingBroadcasts, 30 * 1000);
  console.log("[BROADCAST] Processor started - checking every 30 seconds");
});
