// wa_engine.js
require("dotenv").config();
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  getContentType,
  downloadMediaMessage,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const { usePrismaAuthState } = require("./lib/auth-service");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

// --- IMPORT ANTI-SPAM PROTECTION ---
const {
  checkWAUserSpam,
  markAutoReplySent,
  isUserBlacklisted,
  blacklistUser,
} = require("./antispam");

// --- CONFIG ---
console.log("[WA_ENGINE] Initializing Prisma Client...");
let prisma;
try {
  const { PrismaClient } = require("./generated/client");
  prisma = new PrismaClient();
  console.log("[WA_ENGINE] Prisma Client initialized successfully");
} catch (e) {
  console.error(
    "[WA_ENGINE] CRITICAL: Failed to initialize Prisma Client:",
    e.message
  );
  // Create a mock prisma to prevent crashes, but operations will fail
  prisma = {
    chat: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({}),
      update: async () => ({}),
      upsert: async () => ({}),
    },
    message: {
      findMany: async () => [],
      create: async () => ({}),
      deleteMany: async () => ({}),
    },
    sale: { create: async () => ({}) },
    session: { findMany: async () => [], deleteMany: async () => ({}) },
    schedule: {
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
    },
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      update: async () => ({}),
      create: async () => ({}),
      delete: async () => ({}),
    },
    verificationCode: {
      findFirst: async () => null,
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
      deleteMany: async () => ({}),
    },
    autoReply: { findMany: async () => [] },
    scheduledBroadcast: {
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
      deleteMany: async () => ({}),
    },
  };
}
const logger = pino({ level: "silent" });
const mediaPath = path.join(__dirname, "../public/media");

// --- AI PROVIDERS SETUP ---
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Puter = require("@heyputer/puter.js").default;

// Initialize AI Providers
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// AI Provider Status Tracking
const aiProviderStatus = {
  groq: { available: true, lastError: null, retryAfter: null },
  sambanova: { available: true, lastError: null, retryAfter: null },
  gemini: { available: true, lastError: null, retryAfter: null },
  openrouter: { available: true, lastError: null, retryAfter: null },
  puter: { available: true, lastError: null, retryAfter: null },
};

// Provider priority order (will fallback in this order)
const AI_PROVIDERS = ["groq", "sambanova", "gemini", "openrouter", "puter"];

// Manual provider selection (null = auto fallback, string = use specific provider first)
let preferredProvider = null;

// Getter and setter for preferred provider
const getPreferredProvider = () => preferredProvider;
const setPreferredProvider = (provider) => {
  if (
    provider === null ||
    provider === "auto" ||
    AI_PROVIDERS.includes(provider)
  ) {
    preferredProvider = provider === "auto" ? null : provider;
    console.log(
      `[AI CONFIG] Preferred provider set to: ${
        preferredProvider || "AUTO (fallback)"
      }`
    );
    return true;
  }
  return false;
};

// Reset provider status after cooldown period (5 minutes default)
const RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;

// Function to check if provider is available
const isProviderAvailable = (provider) => {
  const status = aiProviderStatus[provider];
  if (!status) return false;
  if (!status.available && status.retryAfter) {
    if (Date.now() >= status.retryAfter) {
      // Cooldown expired, reset status
      status.available = true;
      status.lastError = null;
      status.retryAfter = null;
      console.log(
        `[AI FALLBACK] ${provider.toUpperCase()} cooldown expired, now available`
      );
    }
  }
  return status.available;
};

// Function to mark provider as rate limited
const markProviderRateLimited = (provider, error) => {
  aiProviderStatus[provider] = {
    available: false,
    lastError: error?.message || "Rate limited",
    retryAfter: Date.now() + RATE_LIMIT_COOLDOWN,
  };
  console.log(
    `[AI FALLBACK] ${provider.toUpperCase()} marked as rate-limited, will retry in 5 minutes`
  );
};

// Function to get next available provider
const getAvailableProvider = () => {
  for (const provider of AI_PROVIDERS) {
    if (isProviderAvailable(provider)) {
      return provider;
    }
  }
  // If all providers are rate limited, just return the first one anyway
  console.log(
    "[AI FALLBACK] All providers rate-limited, trying first provider anyway"
  );
  return AI_PROVIDERS[0];
};

if (!fs.existsSync(mediaPath)) {
  fs.mkdirSync(mediaPath, { recursive: true });
}

// --- GLOBAL STORES (Diexport agar bisa dibaca server.js) ---
const sessions = new Map();
const globalContactStore = {};
const lidToPhoneMap = {}; // Map LID -> Phone JID
const groupSubjectCache = {};
const sessionAIStore = {};
const productStore = {};
const crmStore = {};
const analyticsStore = {};
const processedMessages = new Set();
const autoReplyStore = {}; // sessionId -> [{keyword, response, id}]
const complaintKeywords = [
  /rusak/i,
  /tidak bisa/i,
  /gagal/i,
  /kecewa/i,
  /bohong/i,
  /penipu/i,
  /salah kirim/i,
  /barang kurang/i,
  /lama banget/i,
  /lambat/i,
  /pecah/i,
  /pesanan belum/i,
];

// --- ANALYTICS STORE (PERSISTENCE) ---
const analyticsFilePath = path.join(__dirname, "../analytics.json");

try {
  if (fs.existsSync(analyticsFilePath)) {
    const data = fs.readFileSync(analyticsFilePath, "utf8");
    Object.assign(analyticsStore, JSON.parse(data));
  }
} catch (e) {
  console.error("Error loading analytics:", e);
}

const saveAnalytics = () => {
  try {
    fs.writeFileSync(
      analyticsFilePath,
      JSON.stringify(analyticsStore, null, 2)
    );
  } catch (e) {
    console.error("Error saving analytics:", e);
  }
};

// Save analytics every 1 minute
setInterval(saveAnalytics, 60 * 1000);

// --- SALES STORE ---
const salesFilePath = path.join(__dirname, "../sales.json");
let salesStore = {};
try {
  if (fs.existsSync(salesFilePath)) {
    salesStore = JSON.parse(fs.readFileSync(salesFilePath, "utf8"));
  }
} catch (e) {
  console.error("Error loading sales:", e);
}

const saveSales = () => {
  try {
    fs.writeFileSync(salesFilePath, JSON.stringify(salesStore, null, 2));
  } catch (e) {}
};

// --- CRM STORE (PERSISTENCE) ---
const crmFilePath = path.join(__dirname, "../crm.json");

try {
  if (fs.existsSync(crmFilePath)) {
    const data = fs.readFileSync(crmFilePath, "utf8");
    Object.assign(crmStore, JSON.parse(data));
  }
} catch (e) {
  console.error("Error loading CRM:", e);
}

const saveCRM = () => {
  try {
    fs.writeFileSync(crmFilePath, JSON.stringify(crmStore, null, 2));
  } catch (e) {
    console.error("Error saving CRM:", e);
  }
};

// Save CRM every 1 minute
setInterval(saveCRM, 60 * 1000);

const recordSale = async (sessionId, cart, customerJid, customerName) => {
  console.log(
    `[WA ENGINE] Recording sale for ${sessionId}, Customer: ${customerName} (${customerJid}), Items: ${cart.length}`
  );

  // --- FIX: Resolve LID to Phone JID if possible ---
  if (customerJid.includes("@lid") && lidToPhoneMap[customerJid]) {
    console.log(
      `[WA ENGINE] Resolving LID ${customerJid} to ${lidToPhoneMap[customerJid]}`
    );
    customerJid = lidToPhoneMap[customerJid];
  }
  // ------------------------------------------------

  try {
    for (const item of cart) {
      await prisma.sale.create({
        data: {
          sessionId,
          itemName: item.name,
          qty: parseInt(item.qty) || 1,
          price: parseFloat(item.price || item.subtotal),
          customerJid,
          customerName,
          date: new Date(),
        },
      });
    }
    console.log(`[WA ENGINE] Sales saved to DB for ${sessionId}`);
  } catch (e) {
    console.error("Error saving sales to DB:", e);
  }
};

setInterval(() => {
  processedMessages.clear();
}, 5 * 60 * 1000);

const loadAutoReplies = async (sessionId) => {
  try {
    const replies = await prisma.autoReply.findMany({
      where: { sessionId },
    });
    autoReplyStore[sessionId] = replies;
  } catch (e) {
    console.error("Error loading auto replies:", e);
    autoReplyStore[sessionId] = [];
  }
};

// --- HELPER FUNCTIONS ---
const getSessionStats = (sessionId) => {
  if (!analyticsStore[sessionId]) {
    analyticsStore[sessionId] = {
      incoming: 0,
      outgoing: 0,
      newCustomers: 0, // Added newCustomers
      aiCount: 0,
      mediaCount: 0,
      invoiceIssued: 0,
      invoicePaid: 0,
      aiCount: 0,
      mediaCount: 0,
      invoiceIssued: 0,
      invoicePaid: 0,
      complaintCount: 0, // Added complaintCount
      topComplaints: {}, // { keyword: count }
      logs: [],
    };
  }
  return analyticsStore[sessionId];
};

const formatPhone = (to) => {
  if (to.toString().includes("@")) return to;
  let formatted = to.toString().replace(/\D/g, "");
  if (formatted.startsWith("0")) formatted = "62" + formatted.slice(1);
  return formatted + "@s.whatsapp.net";
};

const formatPrettyId = (id) => {
  if (!id) return "";
  if (id.includes("@lid")) return "";
  let clean = id.replace("@s.whatsapp.net", "").replace("@g.us", "");
  if (clean.startsWith("62")) return "+" + clean;
  return clean;
};

const sendWebhook = async (url, data) => {
  if (!url) return;
  try {
    await axios.post(url, data);
  } catch (error) {}
};

// --- AI LOGIC ---
const addHistory = (sessionId, userJid, role, content) => {
  const session = sessionAIStore[sessionId];
  if (!session) return;
  if (!session.histories) session.histories = {};
  if (!session.histories[userJid]) session.histories[userJid] = [];
  session.histories[userJid].push({ role, content });
  if (session.histories[userJid].length > 10)
    session.histories[userJid] = session.histories[userJid].slice(-10);
};

const getHistory = (sessionId, userJid) => {
  const session = sessionAIStore[sessionId];
  if (!session || !session.histories || !session.histories[userJid]) return [];
  return session.histories[userJid];
};

const generateAIResponse = async (
  sessionId,
  userJid,
  userMessage,
  senderName
) => {
  const sessionData = sessionAIStore[sessionId];
  const defaultPrompt = `Kamu adalah Customer Service (CS) dari [NAMA TOKO ANDA].

Tugasmu adalah menjawab pertanyaan pelanggan dengan gaya yang:
1. PROFESIONAL tapi SANTAI: Gunakan bahasa Indonesia yang baku namun luwes. Hindari kata-kata kaku seperti "Sesuai dengan ketentuan yang berlaku". Ganti dengan "Sesuai aturan ya Kak".
2. RAMAH & EMPATIK: Selalu gunakan sapaan "Kak" atau "Sis/Gan" (sesuaikan). Gunakan emoji secukupnya (maksimal 1-2 per pesan) agar suasana cair.
3. SOLUTIF: Jangan cuma menjawab "Ya/Tidak". Berikan solusi atau rekomendasi. Jika stok habis, tawarkan alternatif.
4. TO THE POINT: Jawaban harus ringkas, jelas, dan tidak bertele-tele. Maksimal 3 paragraf pendek.

PENTING:
- Jika ditanya harga/produk, gunakan data dari konteks yang diberikan. Jangan mengarang harga.
- Jika kamu tidak tahu jawabannya, katakan: "Bentar ya Kak, aku cek dulu ke tim gudang/admin sebentar" (jangan bilang "sebagai AI saya tidak tahu").
- Jika produk memiliki gambar (kolom 'Image', 'Gambar', atau 'Url'), kamu BISA mengirimkan gambarnya dengan menambahkan tag [IMAGE: url_gambar] di akhir jawabanmu.
- Tutup percakapan dengan kalimat yang memancing interaksi, misal: "Ada lagi yang bisa dibantu, Kak?"

CONTOH GAYA BICARA:
User: "Barangnya ready gak min?"
Kamu: "Halo Kak! 👋 Untuk barang itu ready stok siap kirim ya. Mau warna apa nih Kak biar aku cekin sekalian? 😊"
User: "Ada gambarnya gak?"
Kamu: "Ini ya Kak gambarnya, real pict kok! [IMAGE: https://example.com/foto.jpg]"`;
  const adminPrompt = sessionData?.systemPrompt || defaultPrompt;
  const productData =
    sessionData?.productContext ||
    "(Belum ada data produk, jawab secara umum saja)";
  const knowledgeData = sessionData?.knowledgeContext || "";

  // Sanitize inputs to prevent prompt injection or weird behavior
  const cleanName = senderName.replace(/[^\w\s]/gi, "").substring(0, 50);
  const cleanProductData =
    productData.length > 5000
      ? productData.substring(0, 5000) + "...(truncated)"
      : productData;
  const cleanKnowledgeData =
    knowledgeData.length > 5000
      ? knowledgeData.substring(0, 5000) + "...(truncated)"
      : knowledgeData;

  addHistory(sessionId, userJid, "user", userMessage);
  const conversationHistory = getHistory(sessionId, userJid);

  const systemPrompt = `SYSTEM INSTRUCTION:
${adminPrompt}

CONTEXT:
- User Name: ${cleanName}
- Product Data (Inventory): ${cleanProductData}
- Additional Knowledge Base: ${cleanKnowledgeData}

GUIDELINES:
- Answer in Indonesian.
- Be concise (max 3 paragraphs).
- Do NOT repeat words or sentences.
- If the user says "Hi" or "Hello", greet them back warmly using their name.`;

  // Helper functions for each provider
  const callGroq = async () => {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        ...conversationHistory,
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 300,
      top_p: 0.9,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
    });
    return completion.choices[0]?.message?.content || "";
  };

  const callSambaNova = async () => {
    // SambaNova uses OpenAI-compatible API
    const response = await axios.post(
      "https://api.sambanova.ai/v1/chat/completions",
      {
        model: "Meta-Llama-3.1-70B-Instruct",
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory,
        ],
        temperature: 0.5,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SAMBANOVA_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0]?.message?.content || "";
  };

  const callGemini = async () => {
    if (!genAI) throw new Error("Gemini API key not configured");
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Convert conversation history to Gemini format
    const history = conversationHistory.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const chat = model.startChat({
      history,
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 300,
      },
    });

    // Add system prompt as context
    const fullPrompt = `${systemPrompt}\n\nUser's message: ${userMessage}`;
    const result = await chat.sendMessage(fullPrompt);
    return result.response.text() || "";
  };

  const callOpenRouter = async () => {
    if (!process.env.OPENROUTER_API_KEY)
      throw new Error("OpenRouter API key not configured");

    // OpenRouter uses OpenAI-compatible API
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "meta-llama/llama-3.1-70b-instruct:free", // Free tier model
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory,
        ],
        temperature: 0.5,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "NayooAI CS Bot",
        },
      }
    );
    return response.data.choices[0]?.message?.content || "";
  };

  const callPuter = async () => {
    // Puter.js - Free AI with no API key required
    const puter = new Puter();

    // Build messages in Puter-compatible format
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    // Use puter.ai.chat with free model
    const response = await puter.ai.chat(messages, {
      model: "claude-3-5-sonnet", // Best free model available on Puter
      max_tokens: 300,
    });

    // Response can be string or object with text property
    return typeof response === "string"
      ? response
      : response?.text || response?.message?.content || "";
  };

  // Check if error is rate limit
  const isRateLimitError = (error) => {
    const msg = error?.message?.toLowerCase() || "";
    const statusCode = error?.response?.status || error?.status;
    return (
      statusCode === 429 ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests") ||
      msg.includes("quota exceeded")
    );
  };

  // Try providers with fallback
  // If preferred provider is set, try it first, then fallback to others
  let providers = ["groq", "sambanova", "gemini", "openrouter", "puter"];

  if (preferredProvider && AI_PROVIDERS.includes(preferredProvider)) {
    // Reorder: preferred first, then others in original order
    providers = [
      preferredProvider,
      ...providers.filter((p) => p !== preferredProvider),
    ];
    console.log(
      `[AI CONFIG] Using manual provider order: ${providers.join(" -> ")}`
    );
  }

  for (const provider of providers) {
    // Skip if provider is currently rate limited
    if (!isProviderAvailable(provider)) {
      console.log(
        `[AI FALLBACK] Skipping ${provider.toUpperCase()} (rate limited)`
      );
      continue;
    }

    try {
      console.log(`[AI FALLBACK] Trying ${provider.toUpperCase()}...`);

      let reply = "";

      switch (provider) {
        case "groq":
          reply = await callGroq();
          break;
        case "sambanova":
          reply = await callSambaNova();
          break;
        case "gemini":
          reply = await callGemini();
          break;
        case "openrouter":
          reply = await callOpenRouter();
          break;
        case "puter":
          reply = await callPuter();
          break;
      }

      if (reply) {
        console.log(`[AI FALLBACK] ${provider.toUpperCase()} success!`);
        addHistory(sessionId, userJid, "assistant", reply);
        return reply;
      }
    } catch (error) {
      console.error(
        `[AI FALLBACK] ${provider.toUpperCase()} error:`,
        error?.message || error
      );

      if (isRateLimitError(error)) {
        markProviderRateLimited(provider, error);
        console.log(
          `[AI FALLBACK] ${provider.toUpperCase()} rate limited, trying next provider...`
        );
        continue; // Try next provider
      }

      // For non-rate-limit errors, still try next provider
      console.log(
        `[AI FALLBACK] ${provider.toUpperCase()} failed, trying next provider...`
      );
    }
  }

  // All providers failed
  console.error("[AI FALLBACK] All AI providers failed");
  return null;
};

// --- MAIN FUNCTION TO CREATE SESSION ---
const createSession = async (sessionId, io, webhookUrl = null, res = null) => {
  const existingSession = sessions.get(sessionId);
  if (existingSession && existingSession.status === "connected") {
    if (webhookUrl) existingSession.webhookUrl = webhookUrl;
    if (res && !res.headersSent)
      return res.json({ status: "connected", message: "Session active" });
    return;
  }

  const { state, saveCreds } = await usePrismaAuthState(sessionId);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["MyCS-Dashboard", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    syncFullHistory: false,
  });

  sessions.set(sessionId, { sock, qr: null, status: "connecting", webhookUrl });

  // Bind Store
  // store.bind(sock.ev);

  // Init Stores
  if (!sessionAIStore[sessionId])
    sessionAIStore[sessionId] = {
      isActive: false,
      productContext: "",
      hasFile: false,
      systemPrompt: "",
      histories: {},
    };
  if (!crmStore[sessionId]) crmStore[sessionId] = {};

  // Load Auto Replies
  loadAutoReplies(sessionId);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const currentSession = sessions.get(sessionId);

    if (qr && currentSession) {
      currentSession.qr = qr;
      currentSession.status = "scan_qr";
      io.to(sessionId).emit("qr", qr);
      if (res && !res.headersSent) res.json({ status: "scan_qr", qr });
    }
    if (connection === "open") {
      console.log(`[OPEN] ${sessionId}`);
      if (currentSession) {
        currentSession.status = "connected";
        currentSession.qr = null;
      }
      io.to(sessionId).emit("ready", { status: "connected" });
      if (res && !res.headersSent) res.json({ status: "connected" });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(
        `[CLOSE] ${sessionId} Code: ${code}, Reason:`,
        lastDisconnect?.error
      );
      if (code !== DisconnectReason.loggedOut)
        createSession(sessionId, io, webhookUrl);
      else sessions.delete(sessionId);
    }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) {
        globalContactStore[jidNormalizedUser(c.id)] = c.name || c.notify;
      }
      // Map LID to Phone if available
      if (c.id && c.lid) {
        if (c.id.endsWith("@s.whatsapp.net")) {
          lidToPhoneMap[c.lid] = c.id;
        }
      }

      // Sync to Database (Chat Table)
      if (c.id.endsWith("@s.whatsapp.net")) {
        try {
          const name = c.name || c.notify || c.verifiedName;
          // Gunakan upsert agar data tetap update
          await prisma.chat.upsert({
            where: {
              sessionId_remoteJid: {
                sessionId,
                remoteJid: c.id,
              },
            },
            update: {
              name: name || undefined, // Hanya update nama jika ada
            },
            create: {
              sessionId,
              remoteJid: c.id,
              name: name || "Unknown",
            },
          });
        } catch (e) {
          // Ignore duplicate errors silently
        }
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === "status@broadcast") return;
    if (processedMessages.has(msg.key.id)) return;
    processedMessages.add(msg.key.id);

    const key = msg.key;
    const isFromMe = key.fromMe;
    const isGroup = key.remoteJid.endsWith("@g.us");
    const stats = getSessionStats(sessionId);

    if (isFromMe) stats.outgoing++;
    else {
      stats.incoming++;
      stats.logs.unshift({
        time: new Date(),
        type: "IN",
        msg: "Pesan Masuk",
        user: msg.pushName || "User",
      });
    }
    if (stats.logs.length > 20) stats.logs.pop();

    let chatId = jidNormalizedUser(key.remoteJid);

    const senderId = isGroup ? key.participant || key.remoteJid : chatId;
    const senderIdNormalized = jidNormalizedUser(senderId);

    let chatName = "Unknown";
    if (isGroup) {
      if (groupSubjectCache[chatId]) chatName = groupSubjectCache[chatId];
      else {
        try {
          const grp = await sock.groupMetadata(chatId);
          chatName = grp.subject;
          groupSubjectCache[chatId] = chatName;
        } catch (e) {
          chatName = "Grup WhatsApp";
        }
      }
    } else {
      chatName =
        globalContactStore[senderIdNormalized] ||
        msg.pushName ||
        formatPrettyId(senderIdNormalized);
    }

    // Get Chat Profile Picture (For Chat List / Header)
    let chatProfilePicUrl = null;
    try {
      chatProfilePicUrl = await sock.profilePictureUrl(chatId, "image");
    } catch (e) {
      chatProfilePicUrl = null;
    }

    // --- SAVE CHAT & MESSAGE TO DB ---
    let dbMsg = null;
    try {
      // 1. Upsert Chat
      let chat = await prisma.chat.findUnique({
        where: {
          sessionId_remoteJid: {
            sessionId: sessionId,
            remoteJid: chatId,
          },
        },
      });

      if (!chat) {
        chat = await prisma.chat.create({
          data: {
            sessionId,
            remoteJid: chatId,
            name: chatName || msg.pushName || "Unknown",
            profilePicUrl: chatProfilePicUrl,
          },
        });
        stats.newCustomers++;
      } else {
        // Update profile pic if changed (optional, but good for sync)
        if (chatProfilePicUrl && chat.profilePicUrl !== chatProfilePicUrl) {
          await prisma.chat.update({
            where: { id: chat.id },
            data: { profilePicUrl: chatProfilePicUrl },
          });
        }
      }

      // 2. Create Message
      let text = "";
      if (msg.message?.conversation) text = msg.message.conversation;
      else if (msg.message?.extendedTextMessage?.text)
        text = msg.message.extendedTextMessage.text;
      else if (msg.message?.imageMessage?.caption)
        text = msg.message.imageMessage.caption;

      dbMsg = await prisma.message.create({
        data: {
          chatId: chat.id,
          keyId: key.id,
          fromMe: isFromMe,
          text: text,
          createdAt: new Date(
            (msg.messageTimestamp || Date.now() / 1000) * 1000
          ),
        },
      });
    } catch (e) {
      console.error("Error saving message to DB:", e);
    }
    // ---------------------------------

    // CRM Registration (Memory Cache Only - DB is primary)
    if (!crmStore[sessionId]) crmStore[sessionId] = {};
    if (!crmStore[sessionId][chatId]) {
      // Try to fetch from DB first to populate cache
      try {
        const chat = await prisma.chat.findUnique({
          where: { sessionId_remoteJid: { sessionId, remoteJid: chatId } },
        });
        if (chat) {
          crmStore[sessionId][chatId] = {
            label: chat.label || "General",
            note: chat.note || "",
          };
        } else {
          crmStore[sessionId][chatId] = { label: "General", note: "" };
        }
      } catch (e) {
        crmStore[sessionId][chatId] = { label: "General", note: "" };
      }
    }

    let senderDisplayName =
      globalContactStore[senderIdNormalized] ||
      msg.pushName ||
      formatPrettyId(senderIdNormalized);

    // Get Chat Profile Picture (For Chat List / Header) - Moved up

    // Get Sender Profile Picture (For Message Bubble)
    let senderProfilePicUrl = null;
    if (isGroup) {
      try {
        senderProfilePicUrl = await sock.profilePictureUrl(
          senderIdNormalized,
          "image"
        );
      } catch (e) {
        senderProfilePicUrl = null;
      }
    } else {
      // If DM, sender pic is same as chat pic (unless it's from me)
      if (isFromMe) {
        try {
          senderProfilePicUrl = await sock.profilePictureUrl(
            jidNormalizedUser(sock.user.id),
            "image"
          );
        } catch (e) {}
      } else {
        senderProfilePicUrl = chatProfilePicUrl;
      }
    }

    // Media Handling
    let msgType = getContentType(msg.message);
    let text = "";
    let mediaUrl = null;
    let mediaType = null;

    if (["imageMessage", "videoMessage", "documentMessage"].includes(msgType)) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger }
        );
        const ext =
          msgType === "imageMessage"
            ? "jpg"
            : msgType === "videoMessage"
            ? "mp4"
            : "doc";
        const fileName = `${msg.key.id}.${ext}`;
        fs.writeFileSync(path.join(mediaPath, fileName), buffer);
        mediaUrl = `/media/${fileName}`;
        mediaType = msgType.replace("Message", "");
        text = msg.message[msgType].caption || "";
        stats.mediaCount++;
      } catch (e) {}
    } else if (msgType === "conversation") text = msg.message.conversation;
    else if (msgType === "extendedTextMessage")
      text = msg.message.extendedTextMessage.text;

    const payload = {
      id: dbMsg ? dbMsg.id : key.id,
      keyId: key.id,
      from: chatId,
      participant: senderId,
      chatName,
      senderName: senderDisplayName,
      chatProfilePicUrl: chatProfilePicUrl,
      senderProfilePicUrl: senderProfilePicUrl,
      text,
      mediaUrl,
      mediaType,
      fromMe: isFromMe,
      isGroup,
      timestamp: new Date(),
    };

    io.to(sessionId).emit("message", payload);
    io.to(sessionId).emit("stats_update", stats);

    io.to(sessionId).emit("stats_update", stats);

    // --- COMPLAINT TRACKING ---
    if (!isFromMe && text) {
      complaintKeywords.forEach((regex) => {
        if (regex.test(text)) {
          stats.complaintCount = (stats.complaintCount || 0) + 1;
          const match = text.match(regex)[0].toLowerCase();
          if (!stats.topComplaints) stats.topComplaints = {};
          stats.topComplaints[match] = (stats.topComplaints[match] || 0) + 1;
          console.log(
            `[COMPLAINT] Detected: ${match} from ${senderDisplayName}`
          );
        }
      });
    }

    // --- ANTI-SPAM CHECK FOR INCOMING MESSAGES ---
    let isSpammer = false;
    let spamWarned = false;

    if (!isFromMe && !isGroup) {
      // Check if user is blacklisted
      if (isUserBlacklisted(sessionId, senderIdNormalized)) {
        console.log(
          `[ANTISPAM] Message blocked from blacklisted user: ${senderIdNormalized}`
        );
        isSpammer = true;
      } else {
        // Check spam rate
        const spamCheck = checkWAUserSpam(sessionId, senderIdNormalized);

        if (spamCheck.isSpam) {
          console.log(
            `[ANTISPAM] User ${senderIdNormalized} is spamming (${spamCheck.messageCount} msgs/min)`
          );
          // Auto-blacklist for 1 hour
          blacklistUser(
            sessionId,
            senderIdNormalized,
            "Auto-blacklisted for spam",
            60 * 60 * 1000
          );
          isSpammer = true;

          // Send warning message (only once)
          try {
            await sock.sendMessage(chatId, {
              text: "⚠️ Maaf, Anda telah terdeteksi mengirim terlalu banyak pesan. Sistem akan menonaktifkan auto-reply untuk sementara waktu (1 jam). Mohon hubungi kami kembali nanti. 🙏",
            });
          } catch (e) {
            console.error("Failed to send spam warning:", e);
          }
        } else if (spamCheck.shouldWarn) {
          // Send warning before they get blocked
          spamWarned = true;
          try {
            await sock.sendMessage(chatId, {
              text: "⚠️ Mohon untuk tidak mengirim pesan terlalu cepat ya, Kak. Sistem kami memiliki batasan untuk mencegah spam. Terima kasih 🙏",
            });
          } catch (e) {
            console.error("Failed to send spam warning:", e);
          }
        }
      }
    }

    // --- AUTO REPLY LOGIC (QUICK REPLY) ---
    let autoReplied = false;
    if (!isFromMe && !isSpammer && text) {
      // Sort replies by keyword length descending (Longest first to avoid partial matches on shorter words)
      const replies = (autoReplyStore[sessionId] || []).sort(
        (a, b) => b.keyword.length - a.keyword.length
      );

      const match = replies.find((r) => {
        const key = r.keyword.toLowerCase();
        const msg = text.toLowerCase();
        // LOOSE MATCH: Check if message contains keyword
        return msg.includes(key);
      });

      if (match) {
        // Check auto-reply throttle
        const spamCheck = checkWAUserSpam(sessionId, senderIdNormalized);
        if (spamCheck.canAutoReply) {
          await sock.sendPresenceUpdate("composing", chatId);
          setTimeout(async () => {
            await sock.sendMessage(chatId, { text: match.response });
            markAutoReplySent(sessionId, senderIdNormalized);
            // Log Auto Reply
            stats.logs.unshift({
              time: new Date(),
              type: "AUTO",
              msg: `Auto Reply: ${match.keyword}`,
              user: "Bot",
            });
            io.to(sessionId).emit("stats_update", stats);
          }, 1000);
          autoReplied = true;
        }
      }
    }

    // AI Reply
    const aiSession = sessionAIStore[sessionId];

    if (
      !autoReplied && // Only AI if not auto replied
      !isSpammer && // Skip if user is spamming
      !spamWarned && // Skip if we just warned the user
      aiSession?.isActive &&
      !isFromMe &&
      text &&
      !isGroup &&
      !mediaUrl &&
      !text.startsWith("[")
    ) {
      // Check auto-reply throttle for AI too
      const spamCheck = checkWAUserSpam(sessionId, senderIdNormalized);
      if (!spamCheck.canAutoReply) {
        console.log(`[ANTISPAM] Throttling AI reply for ${senderIdNormalized}`);
      } else {
        await sock.sendPresenceUpdate("composing", chatId);
        const aiReply = await generateAIResponse(
          sessionId,
          senderIdNormalized,
          text,
          senderDisplayName
        );
        if (aiReply) {
          markAutoReplySent(sessionId, senderIdNormalized);
          setTimeout(async () => {
            // Check for [IMAGE: url] tag
            const imgMatch = aiReply.match(/\[IMAGE:\s*(.*?)\]/);

            if (imgMatch) {
              let imageUrl = imgMatch[1].trim();
              const caption = aiReply.replace(imgMatch[0], "").trim();

              // FIX: Convert Google Drive View Links to Direct Links
              if (imageUrl.includes("drive.google.com")) {
                const idMatch = imageUrl.match(/\/d\/(.*?)\/|id=(.*?)(&|$)/);
                if (idMatch) {
                  const fileId = idMatch[1] || idMatch[2];
                  imageUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
                }
              }

              try {
                await sock.sendMessage(chatId, {
                  image: { url: imageUrl },
                  caption: caption,
                });
              } catch (err) {
                console.error("Failed to send image:", err);
                // Fallback to text only if image fails
                await sock.sendMessage(chatId, {
                  text: caption + `\n(Gagal memuat gambar: ${imageUrl})`,
                });
              }
            } else {
              await sock.sendMessage(chatId, { text: aiReply });
            }

            stats.aiCount++;
            stats.logs.unshift({
              time: new Date(),
              type: "AI",
              msg: "Auto Reply",
              user: "Bot AI",
            });
            io.to(sessionId).emit("stats_update", stats);
          }, 2000);
        }
      }
    }

    const currentSession = sessions.get(sessionId);
    if (currentSession?.webhookUrl && !isFromMe)
      sendWebhook(currentSession.webhookUrl, {
        ...payload,
        sessionId,
        event: "message",
      });
  });
};

const initActiveSessions = async (io) => {
  try {
    const activeSessions = await prisma.session.findMany({
      where: { id: "creds" },
      select: { sessionId: true },
    });
    for (const s of activeSessions) {
      createSession(s.sessionId, io);
    }
  } catch (e) {
    console.log("No active sessions or DB error");
  }
};

module.exports = {
  sessions,
  sessionAIStore,
  productStore,
  crmStore,
  analyticsStore,
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
  aiProviderStatus, // AI Fallback status tracking
  getPreferredProvider, // Get current preferred provider
  setPreferredProvider, // Set preferred provider manually
  AI_PROVIDERS, // List of all available providers
};
